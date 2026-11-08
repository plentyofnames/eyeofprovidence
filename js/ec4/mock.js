// A mock EC4 running protocol v1 on a 64 KB EEPROM image, with the link timing of the real
// unit (31250 baud each way, EEPROM page writes ~5 ms). It is the demo and test target.
// Like the controlfrog firmware it handles one request at a time and drops requests
// that arrive before the previous reply is out; during DUMP_ALL it is silent: requests are
// ignored and no events are sent.

import { CMD, PAGE, device as reply, decodeCommand, wireMs } from './proto.js';
import { serializeContainer, defaultHeader } from './syx.js';

const I2C_PAGE_MS = 1.7; // 64 bytes at 400 kHz
const WRITE_CYCLE_MS = 5;

export class MockDevice {
  // speed 'real' = link timing (scaled by timeScale, for tests), 'fast' = no delays.
  constructor(image, { fw = [0, 4], speed = 'real', timeScale = 1 } = {}) {
    this.eeprom = Uint8Array.from(image);
    this.live = Uint8Array.from(image); // settings in RAM; changes only on RELOAD
    this.fw = fw;
    this.speed = speed; // 'real' | 'fast'
    this.timeScale = timeScale;
    this.setup = Math.min(this.eeprom[0], 15);
    this.group = this.eeprom[0x10 + this.setup] & 15;
    this.touchOn = false;
    this.handling = false; // a request is being handled, until its reply is sent
    this.dumping = false;
    this.lastTouch = new Map();
    this.faults = { writeStatus: 0, busError: false, dropReplies: 0, badChecksum: false };
    this.stats = { reads: 0, writes: 0, bytesWritten: 0, dropped: 0, log: [] };
    this.rxFree = 0; // host -> device wire busy until (ms)
    this.txFree = 0; // device -> host wire busy until (ms)
    this.listeners = new Set();
    this.port = null;
  }

  onUpdate(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  _updated(what) {
    for (const fn of this.listeners) fn(what);
  }

  // The host's view: a MIDI-port-like transport.
  transport() {
    const self = this;
    const port = {
      name: 'Demo EC4',
      onmessage: null,
      send(bytes) {
        self._receive(Uint8Array.from(bytes));
      },
      close() {
        if (self.port === port) self.port = null;
        self.touchOn = false;
      },
    };
    this.port = port;
    return port;
  }

  _now() {
    return performance.now();
  }

  _at(t, fn) {
    if (this.speed === 'fast') return setTimeout(fn, 0);
    setTimeout(fn, Math.max(0, t - this._now()));
  }

  _receive(bytes) {
    const now = this._now();
    const arrive = this.speed === 'fast' ? now : Math.max(now, this.rxFree) + wireMs(bytes.length) * this.timeScale;
    this.rxFree = arrive;
    this._at(arrive, () => this._handle(bytes));
  }

  _transmit(bytes, extraMs, after) {
    const now = this._now();
    const start = Math.max(now + extraMs * this.timeScale, this.txFree);
    const done = this.speed === 'fast' ? now : start + wireMs(bytes.length) * this.timeScale;
    this.txFree = done;
    const port = this.port;
    this._at(done, () => {
      port.onmessage?.(bytes);
      after?.();
    });
  }

  // The reply to the request being handled; the next request is accepted once it is out.
  _reply(bytes, extraMs = 0) {
    const finish = () => {
      this.handling = false;
      if (this.dumping) {
        this.dumping = false;
        this._updated('dump');
      }
    };
    if (!this.port) return finish();
    if (this.faults.dropReplies > 0) {
      this.faults.dropReplies--;
      this._updated('faults');
      return this._at(this._now() + extraMs * this.timeScale, finish);
    }
    this._transmit(bytes, extraMs, finish);
  }

  // Unsolicited STATE/TOUCH messages: none while a dump is on the wire.
  _event(bytes) {
    if (this.dumping || !this.port) return;
    this._transmit(bytes, 0);
  }

  _handle(bytes) {
    const c = decodeCommand(bytes);
    if (!c) return; // not ours (other SysEx, or garbage)
    if (this.handling) {
      this.stats.dropped++; // previous request still being handled, or a dump running
      this._updated('dropped');
      return;
    }
    this.handling = true;
    const err = (code) => this._reply(reply.error(c.cmd, code));
    if (c.error) return err(c.error);
    switch (c.cmd) {
      case CMD.IDENTIFY:
        return this._reply(reply.identify(1, this.fw[0], this.fw[1], 64, 64));
      case CMD.READ: {
        if (c.len < 1 || c.len > 64 || c.addr + c.len > this.eeprom.length) return err(1);
        if (this.faults.busError) return err(3);
        this.stats.reads++;
        const data = this.eeprom.slice(c.addr, c.addr + c.len);
        const msg = reply.readReply(c.addr, data);
        if (this.faults.badChecksum) {
          msg[msg.length - 2] ^= 1;
          this.faults.badChecksum = false;
          this._updated('faults');
        }
        return this._reply(msg, I2C_PAGE_MS);
      }
      case CMD.WRITE: {
        if (c.addr + c.len > this.eeprom.length || (c.addr % PAGE) + c.len > PAGE) return err(1);
        if (this.faults.busError) return err(3);
        const status = this.faults.writeStatus;
        if (status === 0) this.eeprom.set(c.data, c.addr);
        this.stats.writes++;
        this.stats.bytesWritten += c.len;
        this.stats.log.push({ addr: c.addr, data: Array.from(c.data), status });
        this._updated('eeprom');
        return this._reply(reply.writeReply(c.addr, status), WRITE_CYCLE_MS + 2 * I2C_PAGE_MS);
      }
      case CMD.RELOAD:
        this.live = Uint8Array.from(this.eeprom);
        this._updated('live');
        return this._reply(reply.state(this.setup, this.group), 30);
      case CMD.GET_STATE:
        return this._reply(reply.state(this.setup, this.group));
      case CMD.SELECT:
        if (c.setup > 15 || c.group > 15) return err(1);
        this.setup = c.setup;
        this.group = c.group;
        this._updated('state');
        return this._reply(reply.state(this.setup, this.group));
      case CMD.TOUCH_EVENTS:
        this.touchOn = c.on;
        this._updated('touch');
        return this._reply(reply.state(this.setup, this.group));
      case CMD.DUMP_ALL: {
        const pages = [];
        for (let a = 0; a < this.eeprom.length; a += 64) pages.push({ addr: a, data: this.eeprom.subarray(a, a + 64) });
        const msg = serializeContainer({ header: defaultHeader(), pages, padding: 0 });
        this.dumping = true;
        this._updated('dump');
        return this._reply(msg);
      }
      default:
        return err(5);
    }
  }

  // ---- the "hardware": what the user does on the unit

  setState(setup, group) {
    this.setup = Math.max(0, Math.min(15, setup));
    this.group = Math.max(0, Math.min(15, group));
    this._updated('state');
    this._event(reply.state(this.setup, this.group));
  }

  // At most one TOUCH event per control per 250 ms, as on the unit.
  touch(kind, index) {
    if (!this.touchOn || this.dumping) return;
    const key = kind * 16 + index;
    const now = this._now();
    if (now - (this.lastTouch.get(key) ?? -Infinity) < 250) return;
    this.lastTouch.set(key, now);
    this._event(reply.touch(kind, index, this.setup, this.group));
  }
}

// Factory-like globals for a mock built from a stock "all setups" file (which has none).
export function imageFromSetupsOnly(img) {
  const out = Uint8Array.from(img);
  out.fill(0xFF, 0, 0x0B00);
  out.set([0, 6, 2, 0x80, 0, 100, 0], 0);
  out.fill(0, 0x10, 0x20);
  return out;
}
