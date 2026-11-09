// The live link: the page the BCR32 shows plays the editor's cells before Send (EDIT, RAM only).
// Out of app.js (review, 2026-11-08) so it can be tested against the mock.
//
// Paced: 8 EDITs, then a GET_STATE round trip, so a burst (a page change, a connect that kept
// edits) never overruns the BCR32's SysEx input. The baseline is what the controller plays: the
// image as it last loaded it (store.live), not what a Send wrote into its RAM since.

import * as M from './model.js';

const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export class LiveLink {
  // get() -> {conn: {dev, info}, devState: {mode, page}, liveEdit, store}
  constructor(get) {
    this.get = get;
    this.sent = new Map(); // cell -> record (hex) sent with EDIT to the page in view
    this.syncing = false;
    this.again = false;
  }

  // The page loaded again on the BCR32 (a page change, RELOAD): it plays its stored cells.
  reset() {
    this.sent.clear();
  }

  async sync() {
    if (this.syncing) {
      this.again = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.again = false;
        const { conn: c, devState, liveEdit, store } = this.get();
        if (!c?.info || !liveEdit || !devState || !store.dev) return;
        const p = devState.page;
        let n = 0;
        for (let cell = 0; cell < M.CELLS; cell++) {
          const rec = M.readRecord(store.img, p, cell);
          const key = toHex(rec);
          const have = this.sent.get(cell) ?? toHex(M.readRecord(store.live ?? store.dev, p, cell));
          if (key === have) continue;
          this.sent.set(cell, key);
          c.dev.edit(p, cell, rec).catch(() => {});
          if (++n % 8 === 0) await c.dev.getState().catch(() => {});
          const now = this.get();
          if (now.conn !== c || now.devState?.page !== p) {
            this.again = true; // the page changed meanwhile: start over on the new one
            break;
          }
        }
      } while (this.again);
    } finally {
      this.syncing = false;
    }
  }

  // The page in view plays the editor's cells only until it loads again, and a SELECT of the
  // page in view doesn't load it again (0.24): before the link goes, or when Play edits is
  // switched off, the records the controller holds go back by EDIT, so nothing unsent keeps playing.
  async drop(c = this.get().conn) {
    const { devState, store } = this.get();
    if (!c?.info || !devState || !store.dev || !this.sent.size) return;
    const p = devState.page;
    const base = store.live ?? store.dev;
    let n = 0;
    for (const [cell, hex] of this.sent) {
      const rec = M.readRecord(base, p, cell);
      if (toHex(rec) === hex) continue;
      c.dev.edit(p, cell, rec).catch(() => {});
      if (++n % 8 === 0) await c.dev.getState().catch(() => {});
    }
    this.sent.clear();
    if (n) await c.dev.getState().catch(() => {}); // the EDITs are in before anything after them
  }
}
