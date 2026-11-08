// Host side of protocol v1 over a transport ({send(bytes), onmessage, close()}).
// One request at a time, as the firmware requires (it drops a request that arrives while
// the previous one is being handled). During a DUMP_ALL the device ignores requests and
// sends nothing, so a timeout means "busy": requests are retried for up to BUSY_MS.

import { CMD, host, decodeReply, describeReply, describeCommand, ProtocolError, MAX_CHUNK, PAGE } from './proto.js';

export const BUSY_MS = 75_000; // a DUMP_ALL keeps the device silent for ~67 s

export class TimeoutError extends Error {
  name = 'TimeoutError';
}
export class AbortError extends Error {
  name = 'AbortError';
  constructor() {
    super('request aborted');
  }
}

export class Device extends EventTarget {
  constructor(transport, { log } = {}) {
    super();
    this.transport = transport;
    this.log = log || (() => {});
    this.pending = null;
    this.chain = Promise.resolve();
    this.info = null;
    this.closed = false;
    transport.onmessage = (bytes) => this._onMessage(bytes);
  }

  get name() {
    return this.transport.name;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _onMessage(bytes) {
    if (bytes[0] !== 0xF0) return; // ordinary MIDI from the controls
    if (bytes[1] === 0x00 && bytes[2] === 0x00 && bytes[3] === 0x00) {
      this.log('rx', bytes, 'Faderfox container');
      if (this.pending && this.pending.cmd === CMD.DUMP_ALL) this._settle(null, bytes);
      return;
    }
    const r = decodeReply(bytes);
    if (!r) return this.log('rx', bytes, 'other SysEx (ignored)');
    this.log('rx', bytes, describeReply(r));
    const p = this.pending;
    if (r.type === 'error' && p && r.cmd === p.cmd) {
      this._settle(new ProtocolError(r.cmd, r.code));
    } else if (p && p.match(r)) {
      if (r.type === 'read' && !r.ok) this._settle(new Error('checksum mismatch in READ reply'), null, true);
      else this._settle(null, r);
    } else if (r.type === 'error') {
      this._emit('deviceerror', r);
    }
    if (r.type === 'state') this._emit('state', { setup: r.setup, group: r.group, solicited: !!p && p.match(r) });
    if (r.type === 'touch') this._emit('touch', r);
  }

  _settle(err, value, retryable = false) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    if (err) p.reject(Object.assign(err, { retryable }));
    else p.resolve(value);
  }

  // Sends `bytes` and resolves with the first reply for which match(reply) is true.
  _once(cmd, bytes, match, timeout) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('device closed'));
      this.pending = { cmd, match, resolve, reject };
      this.pending.timer = setTimeout(() => this._settle(new TimeoutError(`no reply to command 0x${cmd.toString(16).padStart(2, '0')}`), null, true), timeout);
      this.log('tx', bytes, describeCommand(bytes));
      try {
        this.transport.send(bytes);
      } catch (e) {
        this._settle(e);
      }
    });
  }

  // Timeouts are retried until busyMs has passed (emitting 'waiting'); other retryable
  // errors (a corrupted reply) up to `retries` times.
  request(cmd, bytes, match, { timeout = 1000, retries = 0, busyMs = BUSY_MS } = {}) {
    const run = async () => {
      const t0 = performance.now();
      this.aborted = false;
      let waited = false;
      const stopWaiting = () => waited && this._emit('waiting', { cmd, done: true });
      for (let attempt = 0; ; ) {
        try {
          const r = await this._once(cmd, bytes, match, timeout);
          stopWaiting();
          return r;
        } catch (e) {
          if (this.closed || this.aborted) {
            stopWaiting();
            throw this.closed ? e : new AbortError();
          }
          if (e instanceof TimeoutError) {
            const elapsed = performance.now() - t0;
            if (elapsed + timeout > busyMs) {
              stopWaiting();
              throw e;
            }
            waited = true;
            this._emit('waiting', { cmd, elapsedMs: elapsed });
            this.log('note', null, `no reply after ${(elapsed / 1000).toFixed(1)} s, device busy? retrying`);
            continue;
          }
          if (!e.retryable || ++attempt > retries) throw e;
          this.log('note', null, `retrying (${e.message})`);
        }
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  // busyMs: how long to keep trying when there's no reply (a dump, or no controlfrog at all).
  async identify({ busyMs = BUSY_MS } = {}) {
    const r = await this.request(CMD.IDENTIFY, host.identify(), (r) => r.type === 'identify', { timeout: 800, retries: 1, busyMs });
    this.info = r;
    return r;
  }

  async read(addr, len) {
    if (len < 1 || len > MAX_CHUNK) throw new RangeError('READ length must be 1-64');
    const r = await this.request(CMD.READ, host.read(addr, len), (r) => r.type === 'read' && r.addr === addr && r.len === len, { retries: 2 });
    return r.data;
  }

  async write(addr, data) {
    if (data.length < 1 || data.length > MAX_CHUNK) throw new RangeError('WRITE length must be 1-64');
    if ((addr % PAGE) + data.length > PAGE) throw new RangeError('WRITE must not cross a 64-byte page');
    const r = await this.request(CMD.WRITE, host.write(addr, data), (r) => r.type === 'write' && r.addr === addr, { retries: 2 });
    if (r.status !== 0) throw new Error(`write at 0x${addr.toString(16)} failed (status ${r.status})`);
    return r.status;
  }

  stateRequest(cmd, bytes) {
    return this.request(cmd, bytes, (r) => r.type === 'state', { timeout: 1500, retries: 1 });
  }
  getState() {
    return this.stateRequest(CMD.GET_STATE, host.getState());
  }
  select(setup, group) {
    return this.stateRequest(CMD.SELECT, host.select(setup, group));
  }
  reload() {
    return this.stateRequest(CMD.RELOAD, host.reload());
  }
  touchEvents(on) {
    return this.stateRequest(CMD.TOUCH_EVENTS, host.touchEvents(on));
  }

  // The whole EEPROM in the Faderfox container, ~67 s on the real link.
  dumpAll() {
    return this.request(CMD.DUMP_ALL, host.dumpAll(), () => false, { timeout: 120_000, busyMs: 0 });
  }

  // Gives up on the current request (and its retries).
  abort() {
    this.aborted = true;
    this._settle(new AbortError());
  }

  close() {
    this.closed = true;
    this._settle(new Error('device closed'));
    this.transport.close?.();
  }
}
