// Night Shift's FH-2 pages from an EC4 (controlfrog) onto the BCR32's pages, as the spec's last
// section says (docs/controller-protocol.md, "From Night Shift's EC4 pages"): EC4 group g (0-7)
// of setup 15 goes to BCR32 page g / 2, the left four columns for even g and the right four for
// odd g; EC4 cell i becomes knob (i / 4)·8 + (g % 2)·4 + i % 4; its table A, B and C entries go
// with it, and the sync header is copied with byte 4 set to 0.
//
// The EC4 side uses Lilypad's model (js/ec4/model.js) and controlfrog's addresses
// (ec4-fw/docs/protocol.md); the cell record is built as Night Shift's setup.js cellRecord does.

import * as E from './ec4/model.js';
import { parseContainer } from './ec4/syx.js';
import * as M from './model.js';

export const EC4_SETUP = 14; // setup 15, Night Shift's
export const GROUPS = 8; // groups 8-15 don't fit
export const EC4 = { SYNC_HEADER: 0x05C0, TA: 0x0600, TB: 0x0200, TC: 0x0400 };

export const bcrPage = (g) => g >> 1;
export const bcrKnob = (g, i) => (i >> 2) * 8 + (g & 1) * 4 + (i & 3);
export const halfName = (g) => `page ${bcrPage(g) + 1} ${g & 1 ? 'right' : 'left'}`;

// controlfrog's table addresses for knob i of group g (setup 15's tables).
const taAddr = (g, i) => EC4.TA + 32 * g + 2 * i;
const tbAddr = (g, i) => EC4.TB + 32 * g + 2 * i;
const tcAddr = (g, i) => EC4.TC + 16 * g + i;

// A cell's 15-byte record from the stock EEPROM layout (Night Shift's cellRecord).
export function ec4CellRecord(img, s, g, i) {
  const d = E.dataBase(s, g);
  return Uint8Array.from([
    ...Array.from({ length: 8 }, (_, k) => img[d + 16 * k + i]),
    ...img.slice(E.encNameAddr(s, g, i), E.encNameAddr(s, g, i) + 4),
    img[E.key1Base(s, g) + i], img[E.key2Base(s, g) + i], img[E.key2Base(s, g) + 16 + i],
  ]);
}

// The EC4 byte ranges the import needs: groups 0-7 of setup 15, its group names and name, the
// sync header and tables A, B, C for those groups.
export function ec4Ranges(s = EC4_SETUP) {
  return [
    [E.dataBase(s, 0), 192 * GROUPS],
    [E.key1Base(s, 0), 16 * GROUPS],
    [E.key2Base(s, 0), 32 * GROUPS],
    [E.groupNameAddr(s, 0), 64], // all 16 groups' names: groups 8-15 are checked for pages too
    [E.setupNameAddr(s), 4],
    [EC4.SYNC_HEADER, 8],
    [EC4.TA, 32 * GROUPS],
    [EC4.TB, 32 * GROUPS],
    [EC4.TC, 16 * GROUPS],
  ];
}
export const ec4Pages = (s = EC4_SETUP) => E.pagesOf(ec4Ranges(s));

// Reads what the import needs from an EC4 running controlfrog, with Lilypad's Device. Returns a
// 64 KB image (FF elsewhere) and what the EC4 said about itself.
export async function readEc4(device, onStep = () => {}) {
  const info = device.info ?? (await device.identify({ busyMs: 4000 }));
  if (info.proto !== 1) throw new Error(`The EC4 speaks protocol ${info.proto}; Lilypad's is 1.`);
  const img = new Uint8Array(E.SIZE).fill(0xFF);
  const pages = ec4Pages();
  for (const [k, p] of pages.entries()) {
    img.set(await device.read(p * E.PAGE, E.PAGE), p * E.PAGE);
    onStep(k + 1, pages.length);
  }
  const fw = [info.fwMajor, info.fwMinor];
  const at = (maj, min) => fw[0] > maj || (fw[0] === maj && fw[1] >= min);
  // Table C is controlfrog 0.13's; before that the bytes mean nothing.
  return { img, hasTables: true, hasTableC: at(0, 13), source: `EC4 (controlfrog ${fw[0]}.${fw[1]})`, fw };
}

// The same from a Lilypad .syx file: a full EEPROM dump has the tables, an "all setups" file
// (0x0B00-) only the cells.
export function ec4FromSyx(raw, name = '.syx') {
  const c = parseContainer(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
  if (c.badPages.length) throw new Error(`${c.badPages.length} pages have bad checksums`);
  const img = new Uint8Array(E.SIZE).fill(0xFF);
  for (const p of c.pages) img.set(p.data, p.addr);
  const have = new Set(c.pages.map((p) => p.addr));
  const covers = (a, n) => E.pagesOf([[a, n]]).every((q) => have.has(q * E.PAGE));
  const hasTables = covers(EC4.SYNC_HEADER, 8) && covers(EC4.TA, 32 * GROUPS) && covers(EC4.TB, 32 * GROUPS);
  return { img, hasTables, hasTableC: hasTables && covers(EC4.TC, 16 * GROUPS), source: name };
}

// What the EC4 holds in groups 0-7 of setup 15 (and whether 8-15 hold pages that won't fit).
export function scanEc4(src) {
  const { img } = src;
  const s = EC4_SETUP;
  const groups = [];
  for (let g = 0; g < GROUPS; g++) {
    const name = E.isBlankName(img, E.groupNameAddr(s, g)) ? '' : E.readName(img, E.groupNameAddr(s, g)).trimEnd();
    let knobs = 0;
    let synced = 0;
    let pushes = 0;
    for (let i = 0; i < 16; i++) {
      const r = ec4CellRecord(img, s, g, i);
      if (M.readName(r, 8).trim()) knobs++;
      if (!M.decodePush(r).off) pushes++;
      if (src.hasTables && (img[taAddr(g, i)] !== 0xFF || img[taAddr(g, i) + 1] !== 0xFF)) synced++;
    }
    const empty = !name.trim() && !knobs && !synced && !pushes;
    groups.push({ g, name, knobs, synced, pushes, empty, page: bcrPage(g), half: g & 1 });
  }
  const beyond = [];
  for (let g = GROUPS; g < 16; g++) {
    const n = E.isBlankName(img, E.groupNameAddr(s, g)) ? '' : E.readName(img, E.groupNameAddr(s, g)).trim();
    if (n) beyond.push({ g, name: n });
  }
  const setupName = E.isBlankName(img, E.setupNameAddr(s)) ? '' : E.readName(img, E.setupNameAddr(s)).trimEnd();
  const header = src.hasTables ? img.slice(EC4.SYNC_HEADER, EC4.SYNC_HEADER + 8) : null;
  const headerOk = !!header && header[0] === 0x46 && header[1] === 0x48 && header[2] === 0x32;
  return { groups, beyond, setupName, header, headerOk, format: header?.[3] };
}

// Night Shift's free knobs (FH-2/js/ec4/setup.js, encoderOf and pushOf for a cell that maps
// nothing): CC 119 relative on the pages channel, Acc0, display off, 0-127, a blank name, no
// push and no sync entry, because the EC4 has no "off". The BCR32 has one: they become blank
// cells (review, 2026-11-08). The link bits don't count: a group's last cell keeps them set.
export const FREE_CC = 119;
export function isFreeKnob(rec, synced) {
  const e = M.decodeEncoder(rec);
  const p = M.decodePush(rec);
  return e.type === M.T.CCR1 && e.number === FREE_CC && e.mode === 3 && e.scale === 0 && e.lower === 0 && e.upper === 127
    && !M.readName(rec, 8).trim() && p.off && !synced;
}
const ec4Synced = (src, g, i) => src.hasTables && (src.img[taAddr(g, i)] !== 0xFF || src.img[taAddr(g, i) + 1] !== 0xFF);

// Maps the chosen EC4 groups onto `bcr` (the BCR32 image): their 16 cells each (a free knob as
// a blank cell), the knobs' sync entries (FF where the source has no tables), the header if the
// source has one, and the page name from the left half's group (or the right one's when the
// left isn't imported). Returns what changed: { cells: ['p:k'], pages: [p], header, names: {p: name} }.
export function applyImport(bcr, src, groups) {
  const { img } = src;
  const s = EC4_SETUP;
  const done = { cells: [], pages: [], header: false, names: {} };
  M.ensureHeader(bcr);
  for (const g of [...groups].sort((a, b) => a - b)) {
    if (g < 0 || g >= GROUPS) continue;
    const p = bcrPage(g);
    for (let i = 0; i < 16; i++) {
      const k = bcrKnob(g, i);
      const rec = ec4CellRecord(img, s, g, i);
      if (isFreeKnob(rec, ec4Synced(src, g, i))) {
        M.clearCell(bcr, p, k);
        M.removeSync(bcr, p, k);
        done.cells.push(`${p}:${k}`);
        continue;
      }
      M.writeRecord(bcr, p, k, rec);
      if (src.hasTables) {
        bcr.set(img.slice(taAddr(g, i), taAddr(g, i) + 2), M.syncAAddr(p, k));
        bcr.set(img.slice(tbAddr(g, i), tbAddr(g, i) + 2), M.syncBAddr(p, k));
        bcr[M.syncCAddr(p, k)] = src.hasTableC ? img[tcAddr(g, i)] : 0xFF;
      } else M.removeSync(bcr, p, k);
      done.cells.push(`${p}:${k}`);
    }
    if (!done.pages.includes(p)) done.pages.push(p);
  }
  const groupName = (g) => (E.isBlankName(img, E.groupNameAddr(s, g)) ? '' : E.readName(img, E.groupNameAddr(s, g)));
  for (const p of done.pages) {
    const name = [2 * p, 2 * p + 1].filter((g) => groups.includes(g)).map(groupName).find((n) => n.trim());
    if (name) {
      M.writeName(bcr, M.pageNameAddr(p), name);
      done.names[p] = name.trimEnd();
    }
    // Night Shift's knobs go to the FH-2 on USB: the page keeps (or gets back) FF, all outputs.
    bcr[M.A.OUTPUTS + p] = 0xFF;
  }
  const eh = img.slice(EC4.SYNC_HEADER, EC4.SYNC_HEADER + 8);
  const headerOk = eh[0] === 0x46 && eh[1] === 0x48 && eh[2] === 0x32 && (eh[3] === 1 || eh[3] === 2);
  if (done.cells.length && src.hasTables && headerOk) { // a blank EC4 header leaves the BCR32's alone
    const h = eh;
    h[4] = 0;
    bcr.set(h, M.A.SYNC);
    done.header = true;
  }
  return done;
}
