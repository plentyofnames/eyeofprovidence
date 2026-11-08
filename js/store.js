// The editor's 4 KB image and its baselines: what the BCR32 keeps in its store (for "to send"),
// what its RAM holds (for Send, which writes only the ranges that differ), what its controller
// plays (for the live EDITs), and what the opened or saved file held (for "unsaved"). After
// Lilypad's store.js, without its 64-byte pages: the controller space is read whole.
//
// `touched`: the addresses edited here since the last read or Send (an opened file: all of them).
// A read keeps exactly those, as changes to send; every other byte becomes the BCR32's.
//
// A Send WRITEs into the BCR32's RAM, and only RELOAD makes it use and keep them. A Send that
// fails after a WRITE leaves bytes in its RAM that its store doesn't hold: they stay "to send"
// (dev keeps the stored bytes), and a Read meanwhile keeps that baseline for them rather than
// taking the RAM as what the BCR32 holds (review, 2026-11-08).

import { SIZE, writable, blankImage } from './model.js';
import { MAX_CHUNK } from './proto.js';

export class Store {
  constructor() {
    this.img = blankImage(); // never replaced: History keeps a reference to it
    this.dev = null; // the BCR32's image as its store keeps it, as far as the editor knows
    this.ram = null; // its image in RAM: dev, plus what a Send wrote before it failed
    this.live = null; // what its controller plays: the image as it last loaded it (RELOAD, power-on)
    this.connected = null; // its image as read when the session connected
    this.file = null; // the last opened or saved file's image
    this.fileName = '';
    this.loaded = false; // anything in the editor yet (device, file, import, edit)
    this.touched = new Set();
  }

  touch(addrs) {
    for (const a of addrs) if (writable(a)) this.touched.add(a);
  }
  touchAll() {
    for (let a = 0; a < SIZE; a++) if (writable(a)) this.touched.add(a);
  }

  // A fresh read of the whole space: the BCR32's image, with the bytes edited here (and not on
  // the BCR32) kept as changes to send. Returns how many bytes were kept.
  fromDevice(data, { keepEdits = true } = {}) {
    const next = Uint8Array.from(data);
    const keep = keepEdits ? [...this.touched].filter((a) => this.img[a] !== data[a]) : [];
    for (const a of keep) next[a] = this.img[a];
    const dev = Uint8Array.from(data);
    if (this.dev && this.ram) {
      // written but not kept: the RAM has the editor's bytes there, the store the old ones
      for (let a = 0; a < SIZE; a++) if (this.ram[a] !== this.dev[a] && data[a] === this.ram[a]) dev[a] = this.dev[a];
    }
    this.dev = dev;
    this.ram = Uint8Array.from(data);
    if (!this.live) this.live = Uint8Array.from(data);
    if (!this.connected) this.connected = Uint8Array.from(data);
    this.img.set(next);
    this.touched = new Set(keep);
    this.loaded = true;
    return keep.length;
  }

  // A WRITE answered: the bytes are in the BCR32's RAM, not kept yet.
  written(addr, bytes) {
    this.ram?.set(bytes, addr);
  }

  // RELOAD answered 21: the BCR32 uses and keeps what its RAM holds; nothing is the editor's own.
  committed() {
    if (this.ram) {
      this.dev = Uint8Array.from(this.ram);
      this.live = Uint8Array.from(this.ram);
    }
    this.touched.clear();
  }

  // RELOAD answered 7F 24 04: the BCR32 uses what its RAM holds, but could not keep it.
  reloadedUnkept() {
    if (this.ram) this.live = Uint8Array.from(this.ram);
  }

  // Bytes in the BCR32's RAM that its store doesn't hold (a Send that failed after a WRITE).
  unkeptBytes() {
    return this.dev && this.ram ? countDiff(this.ram, this.dev) : 0;
  }

  // A fresh link: what its controller plays is read again, and "as connected" starts over. What
  // its RAM held stays as the baseline for a Send that failed before the link went.
  forgetDevice() {
    this.live = null;
    this.connected = null;
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

  revertToDevice() {
    if (this.dev) this.img.set(this.dev);
    this.touched.clear();
  }

  // The WRITEs that make the BCR32's RAM hold the image.
  deviceChunks() {
    return this.ram ? diffChunks(this.img, this.ram) : this.dev ? diffChunks(this.img, this.dev) : [];
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
