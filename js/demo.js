// Demo data, generated here so no device data ships with the editor:
//  - fakeNightShiftEc4(): an EC4 EEPROM with setup 15 as Night Shift writes it (setup.js): three
//    FH-2 pages (VOI1, LFO1, CLK) with the sync header and tables A, B, C, groups 4-16 blank.
//  - demoImage(): a BCR32 controller image: those pages imported, plus other knobs (a TD-3, a
//    Rytm) and keys, and an empty page 4.

import * as E from './ec4/model.js';
import * as M from './model.js';
import { applyImport, EC4, EC4_SETUP } from './import.js';

const CH = 15; // Night Shift's pages channel: 16
const DEAD = { type: E.T.CCR1, channel: CH, number: 119, mode: 3, scale: 0, lower: 0, upper: 127, name: '    ' };
const PUSH_OFF = { type: E.PT.OFF, channel: 0, mode: 0, number: 0, display: 0, lower: 0, upper: 0 };

// knob: [name, kind, cc, sync] with kind 'u7' (CCAb), 'u14' (CCAh), 'rel' (CCR1); sync: [a, b0, b1, c]
const PAGES = [
  {
    name: 'VOI1',
    knobs: [
      ['ATK', 'u7', 20, [0x1000 | 0x140, 0xFF, 0xFF, 0x01]], ['DEC', 'u7', 21, [0x1000 | 0x141, 0xFF, 0xFF, 0x01]],
      ['SUS', 'u7', 22, [0x1000 | 0x142, 0xFF, 0xFF, 0x0C]], ['REL', 'u7', 23, [0x1000 | 0x143, 0xFF, 0xFF, 0x01]],
      ['ARP', 'u7', 24, [0x1000 | 0x150, 0xFF, 0xFF, 0x20]], ['ARNG', 'u7', 25, [0x2000 | 0x151, 0x03, 0x01, 0x05]],
      ['LTCH', 'u7', 26, [0x2000 | 0x152, 0x02, 0x00, 0x03]], ['GLID', 'u7', 27, [0x1000 | 0x153, 0xFF, 0xFF, 0x02]],
      ['LEVL', 'u14', 1, [0x0000 | 0x024, 0xFF, 0xFF, 0x18]], ['TRNS', 'u7', 28, [0x1000 | 0x154, 0xFF, 0xFF, 0x08]],
    ],
    pushes: { 4: 90, 5: 91 }, // arp add, arp remove: CC while held
  },
  {
    name: 'LFO1',
    knobs: [
      ['RATE', 'u14', 2, [0x0000 | 0x0A4, 0xFF, 0xFF, 0x1E]], ['DPTH', 'u14', 3, [0x0000 | 0x0A6, 0xFF, 0xFF, 0x1D]],
      ['SINE', 'u7', 30, [0x1000 | 0x0B0, 0xFF, 0xFF, 0x0C]], ['SAW', 'u7', 31, [0x1000 | 0x0B1, 0xFF, 0xFF, 0x0B]],
      ['PHAS', 'u7', 33, [0x1000 | 0x0B2, 0xFF, 0xFF, 0x06]], ['SYNC', 'u7', 34, [0x1000 | 0x0B3, 0xFF, 0xFF, 0x10]],
      ['MULT', 'u7', 35, [0x1000 | 0x0B4, 0xFF, 0xFF, 0x04]], ['NUDG', 'rel', 36, null],
    ],
    pushes: {},
  },
  {
    name: 'CLK',
    knobs: [
      ['TEMP', 'u7', 40, [0x3000 | 0x010, 60, 0, 0x07]], ['SWNG', 'u7', 41, [0x1000 | 0x014, 0xFF, 0xFF, 0x02]],
      ['STYP', 'u7', 42, [0x2000 | 0x015, 0x03, 0x00, 0x21]], ['PULS', 'u7', 43, [0x2000 | 0x200, 0x21, 0x00, 0x01]],
      ['STEP', 'u7', 44, [0x2000 | 0x201, 0x61, 0x00, 0x01]],
    ],
    pushes: { 0: 95, 1: 96 }, // tempo -0.1, +0.1
  },
];

function setCell(img, g, i, e, p) {
  const s = EC4_SETUP;
  for (const f of ['type', 'scale', 'channel', 'number', 'mode', 'lower', 'upper', 'name']) E.setEncoder(img, s, g, i, f, e[f]);
  E.setEncoder(img, s, g, i, 'numberHigh', 0);
  if (i < 15) E.setEncoder(img, s, g, i, 'link', 0);
  for (const f of ['type', 'channel', 'mode', 'number', 'display', 'lower', 'upper']) E.setPush(img, s, g, i, f, p[f]);
  if (i < 15) E.setPush(img, s, g, i, 'link', 0);
}

export function fakeNightShiftEc4() {
  const img = new Uint8Array(E.SIZE).fill(0xFF);
  const s = EC4_SETUP;
  E.writeName(img, E.setupNameAddr(s), 'FH-2');
  img.set([0x46, 0x48, 0x32, 2, s, 8, 1, 16], EC4.SYNC_HEADER); // format 2, setup 15, dump 8, USB, PC ch 16
  for (let g = 0; g < 16; g++) {
    const page = PAGES[g];
    E.writeName(img, E.groupNameAddr(s, g), page ? page.name : '    ');
    for (let i = 0; i < 16; i++) {
      const k = page?.knobs[i];
      let e = DEAD;
      if (k) {
        const [name, kind, cc] = k;
        e = kind === 'u14' ? { type: E.T.CCAH, channel: CH, number: cc, mode: 5, scale: 3, lower: 0, upper: E.HIRES_MAX, name }
          : kind === 'rel' ? { type: E.T.CCR1, channel: CH, number: cc, mode: 4, scale: 1, lower: 0, upper: 127, name }
          : { type: E.T.CCAB, channel: CH, number: cc, mode: 4, scale: name === 'LTCH' ? 7 : 1, lower: 0, upper: 127, name };
      }
      const pcc = page?.pushes[i];
      const p = pcc ? { type: E.PT.CC, channel: CH, mode: 0, number: pcc, display: 1, lower: 0, upper: 127 } : PUSH_OFF;
      setCell(img, g, i, e, p);
      const sy = k?.[3];
      img.set(sy ? [sy[0] >> 8, sy[0] & 0xFF] : [0xFF, 0xFF], EC4.TA + 32 * g + 2 * i);
      img.set(sy ? [sy[1], sy[2]] : [0xFF, 0xFF], EC4.TB + 32 * g + 2 * i);
      img[EC4.TC + 16 * g + i] = sy ? sy[3] : 0xFF;
    }
  }
  return img;
}

// knobs: [name, cc] in a row of the right half (columns 5-8) or a whole row
function knob(img, p, c, name, { type = M.T.CCAB, channel = 0, cc = 0, scale = 1, mode = 4 } = {}) {
  M.setEncoder(img, p, c, 'type', type);
  for (const [f, v] of [['channel', channel], ['number', cc], ['scale', scale], ['mode', mode], ['lower', 0], ['upper', type === M.T.CCAH ? M.HIRES_MAX : 127], ['link', 0], ['numberHigh', 0]]) {
    M.setEncoder(img, p, c, f, v);
  }
  M.setName(img, p, c, name);
  M.setPush(img, p, c, 'type', M.PT.OFF);
}

export function demoImage() {
  const img = M.blankImage();
  M.ensureHeader(img);
  applyImport(img, { img: fakeNightShiftEc4(), hasTables: true, hasTableC: true }, [0, 1, 2]);
  // page 2, right half: a TD-3 on channel 2
  const td3 = [['CUT', 74], ['RES', 71], ['ENV', 12], ['DEC', 75], ['ACC', 16], ['TUNE', 104], ['DIST', 17], ['VOL', 7]];
  td3.forEach(([n, cc], k) => knob(img, 1, (k >> 2) * 8 + 4 + (k & 3), n, { channel: 1, cc }));
  // page 3: a Rytm, track levels on channels 1-8, then filter and decay
  M.writeName(img, M.pageNameAddr(2), 'RYTM');
  for (let t = 0; t < 8; t++) {
    knob(img, 2, t, `LV${t + 1}`, { channel: t, cc: 95 });
    knob(img, 2, 8 + t, `FLT${t + 1}`, { channel: t, cc: 74 });
    knob(img, 2, 16 + t, `DEC${t + 1}`, { channel: t, cc: 80 });
  }
  knob(img, 2, 24, 'PERF', { channel: 9, cc: 35 });
  knob(img, 2, 25, 'SCNE', { channel: 9, cc: 92, type: M.T.CCR1 });
  // page 3's keys play the Rytm's pads (notes 36-47 on channel 10), toggles on 13-14
  for (let j = 0; j < 12; j++) {
    const c = M.keyCell(j);
    M.setPush(img, 2, c, 'type', M.PT.NOTE);
    M.setPush(img, 2, c, 'channel', 9);
    M.setPush(img, 2, c, 'number', 36 + j);
    M.setName(img, 2, c, `PD${j + 1}`);
  }
  for (const [j, cc, n] of [[12, 110, 'MUTE'], [13, 111, 'FILL']]) {
    const c = M.keyCell(j);
    M.setPush(img, 2, c, 'type', M.PT.CC);
    M.setPush(img, 2, c, 'channel', 9);
    M.setPush(img, 2, c, 'number', cc);
    M.setPush(img, 2, c, 'mode', 1);
    M.setName(img, 2, c, n);
  }
  M.setOutputs(img, 2, 2); // the Rytm on DIN OUT A only
  // keys 15-16 of pages 1-3: the previous and next page
  for (let p = 0; p < 3; p++) {
    for (const [j, to] of [[14, (p + 3) % 4], [15, (p + 1) % 4]]) {
      const c = M.keyCell(j);
      M.setPush(img, p, c, 'type', M.PT.GRP);
      M.setPush(img, p, c, 'channel', to);
      M.setName(img, p, c, `PG${to + 1}`);
    }
  }
  return img;
}
