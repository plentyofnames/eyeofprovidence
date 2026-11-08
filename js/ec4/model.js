// EC4 settings model: memory map, value tables and the RULES of Faderfox's EC4 SysEx data
// format (V2), on top of a 64 KB EEPROM image.

export const SIZE = 0x10000;
export const PAGE = 64;
export const NPAGES = SIZE / PAGE;

export const A = {
  LAST_SETUP: 0x0000,
  ROUTING: 0x0001,
  POPUP: 0x0002,
  BRIGHTNESS: 0x0003,
  SCREENSAVER: 0x0005,
  NOTE_VIEW: 0x0006,
  SEND_VALUES: 0x0007, // controlfrog 0.10+: 1 = send the group's values on a group change; stock ignores it
  LAST_GROUP: 0x0010, // 16 bytes, one per setup
  KEY1: 0x0B00, // push mode/number, 16 bytes per group
  SETUP_NAMES: 0x1BC0, // 4 bytes per setup
  GROUP_NAMES: 0x1C00, // 64 bytes per setup
  DATA: 0x2000, // 192 bytes per group
  KEY2: 0xE000, // push display/lower, link/upper, 32 bytes per group
  SETUPS_START: 0x0B00, // stock "all setups" dumps cover 0x0B00-0xFFFF
};

// Bytes the editor may write to the device: the editable globals (0x0001-0x0003, 0x0005-0x0007)
// and the setups area. 0x0000 (last setup; >= 16 factory-resets at boot), 0x0004 (unused),
// 0x0008-0x000F, 0x0010-0x001F (last group) and the presets 0x0800-0x0AFF belong to the device
// and are never written. The stock firmware never reads or writes 0x0007.
export function writable(addr) {
  return addr >= A.SETUPS_START || addr === 1 || addr === 2 || addr === 3 || addr === 5 || addr === 6 || addr === 7;
}

const grp = (s, g) => s * 16 + g;
export const dataBase = (s, g) => A.DATA + grp(s, g) * 192;
export const key1Base = (s, g) => A.KEY1 + grp(s, g) * 16;
export const key2Base = (s, g) => A.KEY2 + grp(s, g) * 32;
export const setupNameAddr = (s) => A.SETUP_NAMES + s * 4;
export const groupNameAddr = (s, g) => A.GROUP_NAMES + s * 64 + g * 4;
export const encNameAddr = (s, g, i) => dataBase(s, g) + 128 + i * 4;

// Byte ranges [addr, len] holding one setup (~3.9 KB, 61 pages) or one group.
export function setupRanges(s) {
  return [
    [A.KEY1 + s * 256, 256],
    [A.GROUP_NAMES + s * 64, 64],
    [A.DATA + s * 3072, 3072],
    [A.KEY2 + s * 512, 512],
  ];
}
export function groupRanges(s, g) {
  return [
    [key1Base(s, g), 16],
    [groupNameAddr(s, g), 4],
    [dataBase(s, g), 192],
    [key2Base(s, g), 32],
  ];
}
export function pagesOf(ranges) {
  const set = new Set();
  for (const [a, n] of ranges) for (let p = a >> 6; p <= (a + n - 1) >> 6; p++) set.add(p);
  return [...set].sort((x, y) => x - y);
}
export const GLOBALS_PAGE = 0;
export const SETUP_NAMES_PAGE = A.SETUP_NAMES >> 6;

// Every byte address that belongs to control i (encoder + push button + name) of a group.
export function controlAddrs(s, g, i) {
  const d = dataBase(s, g);
  const out = [];
  for (let k = 0; k < 8; k++) out.push(d + k * 16 + i);
  for (let k = 0; k < 4; k++) out.push(d + 128 + i * 4 + k);
  out.push(key1Base(s, g) + i, key2Base(s, g) + i, key2Base(s, g) + 16 + i);
  return out;
}

// ---------------------------------------------------------------- value tables

export const ENC_TYPES = [
  { short: 'CCR1', label: 'CC relative 1 (1/127)' },
  { short: 'CCR2', label: 'CC relative 2 (63/65)' },
  { short: 'CCab', label: 'CC absolute' },
  { short: 'PrgC', label: 'Program change' },
  { short: 'CCAh', label: 'CC absolute 14-bit' },
  { short: 'PBnd', label: 'Pitch bend' },
  { short: 'AftT', label: 'Aftertouch' },
  { short: 'Note', label: 'Note' },
  { short: 'NRPN', label: 'NRPN' },
];
export const T = { CCR1: 0, CCR2: 1, CCAB: 2, PRGC: 3, CCAH: 4, PBND: 5, AFTT: 6, NOTE: 7, NRPN: 8 };

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
const HIRES_SCALES = new Set([0, 3, 6, 8]); // off, 1000, ±500, 9999

export const PUSH_TYPES = [
  { short: 'Off', label: 'Off' },
  { short: 'Note', label: 'Note' },
  { short: 'CC', label: 'Control change' },
  { short: 'PrgC', label: 'Program change' },
  { short: 'PBnd', label: 'Pitch bend' },
  { short: 'AftT', label: 'Aftertouch' },
  { short: 'Grp', label: 'Group select' },
  { short: 'Set', label: 'Setup select' },
  { short: 'Acc0', label: 'Acceleration off' },
  { short: 'Acc3', label: 'Max acceleration' },
  { short: 'LSp6', label: 'Large step 6' },
  { short: 'Min', label: 'Set to lower value' },
  { short: 'Max', label: 'Set to upper value' },
];
export const PT = { OFF: 0, NOTE: 1, CC: 2, PRGC: 3, PBND: 4, AFTT: 5, GRP: 6, SET: 7, ACC0: 8, ACC3: 9, LSP6: 10, MIN: 11, MAX: 12 };

export const PUSH_MODES = [
  { short: 'Key', label: 'Key (momentary)' },
  { short: 'Togl', label: 'Toggle' },
];

export const ROUTING = [
  { value: 0, short: 'no', label: 'No routing' },
  { value: 1, short: 'UM', label: 'USB in → MIDI out' },
  { value: 2, short: 'MM', label: 'MIDI in → MIDI out' },
  { value: 4, short: 'MU', label: 'MIDI in → USB out' },
  { value: 5, short: 'MUUM', label: 'MIDI in → USB out, USB in → MIDI out' },
  { value: 6, short: 'MMMU', label: 'MIDI in → MIDI out + USB out' },
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function noteName(n) {
  return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 2); // 60 = C3, as on the EC4
}

// ---------------------------------------------------------------- names

export const NAME_CHARS = /^[0-9A-Za-z .\/-]$/;
export function readName(img, addr) {
  let s = '';
  for (let k = 0; k < 4; k++) {
    const c = img[addr + k];
    s += NAME_CHARS.test(String.fromCharCode(c)) ? String.fromCharCode(c) : c === 0xFF ? ' ' : '?';
  }
  return s;
}
export function isBlankName(img, addr) {
  for (let k = 0; k < 4; k++) if (img[addr + k] !== 0xFF) return false;
  return true;
}
export function sanitizeName(str) {
  return [...str].filter((c) => NAME_CHARS.test(c)).join('').slice(0, 4).padEnd(4, ' ');
}
export function writeName(img, addr, str) {
  const s = sanitizeName(str);
  for (let k = 0; k < 4; k++) img[addr + k] = s.charCodeAt(k);
}
export function setupName(img, s) {
  return isBlankName(img, setupNameAddr(s)) ? `SE${String(s).padStart(2, '0')}` : readName(img, setupNameAddr(s));
}
export function groupName(img, s, g) {
  return isBlankName(img, groupNameAddr(s, g)) ? `GR${String(g).padStart(2, '0')}` : readName(img, groupNameAddr(s, g));
}

// ---------------------------------------------------------------- encoders

export function isHiRes(type, scale) {
  return (type === T.CCAH || type === T.PBND || type === T.NRPN) && HIRES_SCALES.has(scale);
}

// 14-bit lower/upper: low byte + 4-bit MSB nibble * 256 = 0…4094; 4095 means 16383.
export const HIRES_MAX = 16383;
function val14(lo, nib) {
  const v = lo + (nib << 8);
  return v === 4095 ? HIRES_MAX : v;
}

export function readEncoder(img, s, g, i) {
  const d = dataBase(s, g);
  const tc = img[d + i];
  const ln = img[d + 16 + i];
  const ms = img[d + 80 + i];
  const nib = img[d + 96 + i];
  const rawType = tc >> 4;
  const rawMode = ms >> 4;
  const rawScale = ms & 15;
  // Load-time clamps of the stock firmware: type >= 9 -> 2, mode >= 10 -> 3, scale >= 9 -> 1.
  const type = rawType > 8 ? T.CCAB : rawType;
  const mode = rawMode > 9 ? 3 : rawMode;
  const scale = rawScale > 8 ? 1 : rawScale;
  const hires = isHiRes(type, scale);
  const lo = img[d + 48 + i];
  const up = img[d + 64 + i];
  return {
    type, rawType, mode, rawMode, scale, rawScale, hires,
    channel: tc & 15,
    link: ln >> 7,
    number: ln & 0x7F,
    numberHigh: img[d + 32 + i],
    lowerRaw: lo,
    upperRaw: up,
    lower: hires ? val14(lo, nib & 15) : Math.min(lo, 127),
    upper: hires ? val14(up, nib >> 4) : Math.min(up, 127),
    name: readName(img, d + 128 + i * 4),
    blankName: isBlankName(img, d + 128 + i * 4),
  };
}

// Which encoder fields apply, and their ranges (RULES).
export function encoderRules(e, i) {
  const t = e.type;
  const r = {
    channel: { enabled: true },
    scale: { enabled: true },
    mode: { enabled: t !== T.NOTE },
    link: { enabled: i < 15 },
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
  if (e.hires) {
    for (const k of ['lower', 'upper']) r[k] = { ...r[k], max: HIRES_MAX, hires: true };
  }
  return r;
}

// Clamps a 14-bit value to what the EEPROM can hold: 0…4094 or 16383.
export function clamp14(v) {
  v = Math.round(v);
  if (v <= 0) return 0;
  if (v > 4094) return HIRES_MAX;
  return v;
}

function setNibble(img, addr, high, v) {
  img[addr] = high ? (img[addr] & 0x0F) | ((v & 15) << 4) : (img[addr] & 0xF0) | (v & 15);
}

function setLowerUpper(img, s, g, i, which, v, hires) {
  const d = dataBase(s, g);
  const off = which === 'lower' ? 48 : 64;
  const high = which === 'upper';
  if (hires) {
    v = clamp14(v);
    const stored = v === HIRES_MAX ? 4095 : v;
    img[d + off + i] = stored & 0xFF;
    setNibble(img, d + 96 + i, high, stored >> 8);
  } else {
    v = Math.max(0, Math.min(127, Math.round(v)));
    img[d + off + i] = v;
    setNibble(img, d + 96 + i, high, 0); // keep the 14-bit reading equal to the 7-bit value
  }
}

// Sets one encoder field and enforces the RULES that depend on it.
export function setEncoder(img, s, g, i, field, value) {
  const d = dataBase(s, g);
  const e = readEncoder(img, s, g, i);
  const v = typeof value === 'string' && field !== 'name' ? Number(value) : value;
  switch (field) {
    case 'type': {
      setNibble(img, d + i, true, Math.max(0, Math.min(8, v)));
      if (e.rawMode > 9) setNibble(img, d + 80 + i, true, e.mode); // make the clamped values explicit
      if (e.rawScale > 8) setNibble(img, d + 80 + i, false, e.scale);
      enforceRanges(img, s, g, i);
      break;
    }
    case 'channel':
      setNibble(img, d + i, false, Math.max(0, Math.min(15, v)));
      break;
    case 'link':
      if (i < 15) img[d + 16 + i] = (img[d + 16 + i] & 0x7F) | (v ? 0x80 : 0);
      break;
    case 'number': {
      const max = e.type === T.CCAH ? 31 : 127;
      img[d + 16 + i] = (img[d + 16 + i] & 0x80) | Math.max(0, Math.min(max, v));
      break;
    }
    case 'numberHigh':
      img[d + 32 + i] = Math.max(0, Math.min(127, v));
      break;
    case 'lower':
    case 'upper':
      setLowerUpper(img, s, g, i, field, v, e.hires);
      break;
    case 'mode':
      setNibble(img, d + 80 + i, true, Math.max(0, Math.min(9, v)));
      break;
    case 'scale':
      setNibble(img, d + 80 + i, false, Math.max(0, Math.min(8, v)));
      if (e.rawType > 8) setNibble(img, d + i, true, e.type);
      if (e.rawMode > 9) setNibble(img, d + 80 + i, true, e.mode);
      enforceRanges(img, s, g, i);
      break;
    case 'name':
      writeName(img, d + 128 + i * 4, value);
      break;
    default:
      throw new Error('unknown encoder field ' + field);
  }
}

// After a type or display change: CCAh numbers are 0…31, NRPN MSB is 7-bit.
// Lower/upper bytes are left as stored; the device reads them in the new resolution.
function enforceRanges(img, s, g, i) {
  const d = dataBase(s, g);
  const e = readEncoder(img, s, g, i);
  if (e.type === T.CCAH && e.number > 31) img[d + 16 + i] = (img[d + 16 + i] & 0x80) | 31;
  if (e.type === T.NRPN && e.numberHigh > 127) img[d + 32 + i] = 127;
}

// ---------------------------------------------------------------- push buttons

export function readPush(img, s, g, i) {
  const d = dataBase(s, g);
  const k1 = img[key1Base(s, g) + i];
  const k2a = img[key2Base(s, g) + i];
  const k2b = img[key2Base(s, g) + 16 + i];
  const rawType = img[d + 112 + i] >> 4;
  return {
    type: rawType,
    rawType,
    valid: rawType < PUSH_TYPES.length,
    channel: img[d + 112 + i] & 15,
    mode: k1 >> 7,
    number: k1 & 0x7F,
    display: k2a >> 7,
    lower: k2a & 0x7F,
    link: k2b >> 7,
    upper: k2b & 0x7F,
  };
}

export function pushRules(p, i) {
  const t = p.type;
  const r = {
    display: { enabled: true },
    mode: { enabled: true },
    channel: { enabled: true, label: 'Channel', kind: 'channel' },
    number: { enabled: true, kind: 'number', label: 'Number' },
    lower: { enabled: true },
    upper: { enabled: true },
    link: { enabled: i < 15 },
  };
  if (t === PT.NOTE) r.number = { ...r.number, kind: 'note', label: 'Note' };
  if (t === PT.CC) r.number.label = 'CC number';
  if (t === PT.OFF) {
    for (const k of ['display', 'mode', 'channel', 'number', 'lower', 'upper']) r[k] = { ...r[k], enabled: false };
  } else if (t >= PT.ACC0) {
    for (const k of ['mode', 'channel', 'number', 'lower', 'upper']) r[k] = { ...r[k], enabled: false };
  } else if (t === PT.GRP || t === PT.SET) {
    for (const k of ['mode', 'number', 'lower', 'upper']) r[k] = { ...r[k], enabled: false };
    r.channel = { enabled: true, label: t === PT.GRP ? 'Group' : 'Setup', kind: t === PT.GRP ? 'group' : 'setup' };
  }
  return r;
}

export function setPush(img, s, g, i, field, value) {
  const d = dataBase(s, g);
  const v = Number(value);
  const k1 = key1Base(s, g) + i;
  const k2a = key2Base(s, g) + i;
  const k2b = key2Base(s, g) + 16 + i;
  const c7 = (x) => Math.max(0, Math.min(127, Math.round(x)));
  switch (field) {
    case 'type':
      setNibble(img, d + 112 + i, true, Math.max(0, Math.min(PUSH_TYPES.length - 1, v)));
      break;
    case 'channel':
      setNibble(img, d + 112 + i, false, Math.max(0, Math.min(15, v)));
      break;
    case 'mode':
      img[k1] = (img[k1] & 0x7F) | (v ? 0x80 : 0);
      break;
    case 'number':
      img[k1] = (img[k1] & 0x80) | c7(v);
      break;
    case 'display':
      img[k2a] = (img[k2a] & 0x7F) | (v ? 0x80 : 0);
      break;
    case 'lower':
      img[k2a] = (img[k2a] & 0x80) | c7(v);
      break;
    case 'link':
      if (i < 15) img[k2b] = (img[k2b] & 0x7F) | (v ? 0x80 : 0);
      break;
    case 'upper':
      img[k2b] = (img[k2b] & 0x80) | c7(v);
      break;
    default:
      throw new Error('unknown push field ' + field);
  }
}

// ---------------------------------------------------------------- globals

export function readGlobals(img) {
  return {
    lastSetup: img[A.LAST_SETUP],
    routing: img[A.ROUTING],
    popup: img[A.POPUP],
    brightness: img[A.BRIGHTNESS],
    screensaver: img[A.SCREENSAVER],
    noteView: img[A.NOTE_VIEW],
    sendValues: img[A.SEND_VALUES] === 1, // anything else (blank 0xFF, 0) is off
    lastGroups: Array.from(img.subarray(A.LAST_GROUP, A.LAST_GROUP + 16)),
  };
}

export function setGlobal(img, field, value) {
  const v = Math.round(Number(value));
  switch (field) {
    case 'routing':
      img[A.ROUTING] = ROUTING.some((r) => r.value === v) ? v : 6;
      break;
    case 'popup':
      img[A.POPUP] = Math.max(0, Math.min(2, v));
      break;
    case 'brightness':
      img[A.BRIGHTNESS] = Math.max(0, Math.min(255, v));
      break;
    case 'screensaver':
      img[A.SCREENSAVER] = Math.max(1, Math.min(100, v));
      break;
    case 'noteView':
      img[A.NOTE_VIEW] = v ? 1 : 0;
      break;
    case 'sendValues':
      img[A.SEND_VALUES] = v ? 1 : 0;
      break;
    default:
      throw new Error('unknown global ' + field);
  }
}

// Short one-line summaries for the grid.
export function encoderSummary(e) {
  const t = ENC_TYPES[e.type].short;
  const ch = `ch${e.channel + 1}`;
  switch (e.type) {
    case T.NRPN:
      return `${t} ${ch} ${Math.min(e.numberHigh, 127)}:${e.number}`;
    case T.NOTE:
      return `${t} ${ch} ${noteName(e.number)}`;
    case T.PRGC:
    case T.PBND:
    case T.AFTT:
      return `${t} ${ch}`;
    default:
      return `${t} ${ch} #${e.number}`;
  }
}
export function pushSummary(p) {
  if (!p.valid) return `type ${p.rawType}?`;
  const t = PUSH_TYPES[p.type].short;
  switch (p.type) {
    case PT.OFF:
      return 'Off';
    case PT.NOTE:
      return `${t} ch${p.channel + 1} ${noteName(p.number)}`;
    case PT.CC:
      return `${t} ch${p.channel + 1} #${p.number}`;
    case PT.GRP:
      return `→ group ${p.channel + 1}`;
    case PT.SET:
      return `→ setup ${p.channel + 1}`;
    case PT.PRGC:
    case PT.PBND:
    case PT.AFTT:
      return `${t} ch${p.channel + 1}`;
    default:
      return t;
  }
}
