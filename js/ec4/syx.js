// Faderfox nibble-SysEx container (setup dumps only).
//
// Every value byte v travels as three bytes: CMD (0x4X), 0x20 | v >> 4, 0x10 | v & 15.
//   41 dev  download start (EC4 = 0x0B)     42 type (02 one setup, 03 all setups)
//   43/44   version                          49/4A page byte address high/low
//   4D      data byte (64 per page)          4B/4C page checksum (16-bit byte sum)
//   4F dev  download stop
// Stock "all setups" files put 30 zero bytes after each page; the controlfrog firmware's
// full EEPROM dump has none. The padding is remembered so files round-trip exactly.

export const DEVICE_EC4 = 0x0B;
export const TYPE_ONE_SETUP = 0x02;
export const TYPE_ALL_SETUPS = 0x03;
export const STOCK_PADDING = 30;

export class SyxError extends Error {}

function* commands(raw) {
  let i = 0;
  while (i < raw.length) {
    const b = raw[i];
    if (b === 0xF0 || b === 0xF7 || b === 0x00) {
      i++;
      continue;
    }
    if (b >> 4 !== 4) throw new SyxError(`unexpected byte 0x${b.toString(16)} at offset ${i}`);
    if (i + 2 >= raw.length) throw new SyxError(`truncated command at offset ${i}`);
    const hi = raw[i + 1];
    const lo = raw[i + 2];
    if (hi >> 4 !== 2 || lo >> 4 !== 1) throw new SyxError(`bad nibble pair at offset ${i}`);
    yield { cmd: b & 0xF, value: ((hi & 0xF) << 4) | (lo & 0xF), at: i, end: i + 3 };
    i += 3;
  }
}

export function sum16(data) {
  let s = 0;
  for (const b of data) s += b;
  return s & 0xFFFF;
}

// Returns {header: {1: dev, 2: type, 3: major, 4: minor}, pages: [{addr, data, check}], stop, padding, badPages}
export function parseContainer(raw) {
  raw = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const header = {};
  const pages = [];
  let cur = null;
  let stop = null;
  let padding = null;
  let lastPageEnd = -1;
  let curData = [];
  for (const c of commands(raw)) {
    if (lastPageEnd >= 0) {
      if (padding === null) padding = c.at - lastPageEnd;
      lastPageEnd = -1;
    }
    switch (c.cmd) {
      case 0x9:
        cur = { addr: c.value << 8, check: 0 };
        curData = [];
        break;
      case 0xA:
        if (!cur) throw new SyxError('page address low without high');
        cur.addr |= c.value;
        break;
      case 0xD:
        if (!cur) throw new SyxError('data outside a page');
        curData.push(c.value);
        break;
      case 0xB:
        if (!cur) throw new SyxError('checksum outside a page');
        cur.check = c.value << 8;
        break;
      case 0xC:
        if (!cur) throw new SyxError('checksum outside a page');
        cur.check |= c.value;
        cur.data = Uint8Array.from(curData);
        pages.push(cur);
        cur = null;
        lastPageEnd = c.end;
        break;
      case 0xF:
        stop = c.value;
        break;
      default:
        header[c.cmd] = c.value;
    }
  }
  if (!pages.length) throw new SyxError('no data pages found');
  if (header[1] !== DEVICE_EC4) throw new SyxError(`not an EC4 file (device ID ${header[1]})`);
  if (header[2] !== TYPE_ALL_SETUPS && header[2] !== TYPE_ONE_SETUP)
    throw new SyxError(header[2] === 1 ? 'this is a firmware update file, not setups' : `unknown dump type ${header[2]}`);
  const badPages = pages.filter((p) => sum16(p.data) !== p.check).map((p) => p.addr);
  return { header, pages, stop, padding: padding ?? 0, badPages };
}

function put(out, cmd, v) {
  out.push(0x40 | cmd, 0x20 | (v >> 4), 0x10 | (v & 0xF));
}

// pages: [{addr, data}] with byte addresses; checksums are computed here.
export function serializeContainer({ header, pages, stop = DEVICE_EC4, padding = STOCK_PADDING }) {
  const out = [0xF0, 0x00, 0x00, 0x00];
  for (const k of Object.keys(header).map(Number).sort((a, b) => a - b)) put(out, k, header[k]);
  for (const p of pages) {
    put(out, 0x9, p.addr >> 8);
    put(out, 0xA, p.addr & 0xFF);
    for (const v of p.data) put(out, 0xD, v);
    const s = sum16(p.data);
    put(out, 0xB, s >> 8);
    put(out, 0xC, s & 0xFF);
    for (let i = 0; i < padding; i++) out.push(0);
  }
  put(out, 0xF, stop);
  out.push(0xF7);
  return Uint8Array.from(out);
}

export function defaultHeader() {
  return { 1: DEVICE_EC4, 2: TYPE_ALL_SETUPS, 3: 2, 4: 0 }; // data format V2.00
}

// Builds a container from a 64 KB image for the byte range [start, end), in 64-byte pages.
export function containerFromImage(img, start, end, opts = {}) {
  const pages = [];
  for (let a = start; a < end; a += 64) pages.push({ addr: a, data: img.subarray(a, a + 64) });
  return serializeContainer({
    header: opts.header || defaultHeader(),
    pages,
    stop: opts.stop ?? DEVICE_EC4,
    padding: opts.padding ?? STOCK_PADDING,
  });
}
