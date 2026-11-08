// A mock BCR32 running Rotary Club's controller protocol (docs/controller-protocol.md) on an
// in-memory 4 KB image: the demo and test target, after Lilypad's mock.js. WRITE changes the
// image in RAM; RELOAD makes the controller use it and keeps it (the "store"). One request at a
// time: a request that arrives while one is being handled is answered 7F cmd 03 (busy).

import { CMD, SPACE, MAX_CHUNK, WRITE_STATUS, device as reply, decodeCommand } from './proto.js';
import * as M from './model.js';

const MODE = { SEQUENCER: 0, CONTROLLER: 1 };

export class MockBcr32 {
  // speed 'usb' = a few ms per message (scaled by timeScale), 'fast' = no delays.
  constructor(image = M.blankImage(), { fw = [0, 23], speed = 'usb', timeScale = 1 } = {}) {
    this.store = Uint8Array.from(image); // what survives a power-off
    this.ram = Uint8Array.from(image); // what READ and WRITE see
    this.live = Uint8Array.from(image); // what the controller plays (RELOAD)
    this.fw = fw;
    this.speed = speed;
    this.timeScale = timeScale;
    this.mode = MODE.CONTROLLER;
    this.page = 0;
    this.touchOn = false;
    this.handling = false;
    this.edits = new Map(); // cell -> record, for the page in view (EDIT)
    this.texts = [new Map(), new Map()]; // labels, value texts: cell -> 4 characters
    this.lastTouch = new Map();
    this.syncOff = false; // any controller command switches the FH-2 sync off until USB goes down
    this.faults = { writeStatus: 0, dropReplies: 0, badChecksum: false };
    this.stats = { reads: 0, writes: 0, bytesWritten: 0, reloads: 0, edits: 0, busy: 0, log: [] };
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

  transport() {
    const self = this;
    const port = {
      name: 'Demo BCR32',
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

  _delay(ms, fn) {
    setTimeout(fn, this.speed === 'fast' ? 0 : ms * this.timeScale);
  }

  _receive(bytes) {
    this._delay(1, () => this._handle(bytes));
  }

  _send(bytes, ms = 1, after) {
    const port = this.port;
    this._delay(ms, () => {
      port?.onmessage?.(bytes);
      after?.();
    });
  }

  _reply(bytes, ms = 1) {
    const finish = () => {
      this.handling = false;
    };
    if (!this.port) return finish();
    if (this.faults.dropReplies > 0) {
      this.faults.dropReplies--;
      this._updated('faults');
      return this._delay(ms, finish);
    }
    this._send(bytes, ms, finish);
  }

  _event(bytes) {
    if (this.port) this._send(bytes, 1);
  }

  _state() {
    return reply.state(this.mode, this.page);
  }

  // A page loads: its RAM edits and texts are dropped.
  _pageLoaded() {
    this.edits.clear();
    this.texts[0].clear();
    this.texts[1].clear();
  }

  _handle(bytes) {
    const c = decodeCommand(bytes);
    if (!c) return; // not ours
    const noReply = c.cmd === CMD.TEXT || c.cmd === CMD.TEXT_CLEAR || c.cmd === CMD.EDIT;
    if (this.handling && !noReply) {
      this.stats.busy++;
      this._event(reply.error(c.cmd, 3));
      return;
    }
    const err = (code) => (noReply ? this._event(reply.error(c.cmd, code)) : this._reply(reply.error(c.cmd, code)));
    if (!noReply) this.handling = true;
    if (c.error) return err(c.error);
    if (c.cmd !== CMD.IDENTIFY && !(c.cmd === CMD.READ && c.space !== SPACE.CONTROLLER)) this.syncOff = true;
    switch (c.cmd) {
      case CMD.IDENTIFY: {
        const info = Uint8Array.from([0x52, 0x43, ...new Array(48).fill(0)]); // "RC", then M0's fields
        return this._reply(reply.identify(1, this.fw[0], this.fw[1], info));
      }
      case CMD.READ: {
        if (c.len < 1 || c.len > MAX_CHUNK) return err(1);
        let data;
        if (c.space === SPACE.CONTROLLER) {
          if (c.addr + c.len > M.SIZE) return err(2);
          data = this.ram.slice(c.addr, c.addr + c.len);
        } else if (c.space === SPACE.INTERNAL || c.space === SPACE.FLASH) {
          data = new Uint8Array(c.len).fill(c.space === SPACE.FLASH ? 0xFF : 0);
        } else return err(2);
        this.stats.reads++;
        const msg = reply.readReply(c.space, c.addr, data);
        if (this.faults.badChecksum) {
          msg[msg.length - 2] ^= 1;
          this.faults.badChecksum = false;
          this._updated('faults');
        }
        return this._reply(msg, 2);
      }
      case CMD.WRITE: {
        let status = c.status ?? WRITE_STATUS.OK;
        if (!status && (c.space !== SPACE.CONTROLLER || c.addr + c.len > M.SIZE)) status = WRITE_STATUS.RANGE;
        if (!status && this.faults.writeStatus) status = this.faults.writeStatus;
        if (!status) {
          this.ram.set(c.data, c.addr);
          this.stats.writes++;
          this.stats.bytesWritten += c.len;
        }
        this.stats.log.push({ addr: c.addr, data: c.data ? Array.from(c.data) : [], status });
        this._updated('ram');
        return this._reply(reply.writeReply(c.space ?? 0, c.addr ?? 0, status), 2);
      }
      case CMD.GET_STATE:
        return this._reply(this._state());
      case CMD.SELECT:
        if (c.page > 3) return err(2);
        this.page = c.page;
        this._pageLoaded();
        this._updated('state');
        return this._reply(this._state());
      case CMD.RELOAD:
        this.live = Uint8Array.from(this.ram);
        this.store = Uint8Array.from(this.ram);
        this.stats.reloads++;
        this._pageLoaded();
        this._updated('store');
        return this._reply(this._state(), 20);
      case CMD.TOUCH_EVENTS:
        this.touchOn = c.on;
        this._updated('touch');
        return this._reply(this._state());
      case CMD.TEXT: {
        if (c.kind > 1 || c.first + c.count > M.CELLS) return err(1);
        c.texts.forEach((t, k) => (t == null ? this.texts[c.kind].delete(c.first + k) : this.texts[c.kind].set(c.first + k, t)));
        this._updated('texts');
        return;
      }
      case CMD.TEXT_CLEAR:
        this.texts[0].clear();
        this.texts[1].clear();
        this._updated('texts');
        return;
      case CMD.EDIT:
        if (c.page > 3 || c.cell >= M.CELLS) return err(1);
        if (c.page !== this.page) return err(1); // only the page in view (as the firmware answers)
        this.edits.set(c.cell, c.record);
        this.stats.edits++;
        this._updated('edits');
        return;
      default:
        return err(5);
    }
  }

  // ---- what the controller plays: the live image with the RAM edits of the page in view

  record(c, page = this.page) {
    if (page === this.page && this.edits.has(c)) return this.edits.get(c);
    return M.readRecord(this.live, page, c);
  }
  label(c) {
    return this.texts[0].get(c) ?? M.readName(this.record(c), 8);
  }

  // ---- the "hardware": what the user does on the unit

  setPage(page) {
    this.page = Math.max(0, Math.min(3, page));
    this._pageLoaded();
    this._updated('state');
    this._event(this._state());
  }

  setMode(mode) {
    this.mode = mode ? MODE.CONTROLLER : MODE.SEQUENCER;
    this._updated('state');
    this._event(this._state());
  }

  // kind 0 knob turned, 1 knob pushed, 2 key pressed. At most one per control per 250 ms.
  touch(kind, index, now = performance.now()) {
    if (!this.touchOn) return false;
    const key = kind * 64 + index;
    if (now - (this.lastTouch.get(key) ?? -Infinity) < 250) return false;
    this.lastTouch.set(key, now);
    this._event(reply.touch(kind, index, this.page));
    return true;
  }

  powerCycle() {
    this.ram = Uint8Array.from(this.store);
    this.live = Uint8Array.from(this.store);
    this.syncOff = false;
    this.touchOn = false;
    this._pageLoaded();
    this._updated('store');
  }
}
