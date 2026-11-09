// Core tests: framing, the cell record, the EC4 -> BCR32 mapping and import, and reads and
// writes against the mock BCR32. Runs in Deno or Node (test/run.js) and in the browser
// (test/index.html), as Lilypad's tests do.

import * as P from '../js/proto.js';
import * as M from '../js/model.js';
import { Store, diffChunks } from '../js/store.js';
import { Device } from '../js/device.js';
import { MockBcr32 } from '../js/mock.js';
import { History } from '../js/history.js';
import { demoImage, fakeNightShiftEc4 } from '../js/demo.js';
import * as I from '../js/import.js';
import * as B from '../js/bulk.js';
import { LiveLink } from '../js/live.js';
import * as E from '../js/ec4/model.js';
import { Device as Ec4Device } from '../js/ec4/device.js';
import { MockDevice as MockEc4 } from '../js/ec4/mock.js';
import { containerFromImage } from '../js/ec4/syx.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, msg = 'assertion failed') {
  if (!cond) throw new Error(msg);
}
function eq(a, b, what = 'value') {
  if (a !== b) throw new Error(`${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}
function eqBytes(a, b, what = 'bytes') {
  if (a.length !== b.length) throw new Error(`${what}: length ${a.length} != ${b.length}`);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(`${what}: differ at ${i}: ${a[i]} != ${b[i]}`);
}
async function throws(fn, re, what) {
  try {
    await fn();
  } catch (e) {
    if (re && !re.test(e.message)) throw new Error(`${what}: wrong error "${e.message}"`);
    return e;
  }
  throw new Error(`${what}: did not throw`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Waits until cond() holds (timers may be slow in a background tab), at most `ms`.
async function until(cond, ms = 3000) {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await sleep(2);
}
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const connect = (mock) => new Device(mock.transport());

// ---------------------------------------------------------------- framing

test('pack / unpack round trip, lengths 0-300', () => {
  const r = rng(1);
  for (let n = 0; n <= 300; n++) {
    const data = Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
    const packed = P.pack(data);
    eq(packed.length, P.packedLength(n), `packed length ${n}`);
    eq(P.unpackedLength(packed.length), n, `unpacked length ${n}`);
    assert(packed.every((b) => b < 0x80), 'packed bytes are 7-bit');
    eqBytes(P.unpack(packed, 0, n), data, `round trip ${n}`);
  }
});

test('checksum is the sum & 0x7F', () => {
  eq(P.checksum([]), 0);
  eq(P.checksum([0xFF, 0xFF]), (0x1FE) & 0x7F);
  eq(P.checksum([1, 2, 3, 0x80]), (6 + 0x80) & 0x7F);
});

test('numbers in 7-bit groups, 5-byte addresses', () => {
  eqBytes(P.encodeNum(0x0FFF, 5), [0, 0, 0, 0x1F, 0x7F], '0xFFF');
  eqBytes(P.encodeNum(256, 2), [2, 0], '256');
  eq(P.decodeNum(P.encodeNum(2 ** 34 + 12345, 5), 0, 5), 2 ** 34 + 12345, '35 bits');
});

test('host frames: READ, WRITE, SELECT, EDIT exact bytes', () => {
  eqBytes(P.host.read(2, 0x0400, 256), [0xF0, 0x7D, 0x42, 0x43, 0x52, 0x10, 2, 0, 0, 0, 0x08, 0x00, 2, 0, 0xF7], 'READ');
  eqBytes(P.host.write(0x10, [0x80, 0x41]), [0xF0, 0x7D, 0x42, 0x43, 0x52, 0x12, 2, 0, 0, 0, 0, 0x10, 0, 2, 0x01, 0x00, 0x41, 0x41, 0xF7], 'WRITE');
  eqBytes(P.host.select(3), [0xF0, 0x7D, 0x42, 0x43, 0x52, 0x22, 3, 0xF7], 'SELECT');
  const rec = Uint8Array.from({ length: 15 }, (_, k) => 0xF0 + k);
  const ed = P.host.edit(1, 40, rec);
  eq(ed.length, 6 + 2 + 18 + 1 + 1, 'EDIT length');
  const c = P.decodeCommand(ed);
  eq(c.page, 1);
  eq(c.cell, 40);
  eqBytes(c.record, rec, 'EDIT record');
  eqBytes(P.host.text(0, 2, ['Cut', null]), [0xF0, 0x7D, 0x42, 0x43, 0x52, 0x28, 0, 2, 2, 0x43, 0x75, 0x74, 0x20, 0, 0, 0, 0, 0xF7], 'TEXT');
});

test('device replies decode', () => {
  const info = Uint8Array.from({ length: 50 }, (_, k) => k * 5);
  const id = P.decodeReply(P.device.identify(1, 0, 23, info));
  assert(id.type === 'identify' && id.ok && id.fwMinor === 23 && id.proto === 1, 'identify');
  eqBytes(id.info, info, 'identify info');
  const rd = P.decodeReply(P.device.readReply(2, 0x0F00, Uint8Array.from([1, 0xFF, 3])));
  assert(rd.type === 'read' && rd.ok && rd.space === 2 && rd.addr === 0x0F00 && rd.len === 3 && rd.data[1] === 0xFF, 'read');
  const wr = P.decodeReply(P.device.writeReply(2, 0x123, 0));
  assert(wr.type === 'write' && wr.addr === 0x123 && wr.status === 0 && wr.space === 2, 'write');
  const st = P.decodeReply(P.device.state(1, 3));
  assert(st.type === 'state' && st.mode === 1 && st.page === 3, 'state');
  const tc = P.decodeReply(P.device.touch(2, 15, 1));
  assert(tc.type === 'touch' && tc.kind === 2 && tc.index === 15 && tc.page === 1, 'touch');
  const er = P.decodeReply(P.device.error(0x12, 1));
  assert(er.type === 'error' && er.cmd === 0x12 && er.code === 1, 'error');
  eq(P.decodeReply(Uint8Array.from([0xF0, 0x7D, 0x45, 0x43, 0x34, 0x21, 0, 0, 0xF7])), null, 'EC4 message is not ours');
});

test('WRITE: malformed is an error, bad checksum a status', () => {
  const good = P.host.write(0, [1, 2, 3]);
  const short = Uint8Array.from([...good.slice(0, -3), 0xF7]);
  eq(P.decodeCommand(short).error, 1, 'wrong length');
  eq(P.decodeCommand(P.host.write(0, new Uint8Array(257))).error, 1, 'longer than 256');
  const bad = Uint8Array.from(good);
  bad[bad.length - 2] ^= 1;
  const c = P.decodeCommand(bad);
  eq(c.error, undefined, 'no error');
  eq(c.status, P.WRITE_STATUS.CHECKSUM, 'checksum status');
});

// ---------------------------------------------------------------- the model

test('address map as the spec', () => {
  eq(M.cellAddr(0, 0), 0x0400);
  eq(M.cellAddr(1, 31), 0x0400 + 768 + 15 * 31);
  eq(M.cellAddr(2, M.keyCell(0)), 0x0400 + 768 * 2 + 480, 'key 1');
  eq(M.cellAddr(3, M.keyCell(15)) + 15, 0x0400 + 768 * 3 + 720, 'last key end');
  eq(M.syncAAddr(3, 31), 0x0100 + 64 * 3 + 62);
  eq(M.syncCAddr(2, 5), 0x0300 + 64 + 5);
  eq(M.pageNameAddr(3), 0x001C);
  assert(M.writable(0x0023) && !M.writable(0x0024) && !M.writable(0x0048) && M.writable(0x0047), 'header area');
  assert(!M.writable(0x0400 + 720) && !M.writable(0x0400 + 767) && M.writable(0x0400 + 768), 'spare bytes');
  assert(!M.writable(0x0380) && M.writable(0x037F), 'after table C');
});

test('a blank cell is off', () => {
  const img = M.blankImage();
  const c = M.readCell(img, 0, 0);
  assert(c.blank && c.enc.off && c.push.off && c.blankName && c.name === '', 'blank');
  eq(M.encoderSummary(c.enc), 'off');
  eq(M.pushSummary(c.push), 'off');
});

test('cell record round trip: every field', () => {
  const img = M.blankImage();
  const r = rng(7);
  for (let n = 0; n < 400; n++) {
    const p = Math.floor(r() * 4);
    const c = Math.floor(r() * 32);
    const type = Math.floor(r() * 9);
    const scale = Math.floor(r() * 9);
    const v = { channel: Math.floor(r() * 16), mode: Math.floor(r() * 10), link: c < 31 ? Math.floor(r() * 2) : 0, numberHigh: Math.floor(r() * 128) };
    M.setEncoder(img, p, c, 'type', type);
    M.setEncoder(img, p, c, 'scale', scale);
    for (const [f, x] of Object.entries(v)) M.setEncoder(img, p, c, f, x);
    const e0 = M.readCell(img, p, c).enc;
    const max = e0.hires ? M.HIRES_MAX : 127;
    const lower = Math.floor(r() * (e0.hires ? 4095 : 128));
    const upper = r() < 0.3 ? max : Math.floor(r() * (e0.hires ? 4095 : 128));
    const number = Math.floor(r() * (type === M.T.CCAH ? 32 : 128));
    M.setEncoder(img, p, c, 'lower', lower);
    M.setEncoder(img, p, c, 'upper', upper);
    M.setEncoder(img, p, c, 'number', number);
    M.setName(img, p, c, 'K' + n);
    const pv = { type: 1 + Math.floor(r() * 12), channel: Math.floor(r() * 16), mode: Math.floor(r() * 2), number: Math.floor(r() * 128), display: Math.floor(r() * 2), lower: Math.floor(r() * 128), upper: Math.floor(r() * 128), link: c < 31 ? Math.floor(r() * 2) : 0 };
    if (pv.type === M.PT.GRP) pv.channel &= 3;
    for (const [f, x] of Object.entries(pv)) M.setPush(img, p, c, f, x);
    const got = M.readCell(img, p, c);
    const e = got.enc;
    for (const [f, x] of Object.entries({ type, scale, ...v, lower: Math.min(lower, max), upper, number })) eq(e[f], x, `enc ${f} (${n})`);
    for (const [f, x] of Object.entries(pv)) eq(got.push[f], x, `push ${f} (${n})`);
    eq(got.name, ('K' + n).slice(0, 4), 'name');
    // the record decodes the same after a copy through bytes
    const rec = M.readRecord(img, p, c);
    const again = M.blankImage();
    M.writeRecord(again, 3 - p, c, rec);
    eqBytes(M.readRecord(again, 3 - p, c), rec, 'record copy');
  }
});

test('14-bit storage: 4095 is 16383, 7-bit uses the low 7 bits', () => {
  const r = Uint8Array.from([0x4F, 5, 0, 0x34, 0xFF, 0x31, 0xF2, 0, 32, 32, 32, 32, 0, 0, 0]);
  const e = M.decodeEncoder(r);
  assert(e.hires && e.type === M.T.CCAH && e.channel === 15, 'CCAh ch16');
  eq(e.lower, 0x234, 'lower');
  eq(e.upper, M.HIRES_MAX, 'upper 4095 -> 16383');
  r[0] = 0x2F; // CCAb: 7-bit
  const e7 = M.decodeEncoder(r);
  eq(e7.lower, 0x34);
  eq(e7.upper, 0x7F);
  r[0] = 0x5F; // PBnd, scale 127: 7-bit
  r[5] = 0x31;
  assert(!M.decodeEncoder(r).hires, 'PBnd 127 is 7-bit');
  r[5] = 0x33; // scale 1000: 14-bit
  assert(M.decodeEncoder(r).hires, 'PBnd 1000 is 14-bit');
});

test('clamps: types 9-15 off, modes > 9 Acc2, push types > 12 off', () => {
  const r = M.blankImage().slice(0, 15);
  for (let t = 9; t < 16; t++) {
    r[0] = t << 4;
    assert(M.decodeEncoder(r).off, `type ${t}`);
  }
  r[5] = 0xA1;
  eq(M.decodeEncoder(r).mode, 5, 'mode 10 -> Acc2');
  for (let t = 13; t < 16; t++) {
    r[7] = t << 4;
    assert(M.decodePush(r).off, `push type ${t}`);
  }
});

test('a key\'s push of type Set, Acc0, Acc3, LSp6, Min or Max is off (a key has no encoder)', () => {
  const img = M.blankImage();
  for (const t of [M.PT.SET, M.PT.ACC0, M.PT.ACC3, M.PT.LSP6, M.PT.MIN, M.PT.MAX]) {
    const r = M.blankImage().slice(0, 15);
    r[7] = t << 4;
    r[12] = 0;
    assert(!M.decodePush(r, false).off, `type ${t} on a knob's push plays`);
    const p = M.decodePush(r, true);
    assert(p.off && p.onKeyOff && p.type === t, `type ${t} on a key is off, the type kept`);
    M.writeRecord(img, 0, M.keyCell(1), r);
    assert(M.readCell(img, 0, M.keyCell(1)).push.off && !M.pushTypeOnKey(t), `readCell of key 2 says off (${t})`);
    eq(M.pushSummary(M.readCell(img, 0, M.keyCell(1)).push), 'off');
  }
  for (const t of [M.PT.NOTE, M.PT.CC, M.PT.PRGC, M.PT.PBND, M.PT.AFTT, M.PT.GRP]) assert(M.pushTypeOnKey(t), `type ${t} is a key's`);
});

test('switching 7/14 bits rescales the range; CCAh numbers 0-31', () => {
  const img = M.blankImage();
  M.setEncoder(img, 0, 3, 'type', M.T.CCAB);
  M.setEncoder(img, 0, 3, 'number', 100);
  let e = M.readCell(img, 0, 3).enc;
  assert(e.lower === 0 && e.upper === 127 && e.channel === 0, 'defaults from blank');
  M.setEncoder(img, 0, 3, 'type', M.T.CCAH);
  e = M.readCell(img, 0, 3).enc;
  assert(e.hires && e.upper === M.HIRES_MAX && e.lower === 0, '-> 14-bit');
  eq(e.number, 31, 'CCAh number clamped');
  M.setEncoder(img, 0, 3, 'upper', 2048);
  M.setEncoder(img, 0, 3, 'type', M.T.CCAB);
  eq(M.readCell(img, 0, 3).enc.upper, 16, '2048 -> 16');
  M.setEncoder(img, 0, 3, 'type', M.T.OFF);
  assert(M.readCell(img, 0, 3).enc.off, 'off again');
});

test('keys: push defaults, link not on the last knob or key, Grp pages 1-4', () => {
  const img = M.blankImage();
  M.setPush(img, 1, M.keyCell(2), 'type', M.PT.NOTE);
  const p = M.readCell(img, 1, M.keyCell(2)).push;
  assert(p.type === M.PT.NOTE && p.number === 38 && p.channel === 0 && p.mode === 0 && p.display === 1, 'key default');
  M.setPush(img, 1, M.keyCell(15), 'link', 1);
  eq(M.readCell(img, 1, M.keyCell(15)).push.link, 0, 'key 16 no link');
  M.setPush(img, 1, M.keyCell(14), 'type', M.PT.CC);
  M.setPush(img, 1, M.keyCell(14), 'link', 1);
  eq(M.readCell(img, 1, M.keyCell(14)).push.link, 1, 'key 15 links');
  M.setEncoder(img, 0, 31, 'type', M.T.CCAB);
  M.setEncoder(img, 0, 31, 'link', 1);
  eq(M.readCell(img, 0, 31).enc.link, 0, 'knob 32 no link');
  M.setPush(img, 0, 5, 'type', M.PT.CC);
  eq(M.readCell(img, 0, 5).push.number, 69, 'a knob\'s push: CC 64 + knob, clear of its own CC 25 and the 14-bit LSBs');
  M.setPush(img, 0, 5, 'channel', 9);
  M.setPush(img, 0, 5, 'type', M.PT.GRP);
  eq(M.readCell(img, 0, 5).push.channel, 0, 'Grp channel back to page 1');
  assert(!M.pushRules(M.readCell(img, 0, 5).push, 5).number.enabled, 'Grp has no number');
});

test('page outputs: FF is all three, toggles', () => {
  const img = M.blankImage();
  eq(M.readOutputs(img, 2), 7);
  M.toggleOutput(img, 2, 1);
  eq(img[0x22], 6, 'USB off');
  eq(M.outputsSummary(M.readOutputs(img, 2)), 'A B');
  M.toggleOutput(img, 2, 1);
  eq(img[0x22], 0xFF, 'all three stored as FF');
  M.setOutputs(img, 0, 0);
  eq(M.outputsSummary(M.readOutputs(img, 0)), 'none');
});

test('sync entries read, check and remove', () => {
  const img = demoImage();
  const h = M.readSyncHeader(img);
  assert(h.valid && h.format === 2 && h.version === 8 && h.dest === 1 && h.program === 16, 'header');
  eq(img[M.A.SYNC + 4], 0, 'header byte 4 is 0');
  eq(M.syncCount(img), 22, 'synced knobs');
  for (let p = 0; p < 4; p++) {
    for (let k = 0; k < 32; k++) {
      const s = M.readSync(img, p, k);
      if (s) eq(M.syncProblem(s, M.readCell(img, p, k).enc, h), null, `demo entry ${p}:${k}`);
    }
  }
  const tempo = M.readSync(img, 1, 0);
  assert(tempo.type === 3 && tempo.base === 60 && tempo.c === 0x07, 'tempo entry');
  const arng = M.readSync(img, 0, 9); // EC4 cell 6 of group 1: knob 10
  assert(arng.type === 2 && arng.n === 3 && arng.from === 1 && !arng.held, 'banded entry');
  M.setEncoder(img, 0, 9, 'type', M.T.CCR1);
  eq(M.syncProblem(arng, M.readCell(img, 0, 9).enc, h), 'needs CC', 'wrong kind');
  M.removeSync(img, 0, 9);
  eq(M.readSync(img, 0, 9), null, 'removed');
  eq(M.syncCount(img), 21);
});

test('history: undo and redo of cell edits', () => {
  const img = M.blankImage();
  const hist = new History(img);
  hist.record(() => M.setEncoder(img, 0, 0, 'type', M.T.CCAB));
  hist.record(() => M.setEncoder(img, 0, 0, 'number', 99));
  eq(M.readCell(img, 0, 0).enc.number, 99);
  hist.undo();
  eq(M.readCell(img, 0, 0).enc.number, 20, 'default CC of knob 1');
  hist.undo();
  assert(M.readCell(img, 0, 0).blank, 'blank again');
  hist.redo();
  hist.redo();
  eq(M.readCell(img, 0, 0).enc.number, 99, 'redone');
});

// ---------------------------------------------------------------- EC4 -> BCR32

test('mapping: groups 0-7 x cells 0-15 fill pages 1-4 exactly once', () => {
  const seen = new Set();
  for (let g = 0; g < 8; g++) {
    for (let i = 0; i < 16; i++) {
      const p = I.bcrPage(g);
      const k = I.bcrKnob(g, i);
      assert(k >= 0 && k < 32, 'knob range');
      seen.add(`${p}:${k}`);
    }
  }
  eq(seen.size, 128, 'distinct');
  eq(I.bcrKnob(0, 0), 0);
  eq(I.bcrKnob(0, 3), 3);
  eq(I.bcrKnob(0, 4), 8, 'second EC4 row');
  eq(I.bcrKnob(1, 0), 4, 'odd group: right half');
  eq(I.bcrKnob(1, 15), 31);
  eq(I.bcrKnob(4, 13), 25);
  eq(I.bcrPage(5), 2);
});

test('EC4 cell record matches controlfrog\'s layout', () => {
  const img = new Uint8Array(E.SIZE).fill(0xFF);
  const s = 14;
  const g = 3;
  const i = 9;
  const d = E.dataBase(s, g);
  for (let k = 0; k < 8; k++) img[d + 16 * k + i] = 0x10 + k;
  img.set([0x41, 0x42, 0x43, 0x44], E.encNameAddr(s, g, i));
  img[E.key1Base(s, g) + i] = 0x8C;
  img[E.key2Base(s, g) + i] = 0x85;
  img[E.key2Base(s, g) + 16 + i] = 0x7F;
  eqBytes(I.ec4CellRecord(img, s, g, i), [0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x41, 0x42, 0x43, 0x44, 0x8C, 0x85, 0x7F]);
});

// A Night Shift free knob in the EC4 image (CC 119 relative, no name, no push, no entry).
function freeInEc4(ec4, g, i, tables) {
  const synced = tables && (ec4[0x0600 + 32 * g + 2 * i] !== 0xFF || ec4[0x0601 + 32 * g + 2 * i] !== 0xFF);
  return I.isFreeKnob(I.ec4CellRecord(ec4, 14, g, i), synced);
}

function checkImport(bcr, ec4, groups, { tables = true, tableC = true } = {}) {
  let free = 0;
  for (const g of groups) {
    const p = I.bcrPage(g);
    for (let i = 0; i < 16; i++) {
      const k = I.bcrKnob(g, i);
      if (freeInEc4(ec4, g, i, tables)) {
        free++;
        assert(M.readCell(bcr, p, k).blank && !M.readSync(bcr, p, k), `a free knob is a blank cell g${g} i${i}`);
        continue;
      }
      eqBytes(M.readRecord(bcr, p, k), I.ec4CellRecord(ec4, 14, g, i), `cell g${g} i${i}`);
      const want = tables ? [ec4[0x0600 + 32 * g + 2 * i], ec4[0x0601 + 32 * g + 2 * i], ec4[0x0200 + 32 * g + 2 * i], ec4[0x0201 + 32 * g + 2 * i], tableC ? ec4[0x0400 + 16 * g + i] : 0xFF]
        : [0xFF, 0xFF, 0xFF, 0xFF, 0xFF];
      eqBytes([bcr[M.syncAAddr(p, k)], bcr[M.syncAAddr(p, k) + 1], bcr[M.syncBAddr(p, k)], bcr[M.syncBAddr(p, k) + 1], bcr[M.syncCAddr(p, k)]], want, `sync g${g} i${i}`);
    }
  }
  return free;
}

test('import: Night Shift\'s free knobs (CC 119 relative, nameless, no push) become blank cells', () => {
  const ec4 = fakeNightShiftEc4();
  const bcr = M.blankImage();
  I.applyImport(bcr, { img: ec4, hasTables: true, hasTableC: true }, [0, 1, 2]);
  const free = checkImport(bcr, ec4, [0, 1, 2]);
  eq(free, 48 - 10 - 8 - 5, 'the three pages\' 25 free knobs');
  let blank = 0;
  let rel119 = 0;
  for (let p = 0; p < 2; p++) for (let k = 0; k < 32; k++) {
    const c = M.readCell(bcr, p, k);
    if (c.blank) blank++;
    if (!c.enc.off && c.enc.type === M.T.CCR1 && c.enc.number === 119) rel119++;
  }
  eq(rel119, 0, 'no knob sends CC 119');
  eq(blank, 25 + 16, 'on pages 1 and 2: the 25 free knobs and page 2\'s right half are blank');
  // a free knob that has a sync entry, a name or a push is not free
  const r = I.ec4CellRecord(ec4, 14, 1, 15); // group 2's cell 16: free
  assert(I.isFreeKnob(r, false), 'group 2 cell 16 is free');
  assert(!I.isFreeKnob(r, true), 'with an entry it isn\'t');
  const named = Uint8Array.from(r);
  named.set([0x41, 0x42, 0x43, 0x44], 8);
  assert(!I.isFreeKnob(named, false), 'with a name it isn\'t');
  const pushed = Uint8Array.from(r);
  pushed[7] = (M.PT.CC << 4) | 0;
  assert(!I.isFreeKnob(pushed, false), 'with a push it isn\'t');
  // the demo image, built by the import: no CC 119 knobs either
  const demo = demoImage();
  for (let p = 0; p < 4; p++) for (let k = 0; k < 32; k++) {
    const e = M.readCell(demo, p, k).enc;
    assert(e.off || e.number !== 119 || e.type !== M.T.CCR1, `demo ${p}:${k}`);
  }
});

test('import: cells and tables A, B, C go with their knobs; the rest stays', () => {
  const ec4 = fakeNightShiftEc4();
  const bcr = M.blankImage();
  // other knobs already there: page 1 right half, pages 2-4
  for (let p = 0; p < 4; p++) for (let k = 0; k < 32; k++) M.setEncoder(bcr, p, k, 'type', M.T.CCAB);
  for (let p = 0; p < 4; p++) bcr[M.syncAAddr(p, 7)] = 0x10; // a stray entry
  const before = Uint8Array.from(bcr);
  const done = I.applyImport(bcr, { img: ec4, hasTables: true, hasTableC: true }, [0, 2]);
  eq(done.cells.length, 32);
  eqBytes(done.pages, [0, 1], 'pages');
  checkImport(bcr, ec4, [0, 2]);
  // the right halves of pages 1 and 2, and pages 3 and 4, are untouched
  for (let p = 0; p < 4; p++) {
    for (let k = 0; k < 32; k++) {
      if (p < 2 && (k & 7) < 4) continue;
      for (const a of M.cellAddrs(p, k)) eq(bcr[a], before[a], `untouched ${p}:${k} @${a}`);
    }
  }
  const h = bcr.slice(M.A.SYNC, M.A.SYNC + 8);
  eqBytes(h, [0x46, 0x48, 0x32, 2, 0, 8, 1, 16], 'header copied, byte 4 = 0');
  eq(M.pageName(bcr, 0), 'VOI1');
  eq(M.pageName(bcr, 1), 'CLK');
  eq(M.pageName(bcr, 2), '', 'page 3 name untouched');
  eq(bcr[M.A.OUTPUTS], 0xFF, 'imported page keeps FF');
  // the right half's name doesn't win over the left's
  const bcr2 = M.blankImage();
  I.applyImport(bcr2, { img: ec4, hasTables: true, hasTableC: true }, [1]);
  eq(M.pageName(bcr2, 0), 'LFO1', 'right half alone names the page');
});

test('import: scan finds the used groups', () => {
  const scan = I.scanEc4({ img: fakeNightShiftEc4(), hasTables: true });
  eqBytes(scan.groups.map((g) => (g.empty ? 0 : 1)), [1, 1, 1, 0, 0, 0, 0, 0], 'used groups');
  eq(scan.groups[0].synced, 10);
  eq(scan.groups[1].knobs, 8);
  eq(scan.groups[2].pushes, 2);
  eq(scan.setupName, 'FH-2');
  assert(scan.headerOk && scan.format === 2 && scan.beyond.length === 0, 'header, beyond');
});

test('import from a fake EC4 over Lilypad\'s device code', async () => {
  const ec4img = fakeNightShiftEc4();
  const mock = new MockEc4(ec4img, { fw: [0, 13], speed: 'fast' });
  const dev = new Ec4Device(mock.transport());
  let steps = 0;
  const src = await I.readEc4(dev, () => steps++);
  dev.close();
  eq(steps, I.ec4Pages().length, 'one READ per 64-byte page');
  assert(src.hasTables && src.hasTableC, 'tables');
  eq(mock.stats.writes, 0, 'nothing written to the EC4');
  const a = M.blankImage();
  const b = M.blankImage();
  I.applyImport(a, src, [0, 1, 2]);
  I.applyImport(b, { img: ec4img, hasTables: true, hasTableC: true }, [0, 1, 2]);
  eqBytes(a, b, 'same as from the image');
  checkImport(a, ec4img, [0, 1, 2]);
});

test('import from a controlfrog 0.12 EC4 leaves table C blank', async () => {
  const mock = new MockEc4(fakeNightShiftEc4(), { fw: [0, 12], speed: 'fast' });
  const dev = new Ec4Device(mock.transport());
  const src = await I.readEc4(dev);
  dev.close();
  assert(!src.hasTableC, 'no table C');
  const bcr = M.blankImage();
  I.applyImport(bcr, src, [0]);
  checkImport(bcr, src.img, [0], { tableC: false });
});

test('import from Lilypad .syx files: full dump and all setups', () => {
  const ec4 = fakeNightShiftEc4();
  const full = I.ec4FromSyx(containerFromImage(ec4, 0, 0x10000, { padding: 0 }), 'full.syx');
  assert(full.hasTables && full.hasTableC, 'full dump has the tables');
  const a = M.blankImage();
  I.applyImport(a, full, [0, 1, 2]);
  checkImport(a, ec4, [0, 1, 2]);
  const all = I.ec4FromSyx(containerFromImage(ec4, 0x0B00, 0x10000), 'all.syx');
  assert(!all.hasTables, 'all setups has no tables');
  const b = demoImage();
  const header = b.slice(M.A.SYNC, M.A.SYNC + 8);
  const done = I.applyImport(b, all, [3]);
  assert(!done.header, 'header not copied');
  eqBytes(b.slice(M.A.SYNC, M.A.SYNC + 8), header, 'header kept');
  checkImport(b, ec4, [3], { tables: false });
});

// ---------------------------------------------------------------- against the mock BCR32

test('connect: IDENTIFY, state, read the whole space in 256-byte READs', async () => {
  const img = demoImage();
  const mock = new MockBcr32(img, { speed: 'fast' });
  const dev = connect(mock);
  const id = await dev.identify();
  assert(id.proto === 1 && id.fwMajor === 0 && id.fwMinor === 23 && id.info[0] === 0x52, 'identify');
  const st = await dev.getState();
  assert(st.mode === 1 && st.page === 0, 'state');
  let steps = 0;
  const got = await dev.readAll(() => steps++);
  eq(steps, 16, '16 READs');
  eq(mock.stats.reads, 16);
  eqBytes(got, img, 'image');
  dev.close();
});

test('diff chunks: only changed writable bytes, joined over small gaps, at most 256', () => {
  const base = demoImage();
  const img = Uint8Array.from(base);
  img[0x0500] ^= 1;
  img[0x0504] ^= 1; // joined with 0x0500
  img[0x0600] ^= 1; // far: its own
  img[0x0030] ^= 1; // reserved: never written
  for (let a = 0x0B00; a < 0x0B00 + 600; a++) img[a] ^= 0x10; // a long run (crosses page 4's spare bytes)
  const chunks = diffChunks(img, base);
  assert(chunks.every((c) => c.data.length >= 1 && c.data.length <= 256), 'sizes');
  assert(chunks.every((c) => [...c.data].every((_, k) => M.writable(c.addr + k))), 'writable only');
  assert(!chunks.some((c) => c.addr <= 0x30 && c.addr + c.data.length > 0x30), 'reserved byte skipped');
  eq(chunks[0].addr, 0x0500);
  eq(chunks[0].data.length, 5, 'gap joined');
  eq(chunks[1].addr, 0x0600);
  const fixed = Uint8Array.from(base);
  for (const c of chunks) fixed.set(c.data, c.addr);
  for (let a = 0; a < M.SIZE; a++) if (M.writable(a)) eq(fixed[a], img[a], `byte ${a}`);
});

test('send: WRITE the changed ranges, RELOAD keeps them', async () => {
  const mock = new MockBcr32(demoImage(), { speed: 'fast' });
  const dev = connect(mock);
  await dev.identify();
  const store = new Store();
  store.fromDevice(await dev.readAll());
  M.setEncoder(store.img, 3, 10, 'type', M.T.CCAB);
  M.setName(store.img, 3, 10, 'NEW');
  M.writeName(store.img, M.pageNameAddr(3), 'FOUR');
  M.toggleOutput(store.img, 3, 4);
  for (let k = 0; k < 32; k++) M.setEncoder(store.img, 2, k, 'channel', 12); // spread over a page
  const chunks = store.deviceChunks();
  assert(chunks.length >= 3, 'several chunks');
  for (const c of chunks) {
    await dev.write(c.addr, c.data);
    store.written(c.addr, c.data);
  }
  eq(store.deviceChunks().length, 0, 'nothing left to write');
  assert(store.deviceDirtyBytes() > 0, 'but not stored yet');
  assert(M.readCell(mock.live, 3, 10).blank, 'not live before RELOAD');
  const st = await dev.reload();
  eq(st.mode, 1);
  store.committed();
  eq(store.deviceDirtyBytes(), 0, 'stored');
  eqBytes(mock.store, store.img, 'stored');
  eqBytes(mock.live, store.img, 'live');
  eq(mock.stats.writes, chunks.length);
  eq(M.readCell(mock.live, 3, 10).name, 'NEW');
  dev.close();
});

test('a RELOAD the BCR32 could not store answers 7F 24 04: live, not kept, still to send', async () => {
  const mock = new MockBcr32(demoImage(), { speed: 'fast' });
  const dev = connect(mock);
  await dev.identify();
  const store = new Store();
  store.fromDevice(await dev.readAll());
  M.setName(store.img, 1, 2, 'LIVE');
  mock.faults.reloadStatus = 4;
  for (const c of store.deviceChunks()) {
    await dev.write(c.addr, c.data);
    store.written(c.addr, c.data);
  }
  const e = await throws(() => dev.reload(), /could not be stored/, 'RELOAD');
  eq(e.code, 4, 'error code 4');
  eq(M.cellName(mock.live, 1, 2), 'LIVE', 'the controller plays it');
  assert(M.cellName(mock.store, 1, 2) !== 'LIVE', 'the store does not have it');
  store.reloadedUnkept();
  eq(M.cellName(store.live, 1, 2), 'LIVE', 'the editor knows what it plays');
  assert(store.deviceDirtyBytes() > 0, 'and that it is still to send');
  eq(store.deviceChunks().length, 0, 'nothing to write, only to store');
  mock.faults.reloadStatus = 0;
  await dev.reload();
  store.committed();
  eq(store.deviceDirtyBytes(), 0, 'stored at the second try');
  dev.close();
});

test('WRITE errors: status 1 and 2, malformed 7F 12 01', async () => {
  const mock = new MockBcr32(M.blankImage(), { speed: 'fast' });
  const dev = connect(mock);
  mock.faults.writeStatus = 1;
  await throws(() => dev.write(0x10, [0x41]), /bad range/, 'status 1');
  mock.faults.writeStatus = 0;
  const bad = P.host.write(0x10, [0x41]);
  bad[bad.length - 2] ^= 1;
  const replies = [];
  const t = mock.transport();
  t.onmessage = (b) => replies.push(P.decodeReply(b));
  t.send(bad);
  await until(() => replies.length >= 1);
  t.send(Uint8Array.from([...P.HEADER, 0x12, 2, 0, 0, 0, 0, 0x10, 0, 1, 0xF7]));
  await until(() => replies.length >= 2);
  assert(replies[0].type === 'write' && replies[0].status === 2, 'bad checksum -> status 2');
  assert(replies[1].type === 'error' && replies[1].cmd === 0x12 && replies[1].code === 1, 'malformed -> 7F 12 01');
  eq(mock.ram[0x10], 0xFF, 'nothing written');
  dev.close();
});

test('busy: the device retries a request the BCR32 answers 7F cmd 03', async () => {
  let n = 0;
  const t = {
    name: 'busy',
    onmessage: null,
    send(bytes) {
      const c = P.decodeCommand(bytes);
      n++;
      setTimeout(() => t.onmessage(n < 3 ? P.device.error(c.cmd, 3) : P.device.state(1, 2)), 1);
    },
  };
  const dev = new Device(t);
  const st = await dev.getState();
  eq(st.page, 2);
  eq(n, 3, 'two busy answers, then the reply');
});

test('live link: TOUCH and STATE events, EDIT for the page in view', async () => {
  const mock = new MockBcr32(demoImage(), { speed: 'fast' });
  const dev = connect(mock);
  const touches = [];
  const states = [];
  const errors = [];
  dev.addEventListener('touch', (e) => touches.push(e.detail));
  dev.addEventListener('state', (e) => states.push(e.detail));
  dev.addEventListener('deviceerror', (e) => errors.push(e.detail));
  await dev.touchEvents(true);
  mock.touch(0, 5, 1000);
  mock.touch(0, 5, 1100); // within 250 ms: dropped
  mock.touch(2, 15, 1100);
  mock.setPage(2);
  await until(() => touches.length >= 2 && states.some((s) => !s.solicited));
  eq(touches.length, 2, 'two touches');
  assert(touches[0].kind === 0 && touches[0].index === 5 && touches[0].page === 0, 'knob 6 turned');
  assert(touches[1].kind === 2 && touches[1].index === 15, 'key 16');
  const unsolicited = states.filter((s) => !s.solicited);
  assert(unsolicited.length === 1 && unsolicited[0].page === 2, 'page change event');
  const rec = M.readRecord(demoImage(), 2, 0);
  rec[8] = 0x58;
  await dev.edit(2, 0, rec);
  await dev.edit(1, 0, rec); // another page: 7F 2C 06, as the firmware answers (0.27 on)
  await dev.edit(2, 48, rec); // bad cell: 7F 2C 01
  await until(() => errors.length >= 2 && mock.edits.size >= 1);
  eqBytes(mock.record(0), rec, 'EDIT applied');
  eq(mock.edits.size, 1);
  assert(errors.length === 2 && errors.every((e) => e.cmd === 0x2C) && errors[0].code === 6 && errors[1].code === 1,
    'another page: 7F 2C 06; a bad cell: 7F 2C 01');
  await dev.select(2);
  eq(mock.edits.size, 1, 'SELECT of the page in view changes nothing: the edit stays');
  await dev.select(1);
  eq(mock.edits.size, 0, 'another page drops the edits');
  dev.close();
});

// What app.js's edit() does: one undo step, its addresses marked as the editor's own.
function edited(st, h, fn) {
  const step = h.record(fn);
  if (step) st.touch(step.changes.keys());
  return step;
}

test('store: a fresh read keeps only the bytes edited here', () => {
  const st = new Store();
  const h = new History(st.img);
  const dev = demoImage();
  eq(st.fromDevice(dev), 0, 'empty editor takes the device');
  eqBytes(st.img, dev);
  edited(st, h, () => M.setName(st.img, 0, 0, 'MINE'));
  eq(st.fromDevice(dev) > 0, true, 'edits kept');
  eq(M.cellName(st.img, 0, 0), 'MINE');
  assert(st.deviceDirtyBytes() > 0 && st.deviceDirtyBytes() <= 4, 'only the name is pending');
  st.revertToDevice();
  eq(st.deviceDirtyBytes(), 0, 'reverted');
});

test('store: content you never edited is never sent (another unit, a partial import)', () => {
  const st = new Store();
  const h = new History(st.img);
  st.fromDevice(demoImage()); // the demo, read
  edited(st, h, () => M.setName(st.img, 0, 1, 'ABCD')); // one edit
  const other = M.blankImage(); // then another, blank unit
  const kept = st.fromDevice(other);
  eq(kept > 0 && kept <= 4, true, `only the edited name is kept (${kept})`);
  for (const c of st.deviceChunks()) for (let a = c.addr; a < c.addr + c.data.length; a++) {
    const w = M.locate(a);
    assert(w.page === 0 && (w.cell === 1 || st.img[a] === other[a]), `nothing of the demo goes out (0x${a.toString(16)})`);
  }
  // an edit made before any read: only it survives the first read
  const st2 = new Store();
  const h2 = new History(st2.img);
  edited(st2, h2, () => M.setName(st2.img, 2, 0, 'NEW '));
  st2.fromDevice(demoImage());
  eq(M.cellName(st2.img, 2, 0), 'NEW', 'the edit stays');
  eq(M.cellName(st2.img, 0, 0), M.cellName(demoImage(), 0, 0), 'the rest is the device');
});

test('store: an opened file is kept whole; Send commits only after it is stored', () => {
  const st = new Store();
  const h = new History(st.img);
  const file = demoImage();
  edited(st, h, () => st.img.set(file));
  st.touchAll(); // as openFile does
  const dev = M.blankImage();
  st.fromDevice(dev);
  eqBytes(st.img, file, 'the file survives the connect');
  const chunks = st.deviceChunks();
  assert(chunks.length > 0, 'all of it to send');
  for (const c of chunks) st.written(c.addr, c.data);
  st.committed(); // RELOAD answered
  eq(st.touched.size, 0, 'nothing is the editor\'s own after a stored Send');
  const st3 = new Store();
  st3.fromDevice(dev);
  const h3 = new History(st3.img);
  edited(st3, h3, () => M.setName(st3.img, 0, 0, 'XYZ '));
  const c3 = st3.deviceChunks();
  for (const c of c3) st3.written(c.addr, c.data);
  // a Send whose RELOAD failed commits nothing: still to send, though nothing is left to write
  eq(st3.deviceDirtyBytes() > 0, true, 'pending until RELOAD answers');
  eq(st3.deviceChunks().length, 0, 'the RAM has it');
  st3.committed();
  eq(st3.deviceDirtyBytes(), 0, 'stored');
});

test('store: a Send that failed after a WRITE: the next Read keeps the stored bytes as the baseline', () => {
  const st = new Store();
  const h = new History(st.img);
  const unit = demoImage(); // the BCR32's store and RAM
  st.fromDevice(unit);
  edited(st, h, () => M.setName(st.img, 0, 0, 'MINE'));
  edited(st, h, () => M.setName(st.img, 2, 3, 'LATE'));
  const chunks = st.deviceChunks();
  eq(chunks.length, 2, 'two ranges');
  // the first WRITE answered, then the Send stopped (a timeout, a disconnect): the BCR32's RAM
  // holds it, its store doesn't
  const ram = Uint8Array.from(unit);
  ram.set(chunks[0].data, chunks[0].addr);
  st.written(chunks[0].addr, chunks[0].data);
  eq(st.unkeptBytes() > 0, true, 'written, not kept');
  // Read: the unit's RAM comes back with the written bytes
  const kept = st.fromDevice(ram);
  eq(M.cellName(st.img, 0, 0), 'MINE', 'the written name is in the image');
  eq(M.cellName(st.img, 2, 3), 'LATE', 'the unwritten edit is kept as an edit');
  eq(kept > 0, true, 'something kept');
  eq(M.cellName(st.dev, 0, 0), M.cellName(unit, 0, 0), 'the stored name is still the baseline');
  assert(st.deviceDirtyBytes() > 0 && st.isDeviceDirty(M.cellAddr(0, 0) + 8), 'the written name is still to send');
  const again = st.deviceChunks();
  eq(again.length, 1, 'only the unwritten range is left to write');
  eq(again[0].addr, chunks[1].addr);
  // Discard: back to the store's bytes; the RAM now differs from the image, so a Send writes
  // the stored bytes back before it RELOADs
  st.revertToDevice();
  eq(st.deviceDirtyBytes(), 0, 'nothing to store after a discard');
  eq(st.deviceChunks().length, 1, 'but the written range goes back to what the store holds');
  eq(st.deviceChunks()[0].addr, chunks[0].addr);
  // and once a RELOAD answers, everything is kept
  for (const c of st.deviceChunks()) st.written(c.addr, c.data);
  st.committed();
  eq(st.unkeptBytes(), 0, 'kept');
  eqBytes(st.dev, st.ram, 'store and RAM agree');
});

test('defaults: a blank knob switched to 14-bit gets the whole range; a note key its note off', () => {
  const img = M.blankImage();
  M.setEncoder(img, 0, 20, 'type', M.T.CCAH);
  const e = M.readCell(img, 0, 20).enc;
  eq(e.hires, true, '14-bit');
  eq(e.upper, M.HIRES_MAX, 'upper 16383');
  eq(e.lower, 0, 'lower 0');
  assert(e.number >= 1 && e.number <= 31, `MSB number 1-31 (${e.number})`);
  eq(e.mode, 4, 'Acc1');
  M.setEncoder(img, 0, 21, 'type', M.T.CCAB);
  const e7 = M.readCell(img, 0, 21).enc;
  eq(e7.upper, 127, '7-bit: 0-127');
  eq(e7.mode, 4, 'Acc1 too');
  M.setPush(img, 0, M.keyCell(3), 'type', M.PT.NOTE);
  const pu = M.readCell(img, 0, M.keyCell(3)).push;
  eq(pu.lower, 64, 'a note key sends its note off at velocity 64');
  M.setPush(img, 0, M.keyCell(4), 'type', M.PT.CC);
  eq(M.readCell(img, 0, M.keyCell(4)).push.lower, 0, 'a CC key: off value 0');
});

// ---- the review's open items (2026-11-09)

test('bulk: one field on every cell it applies to; fill channels and numbers ascending', () => {
  const img = M.blankImage();
  for (const c of [0, 1, 2, 3]) M.setEncoder(img, 1, c, 'type', M.T.CCAB);
  M.setEncoder(img, 1, 2, 'type', M.T.PBND); // no number
  eq(B.applyField(img, 1, [0, 1, 2, 3, 4], 'enc', 'channel', 9), 4, 'channel on the four knobs with an encoder (knob 5 is off)');
  assert([0, 1, 2, 3].every((c) => M.readCell(img, 1, c).enc.channel === 9) && M.readCell(img, 1, 4).enc.off, 'knob 5 left alone');
  M.setEncoder(img, 1, 0, 'channel', 14);
  eq(B.fill(img, 1, [0, 1, 2, 3], 'enc', 'channel'), 4);
  eq([0, 1, 2, 3].map((c) => M.readCell(img, 1, c).enc.channel).join(','), '14,15,0,1', 'channels 15, 16, 1, 2: wrapped');
  M.setEncoder(img, 1, 0, 'number', 126);
  eq(B.fill(img, 1, [0, 1, 2, 3], 'enc', 'number'), 3, 'numbers: PB has none');
  eq([0, 1, 3].map((c) => M.readCell(img, 1, c).enc.number).join(','), '126,127,0');
  M.setEncoder(img, 1, 5, 'type', M.T.CCAH);
  M.setEncoder(img, 1, 6, 'type', M.T.CCAH);
  M.setEncoder(img, 1, 5, 'number', 31);
  B.fill(img, 1, [5, 6], 'enc', 'number');
  eq(M.readCell(img, 1, 6).enc.number, 0, 'a 14-bit MSB wraps at 31');
  for (const j of [0, 1]) M.setPush(img, 1, M.keyCell(j), 'type', M.PT.CC);
  eq(B.applyField(img, 1, [M.keyCell(0), M.keyCell(1)], 'push', 'type', M.PT.ACC0), 0, 'no encoder push type on keys');
  eq(B.cellRange(30, 34).join(','), '30,31', 'a range from a knob stays on the knobs');
});

test('bulk: copy several cells, paste them from the first target on; one into many', () => {
  const img = M.blankImage();
  for (const c of [0, 1, 2]) (M.setEncoder(img, 0, c, 'type', M.T.CCAB), M.setEncoder(img, 0, c, 'number', 20 + c), M.setName(img, 0, c, `K${c}`));
  M.setEncoder(img, 0, 1, 'link', 1);
  const recs = B.copyCells(img, 0, [2, 0, 1]);
  eq(recs.length, 3);
  eqBytes(B.pasteCells(img, 2, [29], recs), [29, 30, 31], 'three from knob 30 on');
  eq(M.readCell(img, 2, 30).enc.number, 21);
  eq(M.readCell(img, 2, 31).name, 'K2');
  eq(B.pasteCells(img, 2, [30], recs).length, 2, 'as many as fit: knob 32 is the last');
  assert(!M.readCell(img, 2, 31).enc.link, 'no link on the last knob');
  eqBytes(B.pasteCells(img, 3, [4, 7, 9], [recs[0]]), [4, 7, 9], 'one into every target');
  assert([4, 7, 9].every((c) => M.readCell(img, 3, c).enc.number === 20), 'all knob 1\'s');
});

test('live link: edits of the page in view go by EDIT, again after a page change, back on drop', async () => {
  const mock = new MockBcr32(demoImage(), { speed: 'fast' });
  const dev = connect(mock);
  const info = await dev.identify();
  const store = new Store();
  store.fromDevice(await dev.readAll());
  const ctx = { conn: { dev, info }, devState: await dev.getState(), liveEdit: true, store };
  const live = new LiveLink(() => ctx);
  eq(ctx.devState.page, 0);
  M.setName(store.img, 0, 3, 'LIVE');
  M.setName(store.img, 1, 5, 'P2');
  await live.sync();
  await until(() => mock.edits.size >= 1);
  eq(mock.edits.size, 1, 'only the page in view');
  eq(M.readName(mock.record(3), 8).trimEnd(), 'LIVE', 'knob 4 plays the edit');
  await live.sync();
  eq(mock.stats.edits, 1, 'nothing sent twice');
  mock.setPage(1);
  ctx.devState = await dev.getState();
  live.reset();
  await live.sync();
  await until(() => mock.edits.has(5));
  eq(M.readName(mock.record(5), 8).trimEnd(), 'P2', 'page 2 plays its edit');
  await live.drop();
  await until(() => !mock.edits.size || M.readName(mock.record(5), 8).trimEnd() !== 'P2');
  assert(M.readName(mock.record(5), 8).trimEnd() !== 'P2', 'dropped: the stored cell plays again');
  ctx.liveEdit = false;
  M.setName(store.img, 1, 6, 'OFF');
  const before = mock.stats.edits;
  await live.sync();
  eq(mock.stats.edits, before, 'Play edits off: nothing sent');
  dev.close();
});

test('history: steps with the same key in quick succession merge; another key or a pause does not', () => {
  const img = M.blankImage();
  const hst = new History(img, { mergeMs: 1000 });
  hst.record(() => M.setName(img, 0, 0, 'A'), { key: 'n0', now: 0 });
  hst.record(() => M.setName(img, 0, 0, 'AB'), { key: 'n0', now: 500 });
  eq(hst.done.length, 1, 'typing merges');
  hst.record(() => M.setName(img, 0, 1, 'X'), { key: 'n1', now: 600 });
  hst.record(() => M.setName(img, 0, 0, 'ABC'), { key: 'n0', now: 700 });
  eq(hst.done.length, 3, 'another key in between: a step of its own');
  hst.record(() => M.setName(img, 0, 0, 'ABCD'), { key: 'n0', now: 5000 });
  eq(hst.done.length, 4, 'after a pause: a new step');
  hst.undo();
  hst.undo();
  hst.undo();
  hst.undo();
  eq(M.readCell(img, 0, 0).name, '', 'all undone');
  const a = M.cellAddr(0, 9);
  const was = img[a];
  hst.record(() => (img[a] = 0x21), { key: 'z', now: 9000 });
  hst.record(() => (img[a] = was), { key: 'z', now: 9100 });
  eq(hst.done.length, 0, 'a merge that puts everything back leaves no step');
});

test('store: an edit made while a Send runs stays the editor\'s own after RELOAD', () => {
  const store = new Store();
  store.fromDevice(demoImage());
  M.setName(store.img, 0, 0, 'SENT');
  store.touch(M.cellAddrs(0, 0));
  for (const c of store.deviceChunks()) store.written(c.addr, c.data);
  M.setName(store.img, 0, 1, 'LATE'); // meanwhile
  store.touch(M.cellAddrs(0, 1));
  store.committed();
  const data = Uint8Array.from(store.dev);
  store.fromDevice(data); // a Read
  eq(M.readCell(store.img, 0, 1).name, 'LATE', 'the late edit is kept');
  assert(store.deviceDirtyBytes() > 0, 'and still to send');
  eq(M.readCell(store.img, 0, 0).name, 'SENT');
});

test('sync: a band entry with table B byte 0 past 127 is not used (as the firmware)', () => {
  const img = M.blankImage();
  img.set([0x46, 0x48, 0x32, 2, 0, 1, 1, 1], M.A.SYNC);
  M.setEncoder(img, 0, 0, 'type', M.T.CCAB);
  const a = (2 << 12) | 0x100;
  img[M.syncAAddr(0, 0)] = a >> 8;
  img[M.syncAAddr(0, 0) + 1] = a & 0xFF;
  img[M.syncBAddr(0, 0)] = 0x85;
  img[M.syncBAddr(0, 0) + 1] = 0;
  const hd = M.readSyncHeader(img);
  const s = M.readSync(img, 0, 0);
  assert(M.syncProblem(s, M.readCell(img, 0, 0).enc, hd), 'bit 7 set: a problem');
  img[M.syncBAddr(0, 0)] = 0x05;
  eq(M.syncProblem(M.readSync(img, 0, 0), M.readCell(img, 0, 0).enc, hd), null, '5 bands: used');
});

// load(path) returns a file's bytes, or null (for optional local files; none needed now).
export async function runTests(load, report = console.log) {
  let failed = 0;
  let passed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      report(`ok   ${t.name}`);
    } catch (e) {
      failed++;
      report(`FAIL ${t.name}: ${e.message}`);
    }
  }
  report(`${passed} passed, ${failed} failed`);
  return failed;
}
