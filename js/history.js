// Undo/redo for edits of the image. Each step keeps only the bytes it changed.

export class History {
  constructor(img, { limit = 300, mergeMs = 1500 } = {}) {
    this.img = img;
    this.limit = limit;
    this.mergeMs = mergeMs;
    this.done = [];
    this.undone = [];
  }

  get canUndo() {
    return this.done.length > 0;
  }
  get canRedo() {
    return this.undone.length > 0;
  }

  clear() {
    this.done.length = 0;
    this.undone.length = 0;
  }

  // Runs fn (which edits the image) as one undo step. Steps with the same `key` in quick
  // succession (typing a name) merge into one. Returns the step, or null if nothing changed.
  record(fn, { key = null, label = '', now = Date.now() } = {}) {
    const before = this.img.slice();
    fn();
    const changes = new Map(); // addr -> [before, after]
    for (let a = 0; a < before.length; a++) if (before[a] !== this.img[a]) changes.set(a, [before[a], this.img[a]]);
    if (!changes.size) return null;
    const last = this.done[this.done.length - 1];
    if (key && last && last.key === key && now - last.t < this.mergeMs && !this.undone.length) {
      for (const [a, [b, after]] of changes) last.changes.set(a, [last.changes.has(a) ? last.changes.get(a)[0] : b, after]);
      for (const [a, [b, after]] of last.changes) if (b === after) last.changes.delete(a);
      last.t = now;
      if (!last.changes.size) this.done.pop();
      return last;
    }
    const step = { changes, key, label, t: now };
    this.done.push(step);
    this.undone.length = 0;
    if (this.done.length > this.limit) this.done.shift();
    return step;
  }

  undo() {
    const step = this.done.pop();
    if (!step) return null;
    for (const [a, [b]] of step.changes) this.img[a] = b;
    this.undone.push(step);
    return step;
  }

  redo() {
    const step = this.undone.pop();
    if (!step) return null;
    for (const [a, [, after]] of step.changes) this.img[a] = after;
    this.done.push(step);
    return step;
  }
}
