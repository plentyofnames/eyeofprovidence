// Host side of Rotary Club's protocol v1 over a transport ({send(bytes), onmessage, close()}).
// After Lilypad's device.js: one request at a time, as the firmware wants; TEXT, TEXT_CLEAR and
// EDIT have no reply and go out after the request in flight. A BCR32 that is busy (a flash read
// pending) answers 7F cmd 03: the request is tried again shortly after.

import { CMD, SPACE, MAX_CHUNK, WRITE_STATUS_TEXT, host, decodeReply, describeReply, describeCommand, ProtocolError } from './proto.js';
import { SIZE } from './model.js';

const BUSY = 3;

export class TimeoutError extends Error {
  name = 'TimeoutError';
}
export class AbortError extends Error {
  name = 'AbortError';
  constructor() {
    super('request aborted');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    if (bytes[0] !== 0xF0) return; // the knobs' and keys' own MIDI
    const r = decodeReply(bytes);
    if (!r) return this.log('rx', bytes, 'other SysEx (ignored)');
    if (r.type === 'event') return; // M0's raw events: not ours to show
    this.log('rx', bytes, describeReply(r));
    const p = this.pending;
    if (r.type === 'error' && p && r.cmd === p.cmd) {
      this._settle(Object.assign(new ProtocolError(r.cmd, r.code), { busy: r.code === BUSY }), null, r.code === BUSY);
    } else if (p && p.match(r)) {
      if ((r.type === 'read' || r.type === 'identify') && !r.ok) this._settle(new Error(`checksum mismatch in ${r.type.toUpperCase()} reply`), null, true);
      else this._settle(null, r);
    } else if (r.type === 'error') {
      this._emit('deviceerror', r);
    }
    if (r.type === 'state') this._emit('state', { mode: r.mode, page: r.page, solicited: !!p && p.match(r) });
    if (r.type === 'touch') this._emit('touch', r);
    if (r.type === 'tracks') this._emit('tracks', r);
  }

  _settle(err, value, retryable = false) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    if (err) p.reject(Object.assign(err, { retryable }));
    else p.resolve(value);
  }

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

  // Sends `bytes` and resolves with the first reply for which match(reply) is true. Timeouts and
  // corrupted replies are tried again up to `retries` times, a busy BCR32 up to `busyTries`.
  request(cmd, bytes, match, { timeout = 1000, retries = 1, busyTries = 20 } = {}) {
    const run = async () => {
      this.aborted = false;
      for (let attempt = 0, busy = 0; ;) {
        try {
          return await this._once(cmd, bytes, match, timeout);
        } catch (e) {
          if (this.closed) throw e;
          if (this.aborted) throw new AbortError();
          if (e.busy) {
            if (++busy > busyTries) throw e;
            await sleep(20);
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

  // A message without a reply, after the request in flight.
  post(bytes) {
    const run = () => {
      if (this.closed) throw new Error('device closed');
      this.log('tx', bytes, describeCommand(bytes));
      this.transport.send(bytes);
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async identify({ timeout = 800, retries = 1 } = {}) {
    const r = await this.request(CMD.IDENTIFY, host.identify(), (r) => r.type === 'identify', { timeout, retries });
    this.info = r;
    return r;
  }

  async read(addr, len, space = SPACE.CONTROLLER) {
    if (len < 1 || len > MAX_CHUNK) throw new RangeError(`READ length must be 1-${MAX_CHUNK}`);
    const r = await this.request(CMD.READ, host.read(space, addr, len),
      (r) => r.type === 'read' && r.space === space && r.addr === addr && r.len === len, { retries: 2 });
    return r.data;
  }

  // The whole controller space, in READs of up to 256 bytes.
  async readAll(onStep = () => {}, chunk = MAX_CHUNK) {
    const img = new Uint8Array(SIZE);
    for (let a = 0, k = 0; a < SIZE; a += chunk, k++) {
      img.set(await this.read(a, Math.min(chunk, SIZE - a)), a);
      onStep(k + 1, Math.ceil(SIZE / chunk));
    }
    return img;
  }

  async write(addr, data) {
    if (data.length < 1 || data.length > MAX_CHUNK) throw new RangeError(`WRITE length must be 1-${MAX_CHUNK}`);
    if (addr < 0 || addr + data.length > SIZE) throw new RangeError('WRITE past the controller space');
    const r = await this.request(CMD.WRITE, host.write(addr, data),
      (r) => r.type === 'write' && r.space === SPACE.CONTROLLER && r.addr === addr, { retries: 2 });
    if (r.status !== 0) throw new Error(`write at 0x${addr.toString(16)} failed: ${WRITE_STATUS_TEXT[r.status] ?? 'status ' + r.status}`);
    return r.status;
  }

  stateRequest(cmd, bytes, timeout = 1500) {
    return this.request(cmd, bytes, (r) => r.type === 'state', { timeout, retries: 1 });
  }
  getState() {
    return this.stateRequest(CMD.GET_STATE, host.getState());
  }
  select(page) {
    return this.stateRequest(CMD.SELECT, host.select(page));
  }
  // RELOAD also writes the image to the store (SPI flash): give it time.
  reload() {
    return this.stateRequest(CMD.RELOAD, host.reload(), 5000);
  }
  touchEvents(on) {
    return this.stateRequest(CMD.TOUCH_EVENTS, host.touchEvents(on));
  }

  text(kind, first, texts) {
    return this.post(host.text(kind, first, texts));
  }
  textClear() {
    return this.post(host.textClear());
  }
  // A cell of the page in view, in RAM only.
  edit(page, cell, record) {
    return this.post(host.edit(page, cell, record));
  }

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
