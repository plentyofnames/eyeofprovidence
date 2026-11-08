// controlfrog settings protocol v1: framing, 8-to-7 packing, message codecs.
// Shared by the host client (device.js) and the mock device (mock.js).

export const HEADER = [0xF0, 0x7D, 0x45, 0x43, 0x34]; // SysEx start, non-commercial ID, "EC4"

export const CMD = {
  DUMP_ALL: 0x01,
  IDENTIFY: 0x02,
  READ: 0x10,
  READ_REPLY: 0x11,
  WRITE: 0x12,
  WRITE_REPLY: 0x13,
  GET_STATE: 0x20,
  STATE: 0x21,
  SELECT: 0x22,
  RELOAD: 0x24,
  TOUCH_EVENTS: 0x26,
  TOUCH: 0x31,
  ERROR: 0x7F,
};

export const ERR = {
  1: 'bad length or range',
  2: 'bad checksum',
  3: 'EEPROM bus error',
  4: 'busy (dump running)',
  5: 'unknown command',
};

export const MAX_CHUNK = 64;
export const PAGE = 64;

export class ProtocolError extends Error {
  constructor(cmd, code) {
    super(`device error for command ${hex(cmd)}: ${ERR[code] || 'code ' + code}`);
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

// Numbers are sent in 7-bit groups, MSB first.
export function encodeNum(v, width) {
  const out = [];
  for (let i = width - 1; i >= 0; i--) out.push((v >> (7 * i)) & 0x7F);
  return out;
}

export function decodeNum(bytes, at, width) {
  let v = 0;
  for (let i = 0; i < width; i++) v = (v << 7) | (bytes[at + i] & 0x7F);
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

export function unpack(bytes, at, n) {
  const out = new Uint8Array(n);
  let p = at;
  for (let i = 0; i < n; i += 7) {
    const k = Math.min(7, n - i);
    const head = bytes[p++];
    for (let j = 0; j < k; j++) out[i + j] = (bytes[p++] & 0x7F) | ((head >> j) & 1) << 7;
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

// Returns {cmd, body} for an EC4 protocol message, or null for anything else.
export function unframe(msg) {
  if (msg.length < 7 || msg[msg.length - 1] !== 0xF7) return null;
  for (let i = 0; i < HEADER.length; i++) if (msg[i] !== HEADER[i]) return null;
  return { cmd: msg[5], body: msg.subarray(6, msg.length - 1) };
}

// ---- host -> device ----

export const host = {
  dumpAll: () => frame(CMD.DUMP_ALL),
  identify: () => frame(CMD.IDENTIFY),
  read: (addr, len) => frame(CMD.READ, [...encodeNum(addr, 3), ...encodeNum(len, 2)]),
  write: (addr, data) =>
    frame(CMD.WRITE, [...encodeNum(addr, 3), ...encodeNum(data.length, 2), ...pack(data), checksum(data)]),
  getState: () => frame(CMD.GET_STATE),
  select: (setup, group) => frame(CMD.SELECT, [setup & 0x7F, group & 0x7F]),
  reload: () => frame(CMD.RELOAD),
  touchEvents: (on) => frame(CMD.TOUCH_EVENTS, [on ? 1 : 0]),
};

// ---- device -> host ----

export const device = {
  identify: (proto, fwMajor, fwMinor, eepromKb, maxChunk) =>
    frame(CMD.IDENTIFY, [proto, fwMajor, fwMinor, eepromKb, maxChunk].map((v) => v & 0x7F)),
  readReply: (addr, data) =>
    frame(CMD.READ_REPLY, [...encodeNum(addr, 3), ...encodeNum(data.length, 2), ...pack(data), checksum(data)]),
  writeReply: (addr, status) => frame(CMD.WRITE_REPLY, [...encodeNum(addr, 3), status & 0x7F]),
  state: (setup, group) => frame(CMD.STATE, [setup, group]),
  touch: (kind, index, setup, group) => frame(CMD.TOUCH, [kind, index, setup, group]),
  error: (cmd, code) => frame(CMD.ERROR, [cmd & 0x7F, code]),
};

// Decodes a device -> host message. Returns null if it isn't one of ours.
// Malformed messages decode to {type: 'malformed', reason}.
export function decodeReply(msg) {
  const f = unframe(msg);
  if (!f) return null;
  const { cmd, body } = f;
  const bad = (reason) => ({ type: 'malformed', cmd, reason });
  switch (cmd) {
    case CMD.IDENTIFY:
      if (body.length < 5) return bad('short IDENTIFY reply');
      return { type: 'identify', proto: body[0], fwMajor: body[1], fwMinor: body[2], eepromKb: body[3], maxChunk: body[4] };
    case CMD.READ_REPLY: {
      if (body.length < 5) return bad('short READ reply');
      const addr = decodeNum(body, 0, 3);
      const len = decodeNum(body, 3, 2);
      if (body.length !== 5 + packedLength(len) + 1) return bad(`READ reply length ${body.length} for ${len} bytes`);
      const data = unpack(body, 5, len);
      const ok = checksum(data) === body[body.length - 1];
      return { type: 'read', addr, len, data, ok };
    }
    case CMD.WRITE_REPLY:
      if (body.length < 4) return bad('short WRITE reply');
      return { type: 'write', addr: decodeNum(body, 0, 3), status: body[3] };
    case CMD.STATE:
      if (body.length < 2) return bad('short STATE');
      return { type: 'state', setup: body[0], group: body[1] };
    case CMD.TOUCH:
      if (body.length < 4) return bad('short TOUCH');
      return { type: 'touch', kind: body[0], index: body[1], setup: body[2], group: body[3] };
    case CMD.ERROR:
      if (body.length < 2) return bad('short ERROR');
      return { type: 'error', cmd: body[0], code: body[1] };
    default:
      return { type: 'unknown', cmd, body };
  }
}

// Decodes a host -> device message (used by the mock). Returns null if it isn't one of ours.
export function decodeCommand(msg) {
  const f = unframe(msg);
  if (!f) return null;
  const { cmd, body } = f;
  const r = { cmd, body };
  switch (cmd) {
    case CMD.READ:
      if (body.length !== 5) return { ...r, error: 1 };
      return { ...r, addr: decodeNum(body, 0, 3), len: decodeNum(body, 3, 2) };
    case CMD.WRITE: {
      if (body.length < 5) return { ...r, error: 1 };
      const addr = decodeNum(body, 0, 3);
      const len = decodeNum(body, 3, 2);
      if (len < 1 || len > MAX_CHUNK || body.length !== 5 + packedLength(len) + 1) return { ...r, addr, len, error: 1 };
      const data = unpack(body, 5, len);
      if (checksum(data) !== body[body.length - 1]) return { ...r, addr, len, error: 2 };
      return { ...r, addr, len, data };
    }
    case CMD.SELECT:
      if (body.length !== 2) return { ...r, error: 1 };
      return { ...r, setup: body[0], group: body[1] };
    case CMD.TOUCH_EVENTS:
      if (body.length !== 1) return { ...r, error: 1 };
      return { ...r, on: body[0] !== 0 };
    default:
      return r;
  }
}

// Wire time at 31250 baud, 10 bits per byte.
export const BYTE_MS = 10 * 1000 / 31250; // 0.32 ms
export function wireMs(nBytes) {
  return nBytes * BYTE_MS;
}

// One-line descriptions for the protocol log.
const a16 = (v) => '0x' + v.toString(16).toUpperCase().padStart(4, '0');
export function describeReply(r) {
  switch (r.type) {
    case 'identify':
      return `IDENTIFY reply: proto ${r.proto}, fw ${r.fwMajor}.${r.fwMinor}, ${r.eepromKb} KB, chunk ${r.maxChunk}`;
    case 'read':
      return `READ reply ${a16(r.addr)} +${r.len}${r.ok ? '' : ' BAD CHECKSUM'}`;
    case 'write':
      return `WRITE reply ${a16(r.addr)} status ${r.status}`;
    case 'state':
      return `STATE setup ${r.setup + 1} group ${r.group + 1}`;
    case 'touch':
      return `TOUCH ${r.kind === 0 ? 'turn' : r.kind === 1 ? 'push' : 'kind ' + r.kind} ${r.index + 1} (setup ${r.setup + 1} group ${r.group + 1})`;
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
  if (!c) return 'not an EC4 message';
  const name = Object.keys(CMD).find((k) => CMD[k] === c.cmd) || hex(c.cmd);
  switch (c.cmd) {
    case CMD.READ:
      return `READ ${a16(c.addr)} +${c.len}`;
    case CMD.WRITE:
      return `WRITE ${a16(c.addr)} +${c.len}: ${Array.from(c.data || [], (b) => b.toString(16).padStart(2, '0')).join(' ')}`;
    case CMD.SELECT:
      return `SELECT setup ${c.setup + 1} group ${c.group + 1}`;
    case CMD.TOUCH_EVENTS:
      return `TOUCH_EVENTS ${c.on ? 'on' : 'off'}`;
    default:
      return name;
  }
}
