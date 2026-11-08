// The editor's 4 KB image and two baselines: what the BCR32 holds (for Send, which writes only
// the changed ranges) and what the opened or saved file held (for "unsaved"). After Lilypad's
// store.js, without its 64-byte pages: the controller space is read whole.

import { SIZE, writable, blankImage } from './model.js';
import { MAX_CHUNK } from './proto.js';

export class Store {
  constructor() {
    this.img = blankImage(); // never replaced: History keeps a reference to it
    this.dev = null; // the BCR32's image as last read or written
    this.file = null; // the last opened or saved file's image
    this.fileName = '';
    this.loaded = false; // anything in the editor yet (device, file, import, edit)
  }

  // A fresh read of the whole space. The editor takes it unless it holds edits of its own,
  // which then become changes to send.
  fromDevice(data, { keepEdits = true } = {}) {
    const mine = keepEdits && this.loaded && this.hasOwnEdits();
    this.dev = Uint8Array.from(data);
    if (!mine) this.img.set(data);
    this.loaded = true;
    return mine;
  }

  // Edits not on the device and not in a file: what a fresh read must not throw away.
  hasOwnEdits() {
    const base = this.dev ?? this.file;
    return base ? differs(this.img, base) : !this.img.every((b) => b === 0xFF);
  }

  fromFile(data, name) {
    this.img.set(data);
    this.file = Uint8Array.from(data);
    this.fileName = name;
    this.loaded = true;
  }
  markSaved(name) {
    this.file = Uint8Array.from(this.img);
    this.fileName = name;
  }

  written(addr, bytes) {
    this.dev?.set(bytes, addr);
  }

  revertToDevice() {
    if (this.dev) this.img.set(this.dev);
  }

  deviceChunks() {
    return this.dev ? diffChunks(this.img, this.dev) : [];
  }
  deviceDirtyBytes() {
    return this.dev ? countDiff(this.img, this.dev) : 0;
  }
  isDeviceDirty(addr) {
    return !!this.dev && writable(addr) && this.img[addr] !== this.dev[addr];
  }
  unsaved() {
    return this.file ? differs(this.img, this.file) : this.loaded && this.hasOwnEdits();
  }
}

export function differs(a, b) {
  for (let i = 0; i < SIZE; i++) if (writable(i) && a[i] !== b[i]) return true;
  return false;
}
export function countDiff(a, b) {
  let n = 0;
  for (let i = 0; i < SIZE; i++) if (writable(i) && a[i] !== b[i]) n++;
  return n;
}

// The WRITEs that turn `base` into `img`: runs of changed writable bytes, joined across gaps of
// up to `gap` unchanged writable bytes (rewriting them costs less than another message), at most
// `max` bytes each.
export function diffChunks(img, base, { max = MAX_CHUNK, gap = 8 } = {}) {
  const runs = [];
  let a = 0;
  while (a < SIZE) {
    if (img[a] === base[a] || !writable(a)) {
      a++;
      continue;
    }
    const start = a;
    while (a < SIZE && img[a] !== base[a] && writable(a)) a++;
    const last = runs[runs.length - 1];
    let joinable = last && start - last.end <= gap;
    for (let k = last ? last.end : 0; joinable && k < start; k++) if (!writable(k)) joinable = false;
    if (joinable) last.end = a;
    else runs.push({ start, end: a });
  }
  const out = [];
  for (const r of runs) {
    for (let s = r.start; s < r.end; s += max) {
      const e = Math.min(r.end, s + max);
      out.push({ addr: s, data: img.slice(s, e) });
    }
  }
  return out;
}
