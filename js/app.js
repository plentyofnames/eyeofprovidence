// Eye of Providence: the UI. Derived from Lilypad's app.js (the Lilypad editor for the EC4):
// the same jobs, log, history, cell editor and demo panel, laid out for the BCR32's pages.

import * as M from './model.js';
import { Store, differs } from './store.js';
import { Device } from './device.js';
import { History } from './history.js';
import { MockBcr32 } from './mock.js';
import { demoImage, fakeNightShiftEc4 } from './demo.js';
import { midiAccess, midiPermission, portPairs, midiTransport, EC4_NAME, BCR32_NAME } from './midi.js';
import { hexdump, ERR_STORE } from './proto.js';
import * as I from './import.js';
import { Device as Ec4Device } from './ec4/device.js';
import { MockDevice as MockEc4 } from './ec4/mock.js';
import { h, $, replace, download } from './dom.js';

const MOCK_KEY = 'eye-mock-store';
const PREFS_KEY = 'eye-prefs';
const CLIP_KEY = 'eye-clip';
const MIN_FW = [0, 23];

const S = {
  store: new Store(),
  sel: { page: 0, cell: 0 },
  view: 'pages', // 'pages' | 'import'
  conn: null, // {dev, kind, name, info}
  devState: null, // {mode, page} as the BCR32 last said
  mock: null,
  job: null,
  message: null,
  log: [],
  flash: null, // {page, cell, t}
  imported: null, // {cells: Set('p:c'), text}
  imp: { src: null, scan: null, chosen: new Set(), ports: [], busy: false },
  sent: new Map(), // cell -> record (hex) sent with EDIT to the page in view
  prefs: { follow: true, liveEdit: true, showLog: false, showMock: true, mockSpeed: 'usb', lastPort: '', ec4Port: '' },
};

try {
  Object.assign(S.prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'));
} catch {}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(S.prefs));
  } catch {}
}

S.history = new History(S.store.img);

const img = () => S.store.img;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const range = (a, b) => Array.from({ length: b - a }, (_, k) => a + k);
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (s) => Uint8Array.from(s.match(/../g) || [], (x) => parseInt(x, 16));
const fwAtLeast = (info, [maj, min]) => info.fwMajor > maj || (info.fwMajor === maj && info.fwMinor >= min);

// ------------------------------------------------------------------ messages and log

function say(text, kind = 'info') {
  S.message = { text, kind, t: Date.now() };
  renderStatus();
}
function showError(e) {
  if (e?.name === 'AbortError' || e?.message === 'cancelled') return say('Cancelled.');
  if (e?.message === 'device closed') return;
  console.error(e);
  say(e?.message || String(e), 'error');
}

function logLine(dir, bytes, note) {
  const t = (performance.now() / 1000).toFixed(3).padStart(9);
  const arrow = dir === 'tx' ? '→' : dir === 'rx' ? '←' : '·';
  S.log.push(`${t} ${arrow} ${(note || '').padEnd(40)}${bytes ? ' | ' + hexdump(bytes, 24) : ''}`);
  if (S.log.length > 4000) S.log.splice(0, S.log.length - 4000);
  if (S.prefs.showLog) scheduleLogRender();
}
let logTimer = 0;
function scheduleLogRender() {
  if (!logTimer) logTimer = setTimeout(() => ((logTimer = 0), renderLog()), 100);
}

// ------------------------------------------------------------------ jobs (one at a time)

let chain = Promise.resolve();
function job(label, fn) {
  const run = async () => {
    const j = { label, done: 0, total: 0, t0: performance.now(), cancelled: false };
    S.job = j;
    renderAll();
    try {
      return await fn(j);
    } finally {
      S.job = null;
      renderAll();
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}
let progressTimer = 0;
function progress() {
  if (!progressTimer) progressTimer = setTimeout(() => ((progressTimer = 0), renderStatus()), 100);
}

// ------------------------------------------------------------------ edits

// Every change goes through here: one undo step each (typing a name merges by `key`). The
// first edit of a blank image gives it its header.
function edit(fn, { key = null, label = '', header = true } = {}) {
  const step = S.history.record(() => {
    fn();
    if (header) M.ensureHeader(img());
  }, { key, label });
  if (step) {
    S.store.touch(step.changes.keys());
    edited();
  }
  return step;
}
function edited() {
  S.store.loaded = true;
  scheduleRender();
  syncEdits();
}

let renderPending = 0;
function scheduleRender() {
  if (!renderPending) renderPending = setTimeout(() => ((renderPending = 0), renderAll()), 0);
}

// What waits to be sent, in plain words: "3 knobs, 1 key, page settings".
function changeSummary() {
  const st = S.store;
  if (!st.dev) return '';
  const cells = new Set();
  let other = false;
  for (let a = 0; a < M.SIZE; a++) {
    if (!st.isDeviceDirty(a)) continue;
    const w = M.locate(a);
    if (w.cell !== undefined) cells.add(w.page * 64 + w.cell); // a knob's FH-2 entry counts as the knob
    else other = true;
  }
  let knobs = 0;
  let keys = 0;
  for (const k of cells) (k % 64 < M.KNOBS ? knobs++ : keys++);
  return [knobs && plural(knobs, 'knob'), keys && plural(keys, 'key'), other && 'page settings'].filter(Boolean).join(', ');
}

const isDirty = (addr) => (S.store.dev ? S.store.isDeviceDirty(addr) : S.store.file ? M.writable(addr) && img()[addr] !== S.store.file[addr] : false);
const cellDirty = (p, c) => M.cellAddrs(p, c).some(isDirty);
const pageDirty = (p) => range(0, M.CELLS).some((c) => cellDirty(p, c)) || [M.pageNameAddr(p), M.pageNameAddr(p) + 1, M.pageNameAddr(p) + 2, M.pageNameAddr(p) + 3, M.A.OUTPUTS + p].some(isDirty);

// ---- live edits: the page the BCR32 shows plays the editor's cells before Send (EDIT, RAM only)

// Paced: 8 EDITs, then a GET_STATE round trip, so a burst (a page change, a connect that kept
// edits) never overruns the BCR32's SysEx input. The baseline is what the controller plays: the
// image as it last loaded it (store.live), not what a Send wrote into its RAM since.
let syncing = false;
let syncAgain = false;
async function syncEdits() {
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  try {
    do {
      syncAgain = false;
      const c = S.conn;
      if (!c?.info || !S.prefs.liveEdit || !S.devState || !S.store.dev) return;
      const p = S.devState.page;
      let n = 0;
      for (let cell = 0; cell < M.CELLS; cell++) {
        const rec = M.readRecord(img(), p, cell);
        const key = toHex(rec);
        const have = S.sent.get(cell) ?? toHex(M.readRecord(S.store.live ?? S.store.dev, p, cell));
        if (key === have) continue;
        S.sent.set(cell, key);
        c.dev.edit(p, cell, rec).catch(() => {});
        if (++n % 8 === 0) await c.dev.getState().catch(() => {});
        if (S.conn !== c || S.devState?.page !== p) {
          syncAgain = true; // the page changed meanwhile: start over on the new one
          break;
        }
      }
    } while (syncAgain);
  } finally {
    syncing = false;
  }
}

// The page in view plays the editor's cells only until it loads again, and a SELECT of the page
// in view doesn't load it again (0.24): before the link goes, or when Play edits is switched off,
// the records the controller holds go back by EDIT, cell by cell, so nothing unsent keeps playing.
async function dropLiveEdits(c = S.conn) {
  if (!c?.info || !S.devState || !S.store.dev || !S.sent.size) return;
  const p = S.devState.page;
  const base = S.store.live ?? S.store.dev;
  let n = 0;
  for (const [cell, hex] of S.sent) {
    const rec = M.readRecord(base, p, cell);
    if (toHex(rec) === hex) continue;
    c.dev.edit(p, cell, rec).catch(() => {});
    if (++n % 8 === 0) await c.dev.getState().catch(() => {});
  }
  S.sent.clear();
  if (n) await c.dev.getState().catch(() => {}); // the EDITs are in before anything after them
}

// ------------------------------------------------------------------ the demo BCR32

function getMock() {
  if (S.mock) return S.mock;
  let image = null;
  try {
    const b64 = localStorage.getItem(MOCK_KEY);
    if (b64) image = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    if (image && image.length !== M.SIZE) image = null;
  } catch {}
  setMock(image ?? demoImage());
  return S.mock;
}
function setMock(image) {
  const old = S.mock;
  S.mock = new MockBcr32(image, { speed: S.prefs.mockSpeed });
  if (old && S.conn?.kind === 'mock') disconnect(true);
  S.mock.onUpdate((what) => {
    if (what === 'store') saveMock();
    renderMock();
  });
  saveMock();
  renderMock();
}
function saveMock() {
  try {
    localStorage.setItem(MOCK_KEY, btoa(String.fromCharCode(...S.mock.store)));
  } catch {}
}

// ------------------------------------------------------------------ connection

async function refreshPorts() {
  const sel = $('#midiport');
  try {
    const pairs = portPairs(await midiAccess(), BCR32_NAME);
    const prev = sel.value || S.prefs.lastPort;
    replace(sel, pairs.length ? pairs.map((p) => h('option', { value: p.name }, p.name)) : h('option', { value: '' }, 'no MIDI ports'));
    if (pairs.some((p) => p.name === prev)) sel.value = prev;
    return pairs;
  } catch (e) {
    replace(sel, h('option', { value: '' }, 'no WebMIDI'));
    throw e;
  }
}

async function connect() {
  if (S.conn) return disconnect();
  const target = $('#target').value;
  let transport;
  try {
    if (target === 'mock') transport = getMock().transport();
    else {
      const pairs = await refreshPorts();
      const pair = pairs.find((p) => p.name === $('#midiport').value) || pairs[0];
      if (!pair) throw new Error('No MIDI port. Is the BCR32 plugged in?');
      transport = midiTransport(pair.in, pair.out);
    }
  } catch (e) {
    return showError(e);
  }
  const dev = new Device(transport, { log: logLine });
  S.conn = { dev, kind: target, name: transport.name, info: null };
  dev.addEventListener('state', onDeviceState);
  dev.addEventListener('touch', onDeviceTouch);
  // An EDIT can cross a page change on the BCR32: the new page's STATE resends it. Rotary Club
  // 0.27 says so as 7F 2C 06 (not the page in view): then ask which page it shows, in case that
  // STATE was missed.
  const what = { 0x10: 'a read', 0x12: 'a write', 0x20: 'a state request', 0x22: 'a page select', 0x24: 'storing', 0x26: 'touch events', 0x28: 'a text', 0x2A: 'clearing texts' };
  dev.addEventListener('deviceerror', (e) => {
    if (e.detail.cmd === 0x2C) {
      if (e.detail.code === 6) dev.getState().catch(() => {});
      return;
    }
    say(`The BCR32 refused ${what[e.detail.cmd] ?? 'a message'} (error ${e.detail.code}).`, 'error');
  });
  say(`Connecting to ${transport.name}…`);
  renderAll();
  try {
    const info = await dev.identify();
    if (info.proto !== 1) throw new Error(`${transport.name} speaks protocol ${info.proto}; this editor speaks 1.`);
    if (!fwAtLeast(info, MIN_FW)) {
      disconnect(true);
      return say(`${transport.name}: Rotary Club ${info.fwMajor}.${info.fwMinor}. Pages need ${MIN_FW.join('.')}.`, 'error');
    }
    S.conn.info = info;
    S.devState = await dev.getState();
    await dev.touchEvents(true);
    const data = await job('Reading', (j) => dev.readAll((k, n) => ((j.done = k), (j.total = n), progress())));
    S.store.forgetDevice(); // a fresh link: what its RAM and controller hold is read now
    const kept = S.store.fromDevice(data); // and kept as "as connected" for the session
    S.history.clear(); // the image is the BCR32's now (plus your edits): undo starts here
    S.sent.clear();
    if (target === 'midi') S.prefs.lastPort = transport.name;
    savePrefs();
    if (S.devState.mode === 1 && S.view === 'pages') S.sel.page = S.devState.page;
    say(kept ? `Connected: Rotary Club ${info.fwMajor}.${info.fwMinor}. Your edits are kept: ${changeSummary()} to send.`
      : `Connected: Rotary Club ${info.fwMajor}.${info.fwMinor}.`, 'ok');
    renderAll();
    syncEdits();
  } catch (e) {
    const msg = e.name === 'TimeoutError' ? `No reply from ${transport.name}. Is Rotary Club running on it?` : e.message;
    disconnect(true);
    say(msg, 'error');
  }
}

async function disconnect(force = false) {
  const conn = S.conn;
  if (!conn) return;
  if (S.job) S.job.cancelled = true;
  if (!force && conn.info) {
    try {
      // the unit stops playing the unsent edits, then touch events go off
      await Promise.race([dropLiveEdits(conn).then(() => conn.dev.touchEvents(false)), sleep(1500)]);
    } catch {}
  }
  conn.dev.close();
  S.conn = null;
  S.devState = null;
  S.sent.clear();
  renderAll();
  if (!force) say(S.store.deviceDirtyBytes() ? 'Disconnected. Unsent edits stay here.' : 'Disconnected.');
}

function onDeviceState(e) {
  const { mode, page, solicited } = e.detail;
  const moved = !S.devState || page !== S.devState.page || mode !== S.devState.mode;
  S.devState = { mode, page };
  // A page loaded on the BCR32 drops the RAM edits: send them again.
  if (moved || !solicited) {
    S.sent.clear();
    syncEdits();
  }
  if (!solicited && S.prefs.follow && mode === 1 && S.view === 'pages' && page < M.PAGES && !typing()) S.sel.page = page;
  renderAll();
}

// Something is being typed or picked: Follow leaves the selection alone, so the keystrokes
// can't land in another page's name box (the page name sits in #main, not the inspector).
function typing() {
  const a = document.activeElement;
  if (!a) return false;
  if (a.tagName === 'SELECT' || a.tagName === 'TEXTAREA') return true;
  return a.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'file', 'range', 'submit'].includes(a.type);
}

function onDeviceTouch(e) {
  const { kind, index, page } = e.detail;
  const cell = kind === 2 ? M.keyCell(index) : index;
  if (page >= M.PAGES || kind > 2 || index >= (kind === 2 ? M.KEYS : M.KNOBS)) return;
  S.flash = { page, cell, t: performance.now() };
  if (S.prefs.follow && S.view === 'pages' && !typing()) S.sel = { page, cell };
  renderAll();
  setTimeout(() => {
    if (S.flash && performance.now() - S.flash.t >= 590) {
      S.flash = null;
      document.querySelectorAll('.cell.flash').forEach((c) => c.classList.remove('flash'));
    }
  }, 600);
}

// ------------------------------------------------------------------ device actions

async function send() {
  if (!S.conn?.info) return;
  return job('Sending', async (j) => {
    const st = S.store;
    const chunks = st.deviceChunks();
    if (!chunks.length && !st.deviceDirtyBytes()) return say('Nothing to send: the BCR32 has it all.', 'ok');
    const what = changeSummary();
    j.total = chunks.length;
    const t0 = performance.now();
    // Written into the BCR32's RAM first (st.written); only RELOAD makes it use and keep them.
    // Until RELOAD answers 21, nothing counts as stored: a Cancel or an error leaves the written
    // bytes to send (and a Read meanwhile keeps the stored bytes as their baseline), and the next
    // Send writes what the RAM doesn't hold yet, or just RELOADs.
    for (const c of chunks) {
      if (j.cancelled) throw new Error('Send cancelled: nothing stored.');
      if (!S.conn) throw new Error('BCR32 disconnected: nothing stored.');
      try {
        await S.conn.dev.write(c.addr, c.data);
      } catch (e) {
        logLine('!', null, e.message);
        throw new Error(j.cancelled ? 'Send cancelled: nothing stored.' : 'Send stopped: nothing stored. Send again.');
      }
      st.written(c.addr, c.data);
      j.done++;
      progress();
    }
    j.label = 'Storing';
    try {
      S.devState = await S.conn.dev.reload();
    } catch (e) {
      logLine('!', null, e.message);
      if (e.code === ERR_STORE) {
        // 7F 24 04: the BCR32 plays the image now, but could not keep it (no store, a flash
        // error): not stored, so it stays to send
        st.reloadedUnkept();
        S.sent.clear();
        throw new Error(`Sent ${what}, but the BCR32 could not store it (no store, or a flash error). It plays it until power-off. Still to send.`);
      }
      throw new Error('No reply while storing. Send again.');
    }
    st.committed();
    S.sent.clear(); // RELOAD drops the RAM edits; the image has them now
    syncEdits();
    say(`Sent ${what} (${((performance.now() - t0) / 1000).toFixed(1)} s). Stored.`, 'ok');
  });
}

async function reread() {
  if (!S.conn?.info) return;
  await job('Reading', async (j) => {
    const data = await S.conn.dev.readAll((k, n) => ((j.done = k), (j.total = n), progress()));
    const kept = S.store.fromDevice(data);
    S.history.clear();
    S.sent.clear();
    syncEdits();
    say(kept ? `Read. Your edits stay: ${changeSummary()} to send.` : 'Read.', 'ok');
  }).catch(showError);
}

function discard() {
  const base = S.store.dev ?? S.store.file;
  if (!base) return;
  if (edit(() => img().set(base), { label: 'discard', header: false })) say(`Back to ${S.store.dev ? 'the BCR32' : S.store.fileName}. ⌘Z brings the edits back.`);
}

// The image the BCR32 had when the session connected, as an edit (so it goes back to the unit
// with Send, and ⌘Z undoes it): a Send is reversible even once the history is gone.
function asConnected() {
  const c = S.store.connected;
  if (!c) return;
  if (edit(() => img().set(c), { label: 'as connected', header: false })) say(`Back to the image the BCR32 had when you connected: ${changeSummary() || 'nothing'} to send. ⌘Z brings the edits back.`);
}

// ------------------------------------------------------------------ files

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function saveBytes(bytes, name) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'BCR32 pages', accept: { 'application/octet-stream': ['.bin'] } }] });
      const w = await handle.createWritable();
      await w.write(bytes);
      await w.close();
      return handle.name;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('cancelled');
      if (e.name !== 'SecurityError' && e.name !== 'NotAllowedError') throw e;
    }
  }
  download(bytes, name);
  return name;
}

async function save() {
  try {
    const name = await saveBytes(Uint8Array.from(img()), S.store.fileName || `BCR32_pages_${today()}.bin`);
    S.store.markSaved(name);
    say(`Saved ${name} (4 KB).`, 'ok');
    renderAll();
  } catch (e) {
    showError(e);
  }
}

async function openFile(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  if (/\.syx$/i.test(file.name) || data[0] === 0xF0) return importSyx(file, data);
  if (data.length !== M.SIZE) return say(`${file.name}: ${data.length} bytes; a backup is 4096.`, 'error');
  edit(() => img().set(data), { label: 'open ' + file.name });
  S.store.touchAll(); // the whole file is what you want, not only the bytes it changed here
  S.store.file = Uint8Array.from(data);
  S.store.fileName = file.name;
  S.store.loaded = true;
  S.view = 'pages';
  const n = S.store.deviceDirtyBytes();
  say(`Opened ${file.name}${M.hasHeader(data) || M.isBlank(data) ? '' : ' (no BCRC header)'}${S.conn?.info && n ? `: ${changeSummary()} to send` : ''}.`, 'ok');
  renderAll();
}

// ------------------------------------------------------------------ import (Night Shift's pages)

function openImport() {
  S.view = 'import';
  renderAll();
  // List the ports only if Chrome allows MIDI already: opening the view asks nothing.
  midiPermission().then((p) => p === 'granted' && refreshEc4Ports()).catch(() => {});
}

async function refreshEc4Ports() {
  const pairs = portPairs(await midiAccess(), EC4_NAME);
  S.imp.ports = pairs.map((p) => p.name);
  renderMain();
  return pairs;
}

function setSource(src) {
  S.imp.src = src;
  S.imp.scan = I.scanEc4(src);
  S.imp.chosen = new Set(S.imp.scan.groups.filter((g) => !g.empty).map((g) => g.g));
  renderAll();
}

async function readEc4From(makeDevice, label) {
  if (S.imp.busy) return;
  S.imp.busy = true;
  let dev = null;
  try {
    await job(label, async (j) => {
      dev = await makeDevice();
      S.imp.dev = dev; // Cancel aborts this one, not the BCR32's
      const info = await dev.identify({ busyMs: 4000 });
      j.label = `Reading EC4 (controlfrog ${info.fwMajor}.${info.fwMinor})`;
      const src = await I.readEc4(dev, (k, n) => {
        if (j.cancelled) throw new Error('cancelled');
        j.done = k;
        j.total = n;
        progress();
      });
      setSource(src);
      say(`Read the EC4's setup 15: ${plural(S.imp.scan.groups.filter((g) => !g.empty).length, 'page')}.`, 'ok');
    });
  } catch (e) {
    showError(e.name === 'TimeoutError' ? new Error('No reply from the EC4. Is controlfrog running, and Lilypad closed?') : e);
  } finally {
    dev?.close();
    S.imp.dev = null;
    S.imp.busy = false;
    renderAll();
  }
}

async function readEc4Port() {
  const name = $('#ec4port')?.value || S.prefs.ec4Port;
  await readEc4From(async () => {
    const pairs = await refreshEc4Ports();
    // The chosen port, else the first one named like an EC4; never just any port.
    const pair = pairs.find((p) => p.name === name) || pairs.find((p) => EC4_NAME.test(p.name));
    if (!pair) throw new Error(pairs.length ? 'Pick the EC4\'s port.' : 'No MIDI port for the EC4.');
    if (S.conn?.kind === 'midi' && pair.name === S.conn.name) throw new Error(`${pair.name} is the BCR32's port.`);
    S.prefs.ec4Port = pair.name;
    savePrefs();
    return new Ec4Device(midiTransport(pair.in, pair.out), { log: logLine });
  }, 'Connecting to the EC4');
}

function readDemoEc4() {
  return readEc4From(async () => new Ec4Device(new MockEc4(fakeNightShiftEc4(), { fw: [0, 13], speed: S.prefs.mockSpeed === 'fast' ? 'fast' : 'real' }).transport(), { log: logLine }), 'Reading the demo EC4');
}

function importSyx(file, data) {
  try {
    setSource(I.ec4FromSyx(data, file.name));
    S.view = 'import';
    renderAll();
    say(`${file.name}: ${S.imp.src.hasTables ? 'cells and FH-2 tables' : 'cells only (no FH-2 tables in this file)'}.`, 'ok');
  } catch (e) {
    say(`${file.name}: ${e.message}`, 'error');
  }
}

function doImport() {
  const { src, chosen } = S.imp;
  if (!src || !chosen.size) return;
  const groups = [...chosen].sort((a, b) => a - b);
  let done = null;
  edit(() => (done = I.applyImport(img(), src, groups)), { label: 'import' });
  if (!done) return;
  const halves = groups.map((g) => `${g + 1} → ${I.halfName(g)}`).join(', ');
  const text = `Imported groups ${halves}${done.header ? '; FH-2 header' : src.hasTables ? '' : '; no FH-2 tables'}.`;
  S.imported = { cells: new Set(done.cells), text };
  S.view = 'pages';
  S.sel = { page: done.pages[0] ?? 0, cell: S.sel.cell };
  say(`${text} ⌘Z undoes it.`, 'ok');
  renderAll();
}

// ------------------------------------------------------------------ copy / paste of a cell

function getClip() {
  try {
    const c = JSON.parse(localStorage.getItem(CLIP_KEY) || 'null');
    if (c?.eye === 1 && /^[0-9a-f]{30}$/.test(c.rec)) return { rec: fromHex(c.rec), from: c.from };
  } catch {}
  return S.clip || null;
}
function copyCell() {
  const { page: p, cell: c } = S.sel;
  const clip = { rec: M.readRecord(img(), p, c), from: `${M.cellLabel(c)}, page ${p + 1}` };
  S.clip = clip;
  try {
    localStorage.setItem(CLIP_KEY, JSON.stringify({ eye: 1, rec: toHex(clip.rec), from: clip.from }));
  } catch {}
  say(`Copied ${clip.from}.`, 'ok');
  renderInspector();
}
function pasteCell() {
  const clip = getClip();
  if (!clip) return;
  const { page: p, cell: c } = S.sel;
  edit(() => {
    const r = Uint8Array.from(clip.rec);
    if (c === M.KNOBS - 1 || c === M.CELLS - 1) {
      r[1] = r[1] === 0xFF ? 0xFF : r[1] & 0x7F; // no link on the last knob or key
      r[14] = r[14] === 0xFF ? 0xFF : r[14] & 0x7F;
    }
    M.writeRecord(img(), p, c, r);
  }, { label: 'paste' });
  say(`Pasted ${clip.from} into ${M.cellLabel(c)}.`, 'ok');
}

// ------------------------------------------------------------------ undo / redo

function undoRedo(redo) {
  const step = redo ? S.history.redo() : S.history.undo();
  if (!step) return;
  S.store.touch(step.changes.keys());
  const where = M.locate(step.changes.keys().next().value);
  if (where.page !== undefined && S.view === 'pages') {
    S.sel.page = where.page;
    if (where.cell !== undefined) S.sel.cell = where.cell;
  }
  say(`${redo ? 'Redid' : 'Undid'} ${step.label || 'edit'}.`);
  edited();
}

// ------------------------------------------------------------------ rendering

function renderAll() {
  renderToolbar();
  renderMain();
  renderInspector();
  renderStatus();
  renderMock();
}

function renderToolbar() {
  const c = S.conn;
  const busy = !!S.job;
  const info = c?.info;
  const n = S.store.deviceDirtyBytes();
  $('#connect').textContent = c ? 'Disconnect' : 'Connect';
  $('#target').disabled = !!c;
  $('#midiport').hidden = $('#target').value !== 'midi';
  $('#midiport').disabled = !!c;
  const chip = $('#devinfo');
  chip.className = 'chip ' + (info ? 'on' : c ? 'wait' : '');
  chip.textContent = info ? `${c.name} · ${info.fwMajor}.${info.fwMinor}` : c ? 'connecting…' : S.store.fileName ? 'offline · ' + S.store.fileName : 'offline';
  const send = $('#send');
  send.disabled = !info || busy || !n;
  send.textContent = 'Send';
  send.title = info && n ? `Write ${changeSummary()} to the BCR32 and store them` : 'Write the changes to the BCR32 and store them';
  $('#reread').disabled = !info || busy;
  $('#undo').disabled = !S.history.canUndo;
  $('#redo').disabled = !S.history.canRedo;
  $('#discard').disabled = busy || !(S.store.dev ?? S.store.file) || !(S.store.dev ? n : S.store.unsaved());
  $('#asconnected').disabled = busy || !S.store.connected || !differs(img(), S.store.connected);
  $('#asconnected').hidden = !S.store.connected;
  $('#save').disabled = busy || !S.store.loaded;
  $('#import').classList.toggle('on', S.view === 'import');
  document.body.classList.toggle('connected', !!info);
}

function renderMain() {
  const main = $('#main');
  if (S.view === 'import') return replace(main, importView());
  if (!S.store.loaded && !S.conn) return replace(main, welcome());
  replace(main, pageBar(), h('div', { class: 'knobs', id: 'knobs' }, range(0, M.KNOBS).map((c) => cellBox(S.sel.page, c))),
    h('div', { class: 'keys-head' }, h('span', {}, 'Keys'), S.imported ? importedNote() : null),
    h('div', { class: 'keys', id: 'keys' }, range(0, M.KEYS).map((j) => cellBox(S.sel.page, M.keyCell(j)))));
}

function HEXAGRAM() {
  const el = h('span', { class: 'hexa' });
  el.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2L28.12 23L3.88 9L16 30L28.12 9L3.88 23Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="16" cy="16" r="1.8" fill="currentColor"/></svg>';
  return el;
}

function welcome() {
  const go = (fn) => () => fn();
  return h('div', { class: 'welcome' },
    HEXAGRAM(),
    h('h2', {}, 'Eye of Providence'),
    h('p', { class: 'lead' }, 'Pages for the BCR32 running Rotary Club.'),
    h('div', { class: 'welcome-actions' },
      h('button', { class: 'primary', onclick: go(() => (($('#target').value = 'mock'), connect())) }, 'Demo BCR32'),
      h('button', { onclick: go(() => (($('#target').value = 'midi'), renderToolbar(), connect())) }, S.prefs.lastPort ? `Connect ${S.prefs.lastPort}` : 'Connect BCR32'),
      h('button', { onclick: go(openImport) }, 'Import Night Shift'),
      h('button', { onclick: go(() => $('#fileinput').click()) }, 'Open .bin'),
      h('button', { onclick: go(() => ((S.store.loaded = true), renderAll())) }, 'Start blank')),
    h('p', { class: 'hint' }, 'Chrome or Edge. Unofficial; not made by Behringer.'));
}

// ---- the page bar: tabs, name, outputs, FH-2 header

function pageBar() {
  const p = S.sel.page;
  const dev = S.devState;
  const tabs = h('div', { class: 'tabs pages' }, range(0, M.PAGES).map((q) =>
    h('button', { class: (q === p ? 'on' : '') + (pageDirty(q) ? ' dirty' : ''), onclick: () => selectPage(q), title: `Page ${q + 1} (T${q + 1})` },
      h('b', {}, q + 1), ' ', h('span', { class: 'nm' }, M.pageName(img(), q) || '····'),
      dev?.mode === 1 && dev.page === q ? h('span', { class: 'devmark', title: 'the BCR32 shows this page' }, '◂') : null)));
  const outs = M.readOutputs(img(), p);
  const outputs = h('div', { class: 'seg outs', title: 'Where this page\'s MIDI goes' },
    M.OUTPUTS.map((o) => h('button', { class: outs & o.bit ? 'on' : '', title: o.label, onclick: () => edit(() => M.toggleOutput(img(), p, o.bit), { label: `page ${p + 1} ${o.label}` }) }, o.short)));
  const hd = M.readSyncHeader(img());
  const n = M.syncCount(img());
  const sync = hd.valid ? `FH-2 sync · ${['', 'USB', 'DIN', 'both'][hd.dest] ?? 'USB'} · scenes on ${hd.program >= 1 && hd.program <= 16 ? 'PC ch ' + hd.program : 'no PC'} · ${plural(n, 'knob')}`
    : hd.blank ? (n ? `FH-2: no header · ${plural(n, 'entry')}` : 'FH-2: none') : `FH-2: header ${toHex(hd.bytes.slice(0, 4))}?`;
  return h('div', { class: 'pagebar' },
    tabs,
    h('div', { class: 'pagerow' },
      h('label', { class: 'pname' }, 'Name ', nameInput('pagename', M.pageName(img(), p), (v) => edit(() => M.writeName(img(), M.pageNameAddr(p), v), { key: 'pagename' + p, label: `page ${p + 1} name` }), false, '····')),
      h('span', { class: 'lbl' }, 'Out'), outputs,
      h('span', { class: 'sync' + (hd.valid ? ' on' : ''), title: hd.valid ? `header ${toHex(hd.bytes)}` : '' }, sync),
      hd.valid || n ? h('button', { class: 'small', title: 'Remove the FH-2 sync from every page (undoable)', onclick: removeAllSync }, 'Remove FH-2 (all pages)') : null,
      // a page change loads the page on the BCR32, which drops the played edits: its STATE
      // (onDeviceState) sends them again; the page already in view stays as it is
      S.conn?.info ? h('button', { class: 'small', title: 'Show this page on the BCR32', onclick: () => S.conn.dev.select(p).catch(showError) }, 'Show on BCR32') : null));
}

function selectPage(q) {
  S.sel.page = q;
  renderAll();
}

function removeAllSync() {
  edit(() => {
    img().fill(0xFF, M.A.SYNC, M.A.SYNC + 8);
    for (let p = 0; p < M.PAGES; p++) for (let k = 0; k < M.KNOBS; k++) M.removeSync(img(), p, k);
  }, { label: 'remove FH-2 sync' });
  say('FH-2 sync removed. ⌘Z brings it back.');
}

function importedNote() {
  return h('span', { class: 'impnote' }, S.imported.text, ' ', h('button', { class: 'small', onclick: () => ((S.imported = null), renderAll()) }, 'Hide marks'));
}

// ---- the knob and key boxes

function cellBox(p, c) {
  const cell = M.readCell(img(), p, c);
  const key = M.isKey(c);
  const e = cell.enc;
  const pu = cell.push;
  const hd = M.readSyncHeader(img());
  const sync = key ? null : M.readSync(img(), p, c);
  const problem = sync ? M.syncProblem(sync, e, hd) : null;
  const flash = S.flash && S.flash.page === p && S.flash.cell === c ? ' flash' : '';
  const off = key ? pu.off : e.off && pu.off;
  const cls = `cell ${key ? 'key' : 'knob'} ${!key && !e.off ? 'tc' + e.type : key && !pu.off ? 'tp' : 'toff'}` + (c === S.sel.cell ? ' sel' : '') + flash
    + (cellDirty(p, c) ? ' dirty' : '') + (S.imported?.cells.has(`${p}:${c}`) ? ' imp' : '') + (off ? ' off' : '');
  const badges = [
    !key && e.link && !e.off ? h('span', { class: 'link', title: 'linked to the next knob' }, '⟶') : null,
    sync ? h('span', { class: 'fh2' + (problem ? ' bad' : ''), title: problem ? `FH-2 entry not used: ${problem}` : `FH-2 sync: ${M.syncSummary(sync)}` }, 'FH2') : null,
  ];
  const idx = key ? c - M.KNOBS + 1 : c + 1;
  const body = key
    ? keySummary(pu).map((t, k) => h('div', { class: k ? 'psum' : 'sum' }, t))
    : [h('div', { class: 'sum' }, M.encoderSummary(e)), !pu.off ? h('div', { class: 'psum' }, h('span', { class: 'pico' }, '●'), ' ', M.pushSummary(pu)) : null];
  const full = key ? M.pushSummary(pu) : M.encoderSummary(e) + (pu.off ? '' : ` · push: ${M.pushSummary(pu)}`);
  return h('div', { class: cls, dataset: { c: String(c) }, onmousedown: (ev) => ev.button === 0 && selectCell(c), title: `${M.cellLabel(c)}: ${full}` },
    h('div', { class: 'line1' }, h('span', { class: 'idx' }, idx), h('span', { class: 'nm' }, cell.name || (off ? '' : '····')), h('span', { class: 'badges' }, badges)),
    body);
}

// A key's push in two short lines: what it sends, then the channel and mode.
function keySummary(pu) {
  if (pu.off) return ['off'];
  const ch = `ch${pu.channel + 1}${pu.mode && pu.type <= M.PT.AFTT ? ' tgl' : ''}`;
  switch (pu.type) {
    case M.PT.NOTE:
      return [`Note ${M.noteName(pu.number)}`, ch];
    case M.PT.CC:
      return [`CC #${pu.number}`, ch];
    case M.PT.PRGC:
      return [`PrgC ${pu.number}`, ch];
    case M.PT.PBND:
    case M.PT.AFTT:
      return [M.PUSH_TYPES[pu.type].short, ch];
    default:
      return [M.pushSummary(pu)];
  }
}

function selectCell(c) {
  if (S.sel.cell === c) return;
  S.sel.cell = c;
  for (const el of document.querySelectorAll('#main .cell')) el.classList.toggle('sel', Number(el.dataset.c) === c);
  renderInspector();
}

// ---- inspector (Lilypad's cell editor)

function nameInput(key, value, onInput, disabled, placeholder) {
  return h('input', {
    type: 'text', class: 'name', maxlength: 4, spellcheck: false, value: value.replace(/ +$/, ''), placeholder, disabled, dataset: { key },
    title: 'Up to 4 characters',
    onfocus: (ev) => {
      const el = ev.target;
      if (el.dataset.restoring) return;
      el.select();
      el.dataset.justFocused = '1';
    },
    onmouseup: (ev) => {
      if (ev.target.dataset.justFocused) ev.preventDefault();
      delete ev.target.dataset.justFocused;
    },
    onkeydown: (ev) => delete ev.target.dataset.justFocused,
    onblur: (ev) => delete ev.target.dataset.justFocused,
    oninput: (ev) => {
      const el = ev.target;
      const clean = [...el.value].filter((ch) => M.NAME_CHARS.test(ch)).join('').slice(0, 4);
      if (clean !== el.value) el.value = clean;
      onInput(clean);
    },
  });
}

function numField(key, value, min, max, onCommit, disabled) {
  return h('input', {
    type: 'number', class: 'num', min, max, step: 1, value: String(value), disabled, dataset: { key },
    onchange: (ev) => {
      let v = Math.round(Number(ev.target.value));
      if (!Number.isFinite(v)) v = value;
      onCommit(Math.max(min, Math.min(max, v)));
    },
  });
}

function selectField(key, options, value, onCommit, disabled) {
  return h('select', { dataset: { key }, disabled, onchange: (ev) => ev.target.value !== '' && onCommit(Number(ev.target.value)) },
    options.map((o) => h('option', { value: String(o.value), selected: o.value === value, disabled: !!o.disabled }, o.label)));
}

function row(label, control, { enabled = true, hint, note } = {}) {
  return h('div', { class: 'row' + (enabled ? '' : ' disabled') },
    h('label', {}, label),
    h('div', { class: 'ctl' }, control, hint ? h('span', { class: 'hint' }, hint) : null),
    note ? h('div', { class: 'note' }, note) : null);
}

const channelOptions = (prefix = '', n = 16) => range(0, n).map((c) => ({ value: c, label: `${prefix}${c + 1}` }));

function noteControl(key, value, onCommit, disabled) {
  return h('span', { class: 'pair' },
    numField(key, value, 0, 127, onCommit, disabled),
    selectField(key + '-n', range(0, 128).map((n) => ({ value: n, label: M.noteName(n) })), value, onCommit, disabled));
}

function check(key, checked, enabled, label, onSet) {
  return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!checked && enabled, disabled: !enabled, dataset: { key }, onchange: (ev) => onSet(ev.target.checked ? 1 : 0) }), label);
}

function renderInspector() {
  const el = $('#inspector');
  if (S.view !== 'pages' || (!S.store.loaded && !S.conn)) return replace(el, h('div', { class: 'insp-empty' }, S.view === 'import' ? 'Pick the groups, then Import.' : ''));
  const { page: p, cell: c } = S.sel;
  const cell = M.readCell(img(), p, c);
  const key = M.isKey(c);
  const clip = getClip();
  const title = h('div', { class: 'insp-title' },
    h('span', { class: 'big' }, M.cellLabel(c)),
    h('span', { class: 'where' }, `Page ${p + 1}`),
    h('span', { class: 'acts' },
      h('button', { class: 'small', onclick: copyCell, title: 'Copy this cell (⌘C)' }, 'Copy'),
      h('button', { class: 'small', onclick: pasteCell, disabled: !clip, title: clip ? `Paste ${clip.from} (⌘V)` : 'Nothing copied' }, 'Paste'),
      h('button', { class: 'small', onclick: () => edit(() => (M.clearCell(img(), p, c), c < M.KNOBS && M.removeSync(img(), p, c)), { label: `clear ${M.cellLabel(c)}` }), disabled: cell.blank, title: 'Nothing on it, no FH-2 entry' }, 'Clear')));
  const nameRow = row('Name', nameInput('cellname', cell.name, (v) => edit(() => M.setName(img(), p, c, v), { key: `name${p}/${c}`, label: `name of ${M.cellLabel(c)}` }), false, '····'));
  const parts = [title, h('div', { class: 'fields' }, nameRow)];
  if (!key) parts.push(h('h3', {}, 'Turn'), h('div', { class: 'fields' }, encoderFields(p, c, cell.enc)));
  parts.push(h('h3', {}, key ? 'Key' : 'Push'), h('div', { class: 'fields' }, pushFields(p, c, cell.push)));
  if (!key) parts.push(syncPanel(p, c, cell.enc));
  parts.push(bytesInfo(p, c));
  replace(el, parts);
}

function encoderFields(p, c, e) {
  const r = M.encoderRules(e, c);
  const set = (field) => (v) => edit(() => M.setEncoder(img(), p, c, field, v), { label: `knob ${c + 1} ${field}` });
  const out = [];
  const types = [...M.ENC_TYPES.map((t, v) => ({ value: v, label: t.label })), { value: M.T.OFF, label: 'Off' }];
  out.push(row('Type', selectField('type', types, e.type, set('type'))));
  if (e.off) return out;
  out.push(row('Channel', selectField('channel', channelOptions(), e.channel, set('channel'))));
  if (r.numberHigh.enabled) {
    out.push(row('NRPN MSB', numField('numberHigh', Math.min(e.numberHigh, 127), 0, 127, set('numberHigh')), { hint: '0–127' }));
    out.push(row('NRPN LSB', numField('number', e.number, 0, 127, set('number')), { hint: `NRPN ${Math.min(e.numberHigh, 127) * 128 + e.number}` }));
  } else if (r.number.kind === 'note') {
    out.push(row('Note', noteControl('number', e.number, set('number'))));
  } else {
    out.push(row(r.number.enabled ? r.number.label : 'Number', numField('number', Math.min(e.number, r.number.max), 0, r.number.max, set('number'), !r.number.enabled),
      { enabled: r.number.enabled, hint: r.number.enabled ? `0–${r.number.max}` : '' }));
  }
  const lu = r.lower;
  const luHint = !lu.enabled ? '' : lu.hires ? '0–4094, 16383' : '0–127';
  out.push(row('Lower', numField('lower', e.lower, 0, lu.max, set('lower'), !lu.enabled), { enabled: lu.enabled, hint: luHint }));
  out.push(row('Upper', numField('upper', e.upper, 0, lu.max, set('upper'), !lu.enabled), { enabled: lu.enabled, hint: luHint }));
  out.push(row('Display', selectField('scale', M.SCALES.map((t, v) => ({ value: v, label: t.label })), e.scale, set('scale')),
    { note: e.type === M.T.PBND || e.type === M.T.NRPN ? '14-bit with off, 1000, ±500, 9999.' : null }));
  out.push(row('Mode', selectField('mode', M.MODES.map((t, v) => ({ value: v, label: `${t.short} — ${t.label}` })), e.mode, set('mode'), !r.mode.enabled), { enabled: r.mode.enabled }));
  out.push(row('Link', check('link', e.link, r.link.enabled, r.link.enabled ? `with knob ${c + 2}` : 'last knob', set('link')), { enabled: r.link.enabled }));
  const warn = [];
  if (e.rawMode !== e.mode) warn.push(`mode ${e.rawMode} plays as ${M.MODES[e.mode].short}`);
  if (e.rawScale !== e.scale) warn.push(`display ${e.rawScale} shows as ${M.SCALES[e.scale].short}`);
  if (warn.length) out.push(h('div', { class: 'warn' }, warn.join('; ') + '.'));
  return out;
}

function pushFields(p, c, pu) {
  const r = M.pushRules(pu, c);
  const key = M.isKey(c);
  const set = (field) => (v) => edit(() => M.setPush(img(), p, c, field, v), { label: `${M.cellLabel(c)} push ${field}` });
  const out = [];
  // A key has no encoder: Set and the encoder's push types are greyed out for it, and one that
  // is stored all the same shows what the BCR32 makes of it (off).
  const types = M.PUSH_TYPES.map((t, v) => ({ value: v, label: t.label, disabled: key && !M.pushTypeOnKey(v) && v !== pu.type }));
  out.push(row('Type', selectField('ptype', types, pu.type, set('type'))));
  if (pu.onKeyOff) out.push(h('div', { class: 'warn' }, `${M.PUSH_TYPES[pu.type].short} needs an encoder: on a key the BCR32 plays it as off.`));
  if (pu.off) return out;
  const pageOpts = r.channel.kind === 'page';
  out.push(row(r.channel.label, selectField('pchannel', pageOpts ? channelOptions('Page ', 4) : channelOptions(), pageOpts ? pu.channel & 3 : pu.channel, set('channel'), !r.channel.enabled), { enabled: r.channel.enabled }));
  if (r.number.kind === 'note' && r.number.enabled) out.push(row('Note', noteControl('pnumber', pu.number, set('number'))));
  else out.push(row(r.number.label, numField('pnumber', pu.number, 0, 127, set('number'), !r.number.enabled), { enabled: r.number.enabled, hint: r.number.enabled ? '0–127' : '' }));
  out.push(row('Mode', selectField('pmode', M.PUSH_MODES.map((t, v) => ({ value: v, label: t.label })), pu.mode, set('mode'), !r.mode.enabled), { enabled: r.mode.enabled }));
  out.push(row('Display', check('pdisplay', pu.display, r.display.enabled, key ? 'LED shows the state' : 'ring shows the state', set('display')), { enabled: r.display.enabled }));
  out.push(row(r.lower.label ?? 'Lower', numField('plower', pu.lower, 0, 127, set('lower'), !r.lower.enabled), { enabled: r.lower.enabled, hint: r.lower.enabled ? (r.lower.hint ?? '0–127') : '' }));
  out.push(row(r.upper.label ?? 'Upper', numField('pupper', pu.upper, 0, 127, set('upper'), !r.upper.enabled), { enabled: r.upper.enabled, hint: r.upper.enabled ? (r.upper.hint ?? '0–127') : '' }));
  out.push(row('Link', check('plink', pu.link, r.link.enabled, r.link.enabled ? `with ${key ? 'key' : 'push'} ${(key ? c - M.KNOBS : c) + 2}` : key ? 'last key' : 'last knob', set('link')), { enabled: r.link.enabled }));
  return out;
}

function syncPanel(p, c, e) {
  const s = M.readSync(img(), p, c);
  const hd = M.readSyncHeader(img());
  const head = h('h3', {}, 'FH-2 sync');
  if (!s) return h('div', { class: 'syncbox' }, head, h('p', { class: 'hint' }, 'No entry. Night Shift makes them.'));
  const problem = M.syncProblem(s, e, hd);
  const tc = s.c === 0xFF || s.c === 0 ? 'none' : M.TABLE_C[s.c] ? `${M.TABLE_C[s.c]} (0x${s.c.toString(16).padStart(2, '0')})` : `0x${s.c.toString(16).padStart(2, '0')} (unknown)`;
  return h('div', { class: 'syncbox' }, head,
    h('div', { class: 'fields' },
      row('Table A', h('span', { class: 'mono' }, `${M.SYNC_TYPES[s.type]?.short ?? 'type ' + s.type} @ 0x${s.offset.toString(16).toUpperCase().padStart(3, '0')}`), { hint: M.SYNC_TYPES[s.type]?.label }),
      s.type === 2 ? row('Table B', h('span', { class: 'mono' }, `${s.n} bands from ${s.from}${s.held ? ', held at 1' : ''}`)) : null,
      s.type === 3 ? row('Table B', h('span', { class: 'mono' }, `${s.base} BPM at CC 0`)) : null,
      row('Table C', h('span', {}, tc))),
    problem ? h('div', { class: 'warn' }, `Not used: ${problem}.`) : null,
    h('button', { class: 'small danger-outline', onclick: () => edit(() => M.removeSync(img(), p, c), { label: `remove FH-2 entry of knob ${c + 1}` }) }, 'Remove entry'));
}

function bytesInfo(p, c) {
  const a = M.cellAddr(p, c);
  const rec = M.readRecord(img(), p, c);
  const base = S.store.dev ?? S.store.file;
  return h('details', { class: 'addr' },
    h('summary', {}, `Bytes 0x${a.toString(16).toUpperCase().padStart(4, '0')}`, cellDirty(p, c) ? h('span', { class: 'dot' }) : null),
    h('div', { class: 'mono rec' }, Array.from(rec, (b, k) => h('span', { class: base && base[a + k] !== b ? 'chg' : '' }, b.toString(16).padStart(2, '0') + ' '))),
    base && cellDirty(p, c) ? h('div', { class: 'mono rec was' }, 'was ', toHex(M.readRecord(base, p, c)).replace(/(..)/g, '$1 ')) : null);
}

// ---- the import view

function importView() {
  const { src, scan, chosen, ports, busy } = S.imp;
  const pick = ports.includes(S.prefs.ec4Port) ? S.prefs.ec4Port : ports.find((n) => EC4_NAME.test(n)) ?? '';
  const portSel = h('select', { id: 'ec4port', title: 'The EC4\'s MIDI port', onchange: (e) => ((S.prefs.ec4Port = e.target.value), savePrefs()) },
    [h('option', { value: '' }, 'EC4 port'), ...ports.map((n) => h('option', { value: n, selected: n === pick }, n))]);
  const out = [
    h('h2', {}, 'Import Night Shift\'s pages'),
    h('p', { class: 'hint' }, 'EC4 setup 15, groups 1–8 → pages 1–4, two groups a page (left, right).'),
    h('div', { class: 'imp-src' },
      portSel,
      h('button', { onclick: readEc4Port, disabled: busy || !!S.job, title: 'Read setup 15 and the FH-2 tables from an EC4 running controlfrog' }, 'Read EC4'),
      h('button', { onclick: readDemoEc4, disabled: busy || !!S.job }, 'Demo EC4'),
      h('button', { onclick: () => $('#syxinput').click(), title: 'A Lilypad full dump (with the FH-2 tables) or all-setups file' }, 'Open .syx'),
      h('button', { onclick: () => ((S.view = 'pages'), renderAll()) }, 'Close')),
  ];
  if (!src) return h('div', { class: 'import' }, out);
  const fmt = scan.headerOk ? `FH-2 header: format ${scan.format}, dump ${scan.header[5]}, PC ${scan.header[7] >= 1 && scan.header[7] <= 16 ? 'ch ' + scan.header[7] : 'off'}` : src.hasTables ? 'no FH-2 header' : 'no FH-2 tables';
  out.push(h('p', { class: 'imp-what' }, h('b', {}, src.source), ` · setup 15 “${scan.setupName || '    '}” · ${fmt}`));
  const rows = scan.groups.map((g) => h('label', { class: 'imp-row' + (g.empty ? ' empty' : '') + (chosen.has(g.g) ? ' on' : '') },
    h('input', { type: 'checkbox', checked: chosen.has(g.g), onchange: (e) => (e.target.checked ? chosen.add(g.g) : chosen.delete(g.g), renderMain()) }),
    h('span', { class: 'g' }, `Group ${g.g + 1}`),
    h('span', { class: 'nm' }, g.name || '····'),
    h('span', { class: 'to' }, `→ ${I.halfName(g.g)}`),
    h('span', { class: 'what' }, g.empty ? 'empty' : `${plural(g.knobs, 'knob')} · ${g.synced} FH-2 · ${g.pushes} push${g.pushes === 1 ? '' : 'es'}`)));
  out.push(h('div', { class: 'imp-list' }, rows));
  const warns = [];
  if (scan.beyond.length) warns.push(`Groups ${scan.beyond.map((b) => b.g + 1).join(', ')} hold pages too; they don't fit.`);
  if (scan.headerOk && scan.format !== 1 && scan.format !== 2) warns.push(`The EC4's table is format ${scan.format}; the BCR32 reads formats 1 and 2.`);
  if (src.hasTables && !src.hasTableC) warns.push('controlfrog before 0.13: no table C.');
  if (scan.setupName && scan.setupName.trim() !== 'FH-2') warns.push(`Setup 15 is “${scan.setupName}”, not Night Shift's “FH-2”.`);
  if (warns.length) out.push(h('div', { class: 'warn' }, warns.join(' ')));
  const pages = [...new Set([...chosen].map(I.bcrPage))].sort();
  out.push(h('div', { class: 'imp-actions' },
    h('button', { class: 'primary', disabled: !chosen.size, onclick: doImport }, chosen.size ? `Import ${plural(chosen.size, 'group')}` : 'Import'),
    h('span', { class: 'hint' }, chosen.size ? `Replaces those halves of page${pages.length > 1 ? 's' : ''} ${pages.map((q) => q + 1).join(', ')}${src.hasTables ? ' and the FH-2 header' : ''}. Undoable.` : '')));
  return h('div', { class: 'import' }, out);
}

// ---- status bar and log

function renderStatus() {
  const j = S.job;
  const msg = S.message;
  const n = S.store.deviceDirtyBytes();
  let prog = null;
  if (j) {
    prog = h('div', { class: 'job' },
      h('span', {}, j.label + (j.total ? ` · ${j.done}/${j.total}` : '')),
      h('progress', { max: 1, value: j.total ? j.done / j.total : 0 }),
      h('button', { class: 'small', onclick: () => ((j.cancelled = true), S.imp.dev ? S.imp.dev.abort() : S.conn?.dev.abort()) }, 'Cancel'));
  }
  const pend = S.store.dev && S.conn ? (n ? `${changeSummary()} to send` : 'BCR32 up to date') : S.store.unsaved() ? 'unsaved' : '';
  const ds = S.devState;
  replace($('#status'),
    h('div', { class: 'msg ' + (msg?.kind || '') }, msg?.text || ''),
    prog,
    h('div', { class: 'right' },
      h('span', { class: 'pend' + (n && S.conn ? ' has' : '') }, pend),
      ds ? h('span', { class: 'devstate', title: 'what the BCR32 shows' }, ds.mode === 1 ? `BCR32: page ${ds.page + 1}` : 'BCR32: sequencer') : null,
      toggle('follow', 'Follow', 'Touching a knob or key, or a page change on the BCR32, selects it here'),
      toggle('liveEdit', 'Play edits', 'The BCR32 plays your edits of the page it shows before Send (EDIT, RAM only); off, it plays its stored cells again', () => (S.prefs.liveEdit ? syncEdits() : dropLiveEdits())),
      toggle('showLog', 'Log', 'Show the protocol log', () => renderLog()),
      $('#target').value === 'mock' ? toggle('showMock', 'Demo panel', 'Show the demo BCR32', () => renderMock()) : null));
}

function toggle(pref, label, title, after) {
  return h('label', { class: 'tog', title },
    h('input', { type: 'checkbox', checked: !!S.prefs[pref], onchange: (e) => {
      S.prefs[pref] = e.target.checked;
      savePrefs();
      after?.();
      renderStatus();
    } }), label);
}

function renderLog() {
  const el = $('#log');
  el.hidden = !S.prefs.showLog;
  if (el.hidden) return;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  el.textContent = S.log.join('\n');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// ---- the demo BCR32 panel

let mockShown = null; // {cell, t}: the last control touched on the demo unit

function mockTouch(kind, index) {
  const m = S.mock;
  m.touch(kind, index);
  mockShown = { cell: kind === 2 ? M.keyCell(index) : index, kind, t: performance.now() };
  renderMock();
}

function mockKnob(i) {
  let drag = null;
  const el = h('div', { class: 'mknob', title: `Knob ${i + 1}: wheel or drag turns, click pushes` }, h('div', { class: 'cap' }));
  el.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    mockTouch(0, i);
  }, { passive: false });
  el.addEventListener('pointerdown', (ev) => {
    drag = { y: ev.clientY, moved: false };
    el.setPointerCapture(ev.pointerId);
  });
  el.addEventListener('pointermove', (ev) => {
    if (drag && Math.abs(drag.y - ev.clientY) >= 4) {
      drag.moved = true;
      drag.y = ev.clientY;
      mockTouch(0, i);
    }
  });
  el.addEventListener('pointerup', () => {
    if (drag && !drag.moved) mockTouch(1, i);
    drag = null;
  });
  return el;
}

function renderMock() {
  const panel = $('#mockpanel');
  const show = $('#target').value === 'mock' && S.prefs.showMock && S.mock && (S.conn?.kind === 'mock' || S.store.loaded);
  panel.hidden = !show;
  if (!show) return;
  const m = S.mock;
  const name = (c) => M.readName(m.record(c), 8);
  const shown = mockShown && m.record(mockShown.cell);
  const line2 = shown ? `${M.cellLabel(mockShown.cell).toUpperCase()} ${name(mockShown.cell)} ${mockShown.kind === 0 ? M.encoderSummary(M.decodeEncoder(shown)) : M.pushSummary(M.decodePush(shown))}` : 'turn or push a knob';
  const pn = M.pageName(m.live, m.page) || '····';
  const knobs = h('div', { class: 'mknobs' }, range(0, M.KNOBS).map((i) => h('div', { class: 'mk' + (m.edits.has(i) ? ' edited' : '') }, mockKnob(i), h('span', {}, name(i)))));
  const keys = h('div', { class: 'mkeys' }, range(0, M.KEYS).map((j) => h('button', { class: 'mkey' + (m.edits.has(M.keyCell(j)) ? ' edited' : ''), title: `Key ${j + 1}`, onclick: () => mockTouch(2, j) }, name(M.keyCell(j)).trim() || j + 1)));
  const fault = (label, on, set) => h('label', { class: 'tog' }, h('input', { type: 'checkbox', checked: on, onchange: (e) => (set(e.target.checked), renderMock()) }), label);
  replace(panel,
    h('div', { class: 'mock-head' }, h('b', {}, 'Demo BCR32'),
      h('span', { class: 'hint' }, ` Rotary Club ${m.fw.join('.')} · ${m.port ? 'connected' : 'not connected'} · touch events ${m.touchOn ? 'on' : 'off'} · FH-2 sync ${m.syncOff ? 'off until USB goes down' : 'on'}`)),
    h('div', { class: 'mock-body' },
      h('div', { class: 'mock-unit' },
        h('div', { class: 'oled' }, h('div', { class: 'otop' }, m.mode === 1 ? `CTRL  P${m.page + 1} ${pn}` : 'SEQUENCER'), h('div', {}, line2)),
        h('div', { class: 'mock-keys' },
          h('button', { class: 'small' + (m.mode === 1 ? ' on' : ''), title: 'Sequencer / controller', onclick: () => m.setMode(m.mode ? 0 : 1) }, 'ZAQ/CTRL'),
          range(0, 4).map((q) => h('button', { class: 'small' + (q === m.page ? ' on' : ''), onclick: () => m.setPage(q) }, `T${q + 1}`)))),
      h('div', { class: 'mock-surface' }, keys, knobs),
      h('div', { class: 'mock-opts' },
        h('label', { class: 'tog' }, h('input', { type: 'checkbox', checked: m.speed !== 'fast', onchange: (e) => {
          m.speed = S.prefs.mockSpeed = e.target.checked ? 'usb' : 'fast';
          savePrefs();
        } }), 'USB timing'),
        h('div', { class: 'faults' }, h('span', { class: 'hint' }, 'Faults: '),
          fault('writes fail', m.faults.writeStatus !== 0, (v) => (m.faults.writeStatus = v ? 1 : 0)),
          fault('store fails', m.faults.reloadStatus !== 0, (v) => (m.faults.reloadStatus = v ? ERR_STORE : 0)),
          fault('drop next reply', m.faults.dropReplies > 0, (v) => (m.faults.dropReplies = v ? 1 : 0)),
          fault('corrupt next READ', m.faults.badChecksum, (v) => (m.faults.badChecksum = v))),
        h('div', { class: 'hint' }, `${m.stats.reads} reads · ${m.stats.writes} writes · ${m.stats.reloads} reloads · ${m.stats.edits} edits`),
        h('div', { class: 'mock-btns' },
          h('button', { class: 'small', onclick: () => m.powerCycle(), title: 'Back to the stored image; FH-2 sync on again' }, 'Power cycle'),
          h('button', { class: 'small', onclick: () => (setMock(demoImage()), say('Demo BCR32 reset.')) }, 'Reset demo'),
          h('button', { class: 'small', onclick: () => (setMock(M.blankImage()), say('Demo BCR32 blank.')) }, 'Blank')))));
}

// ------------------------------------------------------------------ keyboard

function moveSel(d) {
  const c = S.sel.cell;
  let n;
  if (d === 'left' || d === 'right') {
    const step = d === 'left' ? -1 : 1;
    n = M.isKey(c) ? M.KNOBS + ((c - M.KNOBS + step + M.KEYS) % M.KEYS) : (c + step + M.KNOBS) % M.KNOBS;
  } else if (d === 'up') n = M.isKey(c) ? 24 + Math.min(7, (c - M.KNOBS) >> 1) : c >= 8 ? c - 8 : c;
  else n = M.isKey(c) ? c : c < 24 ? c + 8 : M.KNOBS + (c - 24) * 2;
  selectCell(n);
}

function onKey(ev) {
  const mod = ev.metaKey || ev.ctrlKey;
  const key = ev.key.toLowerCase();
  if (mod && !ev.altKey && (key === 'z' || key === 'y') && !ev.target.closest('dialog')) {
    ev.preventDefault();
    return undoRedo(key === 'y' || ev.shiftKey);
  }
  if (ev.target.closest('input, select, textarea, dialog') || S.view !== 'pages' || (!S.store.loaded && !S.conn)) return;
  const moves = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  if (ev.key in moves) {
    ev.preventDefault();
    moveSel(moves[ev.key]);
  } else if (ev.key === 'PageDown' || ev.key === 'PageUp' || (ev.key >= '1' && ev.key <= '4' && !mod)) {
    ev.preventDefault();
    selectPage(ev.key.length === 1 ? Number(ev.key) - 1 : (S.sel.page + (ev.key === 'PageDown' ? 1 : 3)) % 4);
  }
}

// ------------------------------------------------------------------ wiring

function init() {
  $('#connect').onclick = () => connect();
  $('#target').onchange = () => {
    if ($('#target').value === 'midi') refreshPorts().catch(showError);
    renderAll();
  };
  $('#send').onclick = () => send().catch(showError);
  $('#reread').onclick = () => reread();
  $('#discard').onclick = () => discard();
  $('#asconnected').onclick = () => asConnected();
  $('#open').onclick = () => $('#fileinput').click();
  $('#save').onclick = () => save();
  $('#import').onclick = () => (S.view === 'import' ? ((S.view = 'pages'), renderAll()) : openImport());
  $('#undo').onclick = () => undoRedo(false);
  $('#redo').onclick = () => undoRedo(true);
  for (const id of ['#fileinput', '#syxinput']) {
    $(id).onchange = (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) openFile(f).catch(showError);
    };
  }
  document.addEventListener('keydown', onKey);
  const inText = (t) => t?.closest?.('input, textarea');
  document.addEventListener('copy', (e) => {
    if (inText(e.target) || !document.getSelection().isCollapsed || S.view !== 'pages' || !S.store.loaded) return;
    e.preventDefault();
    copyCell();
  });
  document.addEventListener('paste', (e) => {
    if (inText(e.target) || S.view !== 'pages' || !S.store.loaded || !getClip()) return;
    e.preventDefault();
    pasteCell();
  });
  window.addEventListener('storage', (e) => e.key === CLIP_KEY && renderInspector());
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) openFile(f).catch(showError);
  });
  window.addEventListener('beforeunload', (e) => {
    if (S.conn?.info ? S.store.deviceDirtyBytes() && S.store.unsaved() : S.store.unsaved()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  if (S.prefs.lastPort) $('#target').value = 'midi';
  renderAll();
  renderLog();
  if (new URLSearchParams(location.search).has('demo')) {
    $('#target').value = 'mock';
    connect();
  }
}

// For debugging from the console.
window.eye = { S, M, I, connect, disconnect, send, edit, undoRedo, getMock };

init();
