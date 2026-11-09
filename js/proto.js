// Rotary Club's SysEx protocol v1 (docs/controller-protocol.md): framing, 8-to-7 packing,
// message codecs. Shared by the host client (device.js) and the mock BCR32 (mock.js).
// Derived from Lilypad's proto.js: the header is "BCR", addresses are 5 bytes and carry a
// space byte, chunks are up to 256 bytes.

export const HEADER = [0xF0, 0x7D, 0x42, 0x43, 0x52]; // SysEx start, non-commercial ID, "BCR"

export const CMD = {
  IDENTIFY: 0x02,
  IDENTIFY_REPLY: 0x03,
  READ: 0x10,
  READ_REPLY: 0x11,
  WRITE: 0x12,
  WRITE_REPLY: 0x13,
  GET_STATE: 0x20,
  STATE: 0x21,
  SELECT: 0x22,
  RELOAD: 0x24,
  TOUCH_EVENTS: 0x26,
  TEXT: 0x28,
  TEXT_CLEAR: 0x2A,
  EDIT: 0x2C,
  EVENT: 0x31, // M0's raw key and knob events: ignored
  TOUCH: 0x33,
  TRACKS: 0x35, // the tracks (space 3) changed: 35 counter (firmware 0.29 on)
  ERROR: 0x7F,
};

// rcproto.h's codes; the controller rows of the spec use 1 (length or range) and 2 (checksum).
export const ERR = {
  1: 'bad length or format',
  2: 'bad range or checksum',
  3: 'busy',
  4: 'the image could not be stored', // RELOAD: in use until power-off, but not kept
  5: 'unknown command',
  6: 'not the page in view', // EDIT, 0.27 on
};
export const ERR_STORE = 4;

export const SPACE = { INTERNAL: 0, FLASH: 1, CONTROLLER: 2, TRACKS: 3 };
export const TRACKS_LEN = 272; // space 3: a 16-byte head, 16 bytes a track (docs/controller-protocol.md)

// WRITE's reply status (13 space addr status).
export const WRITE_STATUS = { OK: 0, RANGE: 1, CHECKSUM: 2 };
export const WRITE_STATUS_TEXT = { 0: 'written', 1: 'bad range or format', 2: 'bad checksum' };
export const MAX_CHUNK = 256;
export const ADDR_GROUPS = 5;
export const LEN_GROUPS = 2;

export class ProtocolError extends Error {
  constructor(cmd, code) {
    super(`BCR32 error for command ${hex(cmd)}: ${ERR[code] || 'code ' + code}`);
    this.cmd = cmd;
    this.code = code;
  }
}

export function hex(v, w = 2) {
  return '0x' + v.toString(16).toUpperCase().padStart(w, '0');
}

export function hexdump(bytes, max = 48) {
  const a = Array.from(bytes.slice(0, max), (b) => b.toString(16).padStart(2, '0'));
  return a.join(' ') + (bytes.length > max ? ` … (${bytes.length} bytes)` : '');
}

// Numbers are sent in 7-bit groups, MSB first. (35-bit addresses: no 32-bit shifts.)
export function encodeNum(v, width) {
  const out = [];
  for (let i = width - 1; i >= 0; i--) out.push(Math.floor(v / 2 ** (7 * i)) & 0x7F);
  return out;
}

export function decodeNum(bytes, at, width) {
  let v = 0;
  for (let i = 0; i < width; i++) v = v * 128 + (bytes[at + i] & 0x7F);
  return v;
}

// 8-to-7 packing: each group of n <= 7 bytes is one header byte (bit i = bit 7 of byte i)
// followed by the n low-7-bit bytes.
export function pack(data) {
  const out = [];
  for (let i = 0; i < data.length; i += 7) {
    const n = Math.min(7, data.length - i);
    let head = 0;
    for (let j = 0; j < n; j++) if (data[i + j] & 0x80) head |= 1 << j;
    out.push(head);
    for (let j = 0; j < n; j++) out.push(data[i + j] & 0x7F);
  }
  return out;
}

export function packedLength(n) {
  return n + Math.ceil(n / 7);
}

// The data length a packed run of `p` bytes holds (-1 if no length packs to p).
export function unpackedLength(p) {
  const n = p - Math.ceil(p / 8);
  return packedLength(n) === p ? n : -1;
}

export function unpack(bytes, at, n) {
  const out = new Uint8Array(n);
  let p = at;
  for (let i = 0; i < n; i += 7) {
    const k = Math.min(7, n - i);
    const head = bytes[p++];
    for (let j = 0; j < k; j++) out[i + j] = (bytes[p++] & 0x7F) | (((head >> j) & 1) << 7);
  }
  return out;
}

export function checksum(data) {
  let s = 0;
  for (const b of data) s += b;
  return s & 0x7F;
}

export function frame(cmd, payload = []) {
  return Uint8Array.from([...HEADER, cmd, ...payload, 0xF7]);
}

// Returns {cmd, body} for a Rotary Club protocol message, or null for anything else.
export function unframe(msg) {
  if (msg.length < 7 || msg[0] !== 0xF0 || msg[msg.length - 1] !== 0xF7) return null;
  for (let i = 0; i < HEADER.length; i++) if (msg[i] !== HEADER[i]) return null;
  return { cmd: msg[5], body: msg.subarray(6, msg.length - 1) };
}

const addrLen = (space, addr, len) => [space & 0x7F, ...encodeNum(addr, ADDR_GROUPS), ...encodeNum(len, LEN_GROUPS)];

// Four printable characters per text; null (or undefined) removes one (four 00 bytes).
export function textChars(texts) {
  return texts.flatMap((t) => (t == null ? [0, 0, 0, 0]
    : [...String(t).padEnd(4).slice(0, 4)].map((c) => {
      const n = c.charCodeAt(0);
      return n >= 0x20 && n <= 0x7E ? n : 0x20;
    })));
}

// ---- host -> device

export const host = {
  identify: () => frame(CMD.IDENTIFY),
  read: (space, addr, len) => frame(CMD.READ, addrLen(space, addr, len)),
  write: (addr, data, space = SPACE.CONTROLLER) =>
    frame(CMD.WRITE, [...addrLen(space, addr, data.length), ...pack(data), checksum(data)]),
  getState: () => frame(CMD.GET_STATE),
  select: (page) => frame(CMD.SELECT, [page & 0x7F]),
  reload: () => frame(CMD.RELOAD),
  touchEvents: (on) => frame(CMD.TOUCH_EVENTS, [on ? 1 : 0]),
  text: (kind, first, texts) => frame(CMD.TEXT, [kind & 0x7F, first & 0x7F, texts.length & 0x7F, ...textChars(texts)]),
  textClear: () => frame(CMD.TEXT_CLEAR),
  edit: (page, cell, record) => frame(CMD.EDIT, [page & 0x7F, cell & 0x7F, ...pack(record), checksum(record)]),
};

// ---- device -> host (the mock's side)

export const device = {
  identify: (proto, fwMajor, fwMinor, info = []) =>
    frame(CMD.IDENTIFY_REPLY, [proto & 0x7F, fwMajor & 0x7F, fwMinor & 0x7F, ...pack(info), checksum(info)]),
  readReply: (space, addr, data) =>
    frame(CMD.READ_REPLY, [...addrLen(space, addr, data.length), ...pack(data), checksum(data)]),
  writeReply: (space, addr, status) => frame(CMD.WRITE_REPLY, [space & 0x7F, ...encodeNum(addr, ADDR_GROUPS), status & 0x7F]),
  state: (mode, page) => frame(CMD.STATE, [mode & 0x7F, page & 0x7F]),
  touch: (kind, index, page) => frame(CMD.TOUCH, [kind & 0x7F, index & 0x7F, page & 0x7F]),
  tracks: (counter) => frame(CMD.TRACKS, [counter & 0x7F]),
  error: (cmd, code) => frame(CMD.ERROR, [cmd & 0x7F, code & 0x7F]),
};

// Decodes a device -> host message. Returns null if it isn't one of ours.
// Malformed messages decode to {type: 'malformed', reason}.
export function decodeReply(msg) {
  const f = unframe(msg);
  if (!f) return null;
  const { cmd, body } = f;
  const bad = (reason) => ({ type: 'malformed', cmd, reason });
  switch (cmd) {
    case CMD.IDENTIFY_REPLY: {
      if (body.length < 4) return bad('short IDENTIFY reply');
      const n = unpackedLength(body.length - 4);
      const info = n > 0 ? unpack(body, 3, n) : new Uint8Array(0);
      const ok = n >= 0 && checksum(info) === body[body.length - 1];
      return { type: 'identify', proto: body[0], fwMajor: body[1], fwMinor: body[2], info, ok };
    }
    case CMD.READ_REPLY: {
      if (body.length < 8) return bad('short READ reply');
      const space = body[0];
      const addr = decodeNum(body, 1, ADDR_GROUPS);
      const len = decodeNum(body, 6, LEN_GROUPS);
      if (body.length !== 8 + packedLength(len) + 1) return bad(`READ reply length ${body.length} for ${len} bytes`);
      const data = unpack(body, 8, len);
      const ok = checksum(data) === body[body.length - 1];
      return { type: 'read', space, addr, len, data, ok };
    }
    case CMD.WRITE_REPLY:
      if (body.length < 7) return bad('short WRITE reply');
      return { type: 'write', space: body[0], addr: decodeNum(body, 1, ADDR_GROUPS), status: body[6] };
    case CMD.STATE:
      if (body.length < 2) return bad('short STATE');
      return { type: 'state', mode: body[0], page: body[1] };
    case CMD.TOUCH:
      if (body.length < 3) return bad('short TOUCH');
      return { type: 'touch', kind: body[0], index: body[1], page: body[2] };
    case CMD.TRACKS:
      if (body.length < 1) return bad('short TRACKS');
      return { type: 'tracks', counter: body[0] };
    case CMD.EVENT:
      return { type: 'event', body };
    case CMD.ERROR:
      if (body.length < 2) return bad('short ERROR');
      return { type: 'error', cmd: body[0], code: body[1] };
    default:
      return { type: 'unknown', cmd, body };
  }
}

// Decodes a host -> device message (used by the mock). Returns null if it isn't one of ours.
// `error` is the code the mock answers with.
export function decodeCommand(msg) {
  const f = unframe(msg);
  if (!f) return null;
  const { cmd, body } = f;
  const r = { cmd, body };
  switch (cmd) {
    case CMD.IDENTIFY:
    case CMD.GET_STATE:
    case CMD.RELOAD:
    case CMD.TEXT_CLEAR:
      return body.length ? { ...r, error: 1 } : r;
    case CMD.READ:
      if (body.length !== 8) return { ...r, error: 1 };
      return { ...r, space: body[0], addr: decodeNum(body, 1, ADDR_GROUPS), len: decodeNum(body, 6, LEN_GROUPS) };
    case CMD.WRITE: {
      // A wrong length is malformed (7F 12 01); range and checksum go in the 13 reply's status.
      if (body.length < 9) return { ...r, error: 1 };
      const space = body[0];
      const addr = decodeNum(body, 1, ADDR_GROUPS);
      const len = decodeNum(body, 6, LEN_GROUPS);
      if (len < 1 || len > MAX_CHUNK || body.length !== 8 + packedLength(len) + 1) return { ...r, space, addr, len, error: 1 };
      const data = unpack(body, 8, len);
      if (checksum(data) !== body[body.length - 1]) return { ...r, space, addr, len, data, status: WRITE_STATUS.CHECKSUM };
      return { ...r, space, addr, len, data };
    }
    case CMD.SELECT:
      if (body.length !== 1) return { ...r, error: 1 };
      return { ...r, page: body[0] };
    case CMD.TOUCH_EVENTS:
      if (body.length !== 1) return { ...r, error: 1 };
      return { ...r, on: body[0] !== 0 };
    case CMD.TEXT: {
      if (body.length < 3) return { ...r, error: 1 };
      const [kind, first, count] = body;
      if (body.length !== 3 + 4 * count) return { ...r, error: 1 };
      const texts = [];
      for (let k = 0; k < count; k++) {
        const c = body.subarray(3 + 4 * k, 7 + 4 * k);
        texts.push(c.every((b) => b === 0) ? null : String.fromCharCode(...Array.from(c, (b) => (b >= 0x20 && b <= 0x7E ? b : 0x20))));
      }
      return { ...r, kind, first, count, texts };
    }
    case CMD.EDIT: {
      if (body.length !== 2 + packedLength(15) + 1) return { ...r, error: 1 };
      const record = unpack(body, 2, 15);
      if (checksum(record) !== body[body.length - 1]) return { ...r, page: body[0], cell: body[1], error: 2 };
      return { ...r, page: body[0], cell: body[1], record };
    }
    default:
      return r;
  }
}

// One-line descriptions for the protocol log.
const a16 = (v) => '0x' + v.toString(16).toUpperCase().padStart(4, '0');
export function describeReply(r) {
  switch (r.type) {
    case 'identify':
      return `IDENTIFY reply: proto ${r.proto}, fw ${r.fwMajor}.${r.fwMinor}, ${r.info.length} info bytes${r.ok ? '' : ' BAD CHECKSUM'}`;
    case 'read':
      return `READ reply ${r.space}:${a16(r.addr)} +${r.len}${r.ok ? '' : ' BAD CHECKSUM'}`;
    case 'write':
      return `WRITE reply ${r.space}:${a16(r.addr)} status ${r.status}`;
    case 'state':
      return `STATE ${r.mode === 1 ? 'controller' : r.mode === 0 ? 'sequencer' : 'mode ' + r.mode}, page ${r.page + 1}`;
    case 'touch':
      return `TOUCH ${['turn', 'push', 'key'][r.kind] ?? 'kind ' + r.kind} ${r.index + 1} (page ${r.page + 1})`;
    case 'tracks':
      return `TRACKS changed (${r.counter})`;
    case 'event':
      return 'EVENT (raw)';
    case 'error':
      return `ERROR for ${hex(r.cmd)}: code ${r.code} (${ERR[r.code] || '?'})`;
    case 'malformed':
      return `MALFORMED ${hex(r.cmd)}: ${r.reason}`;
    default:
      return `unknown reply ${hex(r.cmd)}`;
  }
}
export function describeCommand(msg) {
  const c = decodeCommand(msg);
  if (!c) return 'not a BCR32 message';
  const name = Object.keys(CMD).find((k) => CMD[k] === c.cmd) || hex(c.cmd);
  if (c.error) return name;
  switch (c.cmd) {
    case CMD.READ:
      return `READ ${c.space}:${a16(c.addr)} +${c.len}`;
    case CMD.WRITE:
      return `WRITE ${c.space}:${a16(c.addr)} +${c.len}`;
    case CMD.SELECT:
      return `SELECT page ${c.page + 1}`;
    case CMD.TOUCH_EVENTS:
      return `TOUCH_EVENTS ${c.on ? 'on' : 'off'}`;
    case CMD.EDIT:
      return `EDIT page ${c.page + 1} cell ${c.cell}`;
    case CMD.TEXT:
      return `TEXT kind ${c.kind} cells ${c.first}+${c.count}`;
    default:
      return name;
  }
}
