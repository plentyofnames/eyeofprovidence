// The controller space of Rotary Club (space 2, 4096 bytes; docs/controller-protocol.md): page
// names, the FH-2 sync header and tables A, B, C, and four pages of 48 cells (32 knobs, 16 keys),
// each a 15-byte cell record as controlfrog's. Value tables and rules from Lilypad's model.js.

export const SIZE = 4096;
export const PAGES = 4;
export const KNOBS = 32;
export const KEYS = 16;
export const CELLS = KNOBS + KEYS; // cells 0-31 knobs, 32-47 keys (as TEXT and EDIT count them)
export const REC = 15;

export const A = {
  HEADER: 0x0000, // 16 bytes: "BCRC", version 1, the rest FF
  NAMES: 0x0010, // page names, 4 characters each
  OUTPUTS: 0x0020, // page p's MIDI outputs at + p: bit 0 USB, 1 DIN OUT A, 2 DIN OUT B; FF all three
  SYNC: 0x0040, // the FH-2 sync header, 8 bytes
  TA: 0x0100, // table A: 2 bytes per knob at + 64·page + 2·knob
  TB: 0x0200, // table B, the same way
  TC: 0x0300, // table C: 1 byte per knob at + 32·page + knob
  PAGES: 0x0400, // page p at + 768·p: cell c at + 15·c (keys from + 480)
};
export const HEADER = [0x42, 0x43, 0x52, 0x43, 0x01];
export const PAGE_SIZE = 768;

export const isKey = (c) => c >= KNOBS;
export const keyCell = (j) => KNOBS + j;
export const cellAddr = (p, c) => A.PAGES + PAGE_SIZE * p + REC * c;
export const pageNameAddr = (p) => A.NAMES + 4 * p;
export const syncAAddr = (p, k) => A.TA + 64 * p + 2 * k;
export const syncBAddr = (p, k) => A.TB + 64 * p + 2 * k;
export const syncCAddr = (p, k) => A.TC + 32 * p + k;
export const cellLabel = (c) => (isKey(c) ? `Key ${c - KNOBS + 1}` : `Knob ${c + 1}`);

// The bytes the editor may write: everything listed in the spec, never the reserved bytes.
export function writable(addr) {
  if (addr < 0 || addr >= SIZE) return false;
  if (addr < 0x0024) return true; // header, names, outputs
  if (addr >= A.SYNC && addr < A.SYNC + 8) return true;
  if (addr >= A.TA && addr < A.TC + 128) return true;
  if (addr >= A.PAGES) return (addr - A.PAGES) % PAGE_SIZE < CELLS * REC;
  return false;
}

// Where an address lives: {page, cell} for a cell or a sync entry, {page, name} for a page name.
export function locate(addr) {
  if (addr >= A.PAGES) {
    const page = Math.floor((addr - A.PAGES) / PAGE_SIZE);
    const off = (addr - A.PAGES) % PAGE_SIZE;
    return off < CELLS * REC ? { page, cell: Math.floor(off / REC) } : { page };
  }
  if (addr >= A.TC && addr < A.TC + 128) return { page: (addr - A.TC) >> 5, cell: (addr - A.TC) & 31, sync: true };
  if (addr >= A.TA && addr < A.TC) {
    const o = (addr - A.TA) & 0xFF;
    return { page: o >> 6, cell: (o & 63) >> 1, sync: true };
  }
  if (addr >= A.NAMES && addr < A.NAMES + 16) return { page: (addr - A.NAMES) >> 2, name: true };
  if (addr >= A.OUTPUTS && addr < A.OUTPUTS + 4) return { page: addr - A.OUTPUTS, outputs: true };
  return {};
}

export function blankImage() {
  return new Uint8Array(SIZE).fill(0xFF);
}

// The header the firmware expects; written with the first edit of a blank image.
export function ensureHeader(img) {
  img.set(HEADER, A.HEADER);
  img.fill(0xFF, A.HEADER + HEADER.length, A.HEADER + 16);
}
export function hasHeader(img) {
  return HEADER.every((b, k) => img[A.HEADER + k] === b);
}
export function isBlank(img) {
  return img.every((b) => b === 0xFF);
}

// ---------------------------------------------------------------- value tables (Lilypad's)

// Plain names (the EC4's own in the comments): CCR1, CCR2, CCAb, PrgC, CCAh, PBnd, AftT, Note, NRPN.
export const ENC_TYPES = [
  { short: 'rel CC', label: 'CC relative (1 / 127)' },
  { short: 'rel CC', label: 'CC relative (63 / 65)' },
  { short: 'CC', label: 'CC' },
  { short: 'PC', label: 'Program change' },
  { short: '14-bit CC', label: 'CC 14-bit (n and n + 32)' },
  { short: 'PB', label: 'Pitch bend' },
  { short: 'AT', label: 'Aftertouch' },
  { short: 'Note', label: 'Note' },
  { short: 'NRPN', label: 'NRPN' },
];
export const T = { CCR1: 0, CCR2: 1, CCAB: 2, PRGC: 3, CCAH: 4, PBND: 5, AFTT: 6, NOTE: 7, NRPN: 8, OFF: 15 };

export const MODES = [
  { short: 'Div8', label: 'Division by 8' },
  { short: 'Div4', label: 'Division by 4' },
  { short: 'Div2', label: 'Division by 2' },
  { short: 'Acc0', label: 'No acceleration' },
  { short: 'Acc1', label: 'Low acceleration' },
  { short: 'Acc2', label: 'Mid acceleration' },
  { short: 'Acc3', label: 'Max acceleration' },
  { short: 'LSp2', label: 'Large step 2' },
  { short: 'LSp4', label: 'Large step 4' },
  { short: 'LSp6', label: 'Large step 6' },
];
export const MODE_OTHER = 5; // "Others count as Acc2"

export const SCALES = [
  { short: 'Off', label: 'Display off' },
  { short: '127', label: '0 … 127' },
  { short: '100', label: '0 … 100' },
  { short: '1000', label: '0 … 1000' },
  { short: '±63', label: '−63 … +63' },
  { short: '±50', label: '−50 … +50' },
  { short: '±500', label: '−500 … +500' },
  { short: 'ONOF', label: 'ON / OFF' },
  { short: '9999', label: '0 … 9999' },
];
export const SCALE_OTHER = 1; // not in the spec: as controlfrog's loader, 0 … 127
const HIRES_SCALES = new Set([0, 3, 6, 8]); // off, 1000, ±500, 9999

export const PUSH_TYPES = [
  { short: 'Off', label: 'Off' },
  { short: 'Note', label: 'Note' },
  { short: 'CC', label: 'Control change' },
  { short: 'PC', label: 'Program change' },
  { short: 'PB', label: 'Pitch bend' },
  { short: 'AT', label: 'Aftertouch' },
  { short: 'Page', label: 'Page select' },
  { short: 'Set', label: 'Set (does nothing here)' },
  { short: 'Acc0', label: 'Acceleration off while held' },
  { short: 'Acc3', label: 'Max acceleration while held' },
  { short: 'LSp6', label: 'Large step 6 while held' },
  { short: 'Min', label: 'Set to lower value' },
  { short: 'Max', label: 'Set to upper value' },
];
export const PT = { OFF: 0, NOTE: 1, CC: 2, PRGC: 3, PBND: 4, AFTT: 5, GRP: 6, SET: 7, ACC0: 8, ACC3: 9, LSP6: 10, MIN: 11, MAX: 12 };

export const PUSH_MODES = [
  { short: 'Key', label: 'Key (momentary)' },
  { short: 'Togl', label: 'Toggle' },
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function noteName(n) {
  return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 2); // 60 = C3, as on the EC4
}

// ---------------------------------------------------------------- names

// The firmware shows 20-7E; anything else as a space.
export const NAME_CHARS = /^[\x20-\x7E]$/;
export function readName(img, addr) {
  let s = '';
  for (let k = 0; k < 4; k++) {
    const c = img[addr + k];
    s += c >= 0x20 && c <= 0x7E ? String.fromCharCode(c) : ' ';
  }
  return s;
}
export function isBlankName(img, addr) {
  for (let k = 0; k < 4; k++) if (img[addr + k] !== 0xFF) return false;
  return true;
}
export function sanitizeName(str) {
  return [...String(str)].filter((c) => NAME_CHARS.test(c)).join('').slice(0, 4).padEnd(4, ' ');
}
export function writeName(img, addr, str) {
  const s = sanitizeName(str);
  for (let k = 0; k < 4; k++) img[addr + k] = s.charCodeAt(k);
}
// ---------------------------------------------------------------- page outputs

export const OUTPUTS = [
  { bit: 1, short: 'USB', label: 'USB' },
  { bit: 2, short: 'A', label: 'DIN OUT A' },
  { bit: 4, short: 'B', label: 'DIN OUT B' },
];
export const ALL_OUTPUTS = 7;
// Bits 0-2 of the page's byte; FF (blank) means all three.
export function readOutputs(img, p) {
  const v = img[A.OUTPUTS + p];
  return v === 0xFF ? ALL_OUTPUTS : v & ALL_OUTPUTS;
}
// All three are stored as FF (the blank value), anything else as its bits.
export function setOutputs(img, p, bits) {
  bits &= ALL_OUTPUTS;
  img[A.OUTPUTS + p] = bits === ALL_OUTPUTS ? 0xFF : bits;
}
export function toggleOutput(img, p, bit) {
  setOutputs(img, p, readOutputs(img, p) ^ bit);
}
export const outputsSummary = (bits) => (bits === ALL_OUTPUTS ? 'all' : OUTPUTS.filter((o) => bits & o.bit).map((o) => o.short).join(' ') || 'none');

export const pageName = (img, p) => (isBlankName(img, pageNameAddr(p)) ? '' : readName(img, pageNameAddr(p)).trimEnd());
export const cellName = (img, p, c) => readName(img, cellAddr(p, c) + 8).trimEnd();

// ---------------------------------------------------------------- the cell record

export function readRecord(img, p, c) {
  const a = cellAddr(p, c);
  return img.slice(a, a + REC);
}
export function writeRecord(img, p, c, rec) {
  img.set(rec, cellAddr(p, c));
}
export function clearCell(img, p, c) {
  img.fill(0xFF, cellAddr(p, c), cellAddr(p, c) + REC);
}
export const isBlankRecord = (rec) => rec.every((b) => b === 0xFF);

export function isHiRes(type, scale) {
  return type === T.CCAH || ((type === T.PBND || type === T.NRPN) && HIRES_SCALES.has(scale));
}

// 14-bit lower/upper: low byte + 4-bit MSB nibble · 256 = 0…4094; 4095 means 16383.
export const HIRES_MAX = 16383;
const val14 = (lo, nib) => {
  const v = lo + (nib << 8);
  return v === 4095 ? HIRES_MAX : v;
};

export function decodeEncoder(r) {
  const rawType = r[0] >> 4;
  const rawMode = r[5] >> 4;
  const rawScale = r[5] & 15;
  const type = rawType > 8 ? T.OFF : rawType;
  const mode = rawMode > 9 ? MODE_OTHER : rawMode;
  const scale = rawScale > 8 ? SCALE_OTHER : rawScale;
  const hires = isHiRes(type, scale);
  return {
    type, rawType, mode, rawMode, scale, rawScale, hires,
    off: type === T.OFF,
    channel: r[0] & 15,
    link: r[1] >> 7,
    number: r[1] & 0x7F,
    numberHigh: r[2],
    lowerRaw: r[3] | ((r[6] & 15) << 8),
    upperRaw: r[4] | ((r[6] >> 4) << 8),
    lower: hires ? val14(r[3], r[6] & 15) : r[3] & 0x7F,
    upper: hires ? val14(r[4], r[6] >> 4) : r[4] & 0x7F,
  };
}

// A key has no encoder: Set and the encoder's push types (Acc0, Acc3, LSp6, Min, Max) are off
// on it, as the firmware plays them (ctl.c).
export const pushTypeOnKey = (t) => t !== PT.SET && t < PT.ACC0;

export function decodePush(r, key = false) {
  const rawType = r[7] >> 4;
  const valid = rawType < PUSH_TYPES.length;
  const type = valid ? rawType : PT.OFF;
  const onKeyOff = key && !pushTypeOnKey(type);
  return {
    type,
    rawType,
    valid,
    onKeyOff,
    off: !valid || type === PT.OFF || onKeyOff,
    channel: r[7] & 15,
    mode: r[12] >> 7, // 1 toggle, 0 key
    number: r[12] & 0x7F,
    display: r[13] >> 7,
    lower: r[13] & 0x7F,
    link: r[14] >> 7,
    upper: r[14] & 0x7F,
  };
}

export function readCell(img, p, c) {
  const rec = readRecord(img, p, c);
  return {
    rec,
    blank: isBlankRecord(rec),
    enc: decodeEncoder(rec),
    push: decodePush(rec, isKey(c)),
    name: readName(rec, 8).trimEnd(),
    blankName: isBlankName(rec, 8),
  };
}

// Which encoder fields apply, and their ranges. Link: not on the last knob (no next one).
export function encoderRules(e, c) {
  const t = e.type;
  const r = {
    channel: { enabled: true },
    scale: { enabled: true },
    mode: { enabled: t !== T.NOTE },
    link: { enabled: c < KNOBS - 1 },
    number: { enabled: true, kind: 'number', min: 0, max: 127, label: 'Number' },
    numberHigh: { enabled: false, min: 0, max: 127 },
    lower: { enabled: true, min: 0, max: 127, hires: false },
    upper: { enabled: true, min: 0, max: 127, hires: false },
  };
  if (t === T.CCR1 || t === T.CCR2 || t === T.NOTE) r.lower.enabled = r.upper.enabled = false;
  if (t === T.CCAH) r.number = { ...r.number, max: 31, label: 'CC (14-bit)' };
  if (t === T.CCAB || t === T.CCR1 || t === T.CCR2) r.number.label = 'CC number';
  if (t === T.NOTE) r.number = { ...r.number, kind: 'note', label: 'Note' };
  if (t === T.PRGC || t === T.PBND || t === T.AFTT) r.number = { ...r.number, enabled: false };
  if (t === T.NRPN) {
    r.number = { ...r.number, label: 'NRPN LSB' };
    r.numberHigh = { enabled: true, min: 0, max: 127, label: 'NRPN MSB' };
  }
  if (e.hires) for (const k of ['lower', 'upper']) r[k] = { ...r[k], max: HIRES_MAX, hires: true };
  if (t === T.OFF) for (const k of Object.keys(r)) r[k] = { ...r[k], enabled: false };
  return r;
}

export function pushRules(p, c) {
  const t = p.type;
  const key = isKey(c);
  const r = {
    display: { enabled: true },
    mode: { enabled: true },
    channel: { enabled: true, label: 'Channel', kind: 'channel' },
    number: { enabled: true, kind: 'number', label: 'Number' },
    lower: { enabled: true },
    upper: { enabled: true },
    link: { enabled: key ? c < CELLS - 1 : c < KNOBS - 1 },
  };
  if (t === PT.NOTE) {
    r.number = { ...r.number, kind: 'note', label: 'Note' };
    r.lower = { ...r.lower, label: 'Note-off vel.', hint: '0: no note off' };
    r.upper = { ...r.upper, label: 'Velocity', hint: '0 = 127' };
  }
  if (t === PT.CC) {
    r.number.label = 'CC number';
    r.lower = { ...r.lower, label: 'Off value' };
    r.upper = { ...r.upper, label: 'On value' };
  }
  if (p.off) {
    for (const k of Object.keys(r)) r[k] = { ...r[k], enabled: false };
  } else if (t >= PT.ACC0) {
    for (const k of ['mode', 'channel', 'number', 'lower', 'upper']) r[k] = { ...r[k], enabled: false };
  } else if (t === PT.GRP) {
    for (const k of ['mode', 'number', 'lower', 'upper']) r[k] = { ...r[k], enabled: false };
    r.channel = { enabled: true, label: 'Page', kind: 'page' };
  } else if (t === PT.SET) {
    for (const k of ['mode', 'channel', 'number', 'lower', 'upper']) r[k] = { ...r[k], enabled: false };
  }
  return r;
}

const nib = (b, high, v) => (high ? (b & 0x0F) | ((v & 15) << 4) : (b & 0xF0) | (v & 15));
const c7 = (x) => Math.max(0, Math.min(127, Math.round(Number(x) || 0)));

// Clamps a 14-bit value to what the record can hold: 0…4094 or 16383.
export function clamp14(v) {
  v = Math.round(v);
  if (v <= 0) return 0;
  if (v > 4094) return HIRES_MAX;
  return v;
}

function setLowerUpper(r, which, v, hires) {
  const off = which === 'lower' ? 3 : 4;
  const high = which === 'upper';
  if (hires) {
    v = clamp14(v);
    const stored = v === HIRES_MAX ? 4095 : v;
    r[off] = stored & 0xFF;
    r[6] = nib(r[6], high, stored >> 8);
  } else {
    r[off] = c7(v);
    r[6] = nib(r[6], high, 0); // keeps the 14-bit reading equal to the 7-bit value
  }
}

// Defaults for a knob or key that is switched on from blank. A knob's push takes CC 64 + knob,
// clear of the knob's own CC 20 + knob and of the 14-bit LSBs 33-63 (review, 2026-11-08).
const DEFAULT_CC = (c) => (20 + c) & 0x7F;
const DEFAULT_PUSH_CC = (c) => (64 + c) & 0x7F;
const DEFAULT_NOTE = (c) => 36 + (c - KNOBS);
const encoderBlank = (r) => [0, 1, 2, 3, 4, 5, 6].every((k) => r[k] === 0xFF);
const pushBlank = (r) => r[12] === 0xFF && r[13] === 0xFF && r[14] === 0xFF && r[7] >> 4 > 12;

// Record edits: on a 15-byte record (so cells copied around keep every field).
export function setEncoderRec(r, c, field, value) {
  const e = decodeEncoder(r);
  const v = field === 'name' ? value : Number(value);
  switch (field) {
    case 'type': {
      const t = v >= 0 && v <= 8 ? v : T.OFF;
      if (t !== T.OFF && encoderBlank(r)) {
        // a blank knob switched on: ch 1, Acc1, display 0-127, the whole range of its type
        r.set([0x00, DEFAULT_CC(c), 0, 0, 127, (4 << 4) | 1, 0], 0);
        r[0] = nib(r[0], true, t);
        if (t === T.CCAH) r[1] = 1 + (c % 31); // MSB numbers 1-31 (0 is bank select)
        if (decodeEncoder(r).hires) setLowerUpper(r, 'upper', HIRES_MAX, true);
        enforceRanges(r);
        break;
      }
      const lo = e.lower;
      const up = e.upper;
      r[0] = nib(r[0], true, t);
      if (e.rawMode > 9) r[5] = nib(r[5], true, e.mode); // make the clamped values explicit
      if (e.rawScale > 8) r[5] = nib(r[5], false, e.scale);
      convertRange(r, e, lo, up);
      enforceRanges(r);
      break;
    }
    case 'channel':
      r[0] = nib(r[0], false, Math.max(0, Math.min(15, v)));
      break;
    case 'link':
      r[1] = (r[1] & 0x7F) | (v && c < KNOBS - 1 ? 0x80 : 0);
      break;
    case 'number':
      r[1] = (r[1] & 0x80) | Math.max(0, Math.min(e.type === T.CCAH ? 31 : 127, Math.round(v)));
      break;
    case 'numberHigh':
      r[2] = c7(v);
      break;
    case 'lower':
    case 'upper':
      setLowerUpper(r, field, v, e.hires);
      break;
    case 'mode':
      r[5] = nib(r[5], true, Math.max(0, Math.min(9, v)));
      break;
    case 'scale': {
      const lo = e.lower;
      const up = e.upper;
      r[5] = nib(r[5], false, Math.max(0, Math.min(8, v)));
      if (e.rawMode > 9) r[5] = nib(r[5], true, e.mode);
      convertRange(r, e, lo, up);
      enforceRanges(r);
      break;
    }
    case 'name':
      writeName(r, 8, value);
      break;
    default:
      throw new Error('unknown encoder field ' + field);
  }
}

// After a type or scale change that switches between 7 and 14 bits: the same range, rescaled
// (0-127 becomes 0-16383 and back).
function convertRange(r, before, lo, up) {
  const after = decodeEncoder(r);
  if (after.off || before.off || after.hires === before.hires) return;
  // 14-bit ranges are stored in 12 bits (0-4094, or 16383): only the ends map exactly.
  const conv = after.hires ? (v) => (v >= 127 ? HIRES_MAX : Math.min(4094, v << 7)) : (v) => (v >= HIRES_MAX ? 127 : Math.min(127, v >> 7));
  setLowerUpper(r, 'lower', conv(lo), after.hires);
  setLowerUpper(r, 'upper', conv(up), after.hires);
}

// CCAh numbers are 0…31 (MSB on n, LSB on n + 32); NRPN MSB is 7-bit.
function enforceRanges(r) {
  const e = decodeEncoder(r);
  if (e.type === T.CCAH && e.number > 31) r[1] = (r[1] & 0x80) | 31;
  if (e.type === T.NRPN && r[2] > 127) r[2] = 127;
}

export function setPushRec(r, c, field, value) {
  const v = Number(value);
  switch (field) {
    case 'type': {
      const t = v >= 0 && v < PUSH_TYPES.length ? v : PT.OFF;
      if (t !== PT.OFF && pushBlank(r)) {
        r[7] = 0x00; // channel 1
        r[12] = isKey(c) ? DEFAULT_NOTE(c) : DEFAULT_PUSH_CC(c); // key mode
        r[13] = 0x80 | (t === PT.NOTE ? 64 : 0); // display on; a note's off velocity 64, a CC's off 0
        r[14] = 127; // no link, upper 127
      }
      r[7] = nib(r[7], true, t);
      if (t === PT.GRP && (r[7] & 15) > 3) r[7] = nib(r[7], false, 0);
      break;
    }
    case 'channel':
      r[7] = nib(r[7], false, Math.max(0, Math.min(15, v)));
      break;
    case 'mode':
      r[12] = (r[12] & 0x7F) | (v ? 0x80 : 0);
      break;
    case 'number':
      r[12] = (r[12] & 0x80) | c7(v);
      break;
    case 'display':
      r[13] = (r[13] & 0x7F) | (v ? 0x80 : 0);
      break;
    case 'lower':
      r[13] = (r[13] & 0x80) | c7(v);
      break;
    case 'link': {
      const ok = isKey(c) ? c < CELLS - 1 : c < KNOBS - 1;
      r[14] = (r[14] & 0x7F) | (v && ok ? 0x80 : 0);
      break;
    }
    case 'upper':
      r[14] = (r[14] & 0x80) | c7(v);
      break;
    default:
      throw new Error('unknown push field ' + field);
  }
}

// The same on the image.
export function setEncoder(img, p, c, field, value) {
  const r = readRecord(img, p, c);
  setEncoderRec(r, c, field, value);
  writeRecord(img, p, c, r);
}
export function setPush(img, p, c, field, value) {
  const r = readRecord(img, p, c);
  setPushRec(r, c, field, value);
  writeRecord(img, p, c, r);
}
export function setName(img, p, c, value) {
  writeName(img, cellAddr(p, c) + 8, value);
}

// Short one-line summaries for the grid.
export function encoderSummary(e) {
  if (e.off) return 'off';
  // what tells knobs apart first (the box cuts the end off): "CC20 ch16", "14-bit CC1 ch16"
  const t = ENC_TYPES[e.type].short;
  const ch = `ch${e.channel + 1}`;
  switch (e.type) {
    case T.NRPN:
      return `${t} ${Math.min(e.numberHigh, 127)}:${e.number} ${ch}`;
    case T.NOTE:
      return `${t} ${noteName(e.number)} ${ch}`;
    case T.PRGC:
    case T.PBND:
    case T.AFTT:
      return `${t} ${ch}`;
    default:
      return `${t}${e.number} ${ch}`;
  }
}
export function pushSummary(p) {
  if (p.off) return 'off';
  const t = PUSH_TYPES[p.type].short;
  const m = p.mode ? ' tgl' : '';
  switch (p.type) {
    case PT.NOTE:
      return `${t} ${noteName(p.number)} ch${p.channel + 1}${m}`;
    case PT.CC:
      return `${t}${p.number} ch${p.channel + 1}${m}`;
    case PT.GRP:
      return `→ page ${(p.channel & 3) + 1}`;
    case PT.PRGC:
      return `${t} ${p.number} ch${p.channel + 1}`;
    case PT.PBND:
    case PT.AFTT:
      return `${t} ch${p.channel + 1}`;
    default:
      return t;
  }
}

// ---------------------------------------------------------------- the FH-2 sync tables

export const SYNC_TYPES = [
  { short: 'u14', label: '14-bit value', needs: T.CCAH },
  { short: 'u7', label: '7-bit value', needs: T.CCAB },
  { short: 'band', label: 'banded value', needs: T.CCAB },
  { short: 'tempo', label: 'tempo', needs: T.CCAB },
];

// Table C's codes (controlfrog's docs/protocol.md, "Table C").
export const TABLE_C = {
  0x01: 'number', 0x02: 'OFF or number', 0x03: 'OFF / ON', 0x04: 'x n', 0x05: 'n OCT', 0x06: 'degrees',
  0x07: 'tempo', 0x08: 'signed (v − 64)', 0x09: 'signed, LIN', 0x0A: '± % (63)', 0x0B: '± % (64)', 0x0C: '%',
  0x0D: 'TRIG or %', 0x0E: 'TRIG or % of 128', 0x0F: 'randomness %', 0x10: 'note value',
  0x18: 'volts 0–10 V', 0x19: 'volts ±5 V', 0x1A: 'volts 0–1 V', 0x1B: 'volts 0–5 V', 0x1C: 'volts 0–8 V',
  0x1D: '% (14-bit)', 0x1E: 'LFO Hz', 0x20: 'arp mode', 0x21: 'swing type', 0x22: 'SR direction', 0x23: 'SR scale', 0x24: 'key',
};

export function readSyncHeader(img) {
  const h = img.slice(A.SYNC, A.SYNC + 8);
  const valid = h[0] === 0x46 && h[1] === 0x48 && h[2] === 0x32 && (h[3] === 1 || h[3] === 2); // as the firmware
  const blank = h.every((b) => b === 0xFF);
  return { bytes: h, valid, blank, format: h[3], version: h[5], dest: h[6], program: h[7] };
}

// A knob's entry, or null: {a, type, offset, b: [b0, b1], c, ...}
export function readSync(img, p, k) {
  if (k >= KNOBS) return null;
  const a = (img[syncAAddr(p, k)] << 8) | img[syncAAddr(p, k) + 1];
  if (a === 0xFFFF) return null;
  const b = [img[syncBAddr(p, k)], img[syncBAddr(p, k) + 1]];
  const c = img[syncCAddr(p, k)];
  const type = (a >> 12) & 7;
  const offset = a & 0x0FFF;
  const s = { a, type, offset, b, c, bit15: a >> 15 };
  if (type === 2) Object.assign(s, { n: b[0] & 0x3F, held: !!(b[0] & 0x40), from: b[1] > 127 ? b[1] - 256 : b[1] });
  if (type === 3) s.base = b[0];
  return s;
}

// Whether the knob can use its entry, and if not, why (controlfrog's rules).
export function syncProblem(s, e, header) {
  if (!s) return null;
  if (!header.valid) return 'no sync header';
  if (s.bit15 || s.type > 3) return `type ${s.type} unknown`;
  const need = SYNC_TYPES[s.type].needs;
  if (e.type !== need) return `needs ${ENC_TYPES[need].short}`;
  if ((s.type === 2 || s.type === 3) && s.b[0] === 0xFF && s.b[1] === 0xFF) return 'no table B entry';
  if (s.type === 2 && !s.n) return 'no bands';
  const last = s.type === 0 ? 0xFFE : s.type === 3 ? 0xFFC : 0xFFF;
  if (s.offset > last) return 'offset past the dump';
  return null;
}

export function syncSummary(s) {
  if (!s) return '';
  const t = SYNC_TYPES[s.type]?.short ?? `type ${s.type}`;
  let more = '';
  if (s.type === 2) more = ` · ${s.n} bands from ${s.from}${s.held ? ', held at 1' : ''}`;
  if (s.type === 3) more = ` · ${s.base} BPM at 0`;
  return `${t} @ 0x${s.offset.toString(16).toUpperCase().padStart(3, '0')}${more}`;
}

export function removeSync(img, p, k) {
  img.fill(0xFF, syncAAddr(p, k), syncAAddr(p, k) + 2);
  img.fill(0xFF, syncBAddr(p, k), syncBAddr(p, k) + 2);
  img[syncCAddr(p, k)] = 0xFF;
}

export function syncCount(img) {
  let n = 0;
  for (let p = 0; p < PAGES; p++) for (let k = 0; k < KNOBS; k++) if (readSync(img, p, k)) n++;
  return n;
}

// Every address of a cell (its record) and, for a knob, its sync entries.
export function cellAddrs(p, c) {
  const out = Array.from({ length: REC }, (_, k) => cellAddr(p, c) + k);
  if (c < KNOBS) out.push(syncAAddr(p, c), syncAAddr(p, c) + 1, syncBAddr(p, c), syncBAddr(p, c) + 1, syncCAddr(p, c));
  return out;
}
