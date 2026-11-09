// Bulk edits of several cells of a page, after Lilypad's bulk.js: one field set on every selected
// cell it applies to, channels or numbers filled ascending, and copy / paste of several cells.
// Everything works on the 15-byte records, so a paste carries every field (names included).
//
// kind: 'enc' (a knob's turn) or 'push' (a knob's push, or a key).

import * as M from './model.js';

const value = (cell, kind) => (kind === 'enc' ? cell.enc : cell.push);

// Whether `field` means something on cell c (its rules), so a bulk change leaves the rest alone.
export function fieldApplies(img, p, c, kind, field) {
  const cell = M.readCell(img, p, c);
  if (kind === 'enc') {
    if (M.isKey(c)) return false;
    if (field === 'type') return true;
    if (cell.enc.off) return false;
    return !!M.encoderRules(cell.enc, c)[field]?.enabled;
  }
  if (field === 'type') return true;
  if (cell.push.off) return false;
  return !!M.pushRules(cell.push, c)[field]?.enabled;
}

export function readField(img, p, c, kind, field) {
  return value(M.readCell(img, p, c), kind)[field];
}

function setField(img, p, c, kind, field, v) {
  if (kind === 'enc') M.setEncoder(img, p, c, field, v);
  else M.setPush(img, p, c, field, v);
}

// The largest value `field` takes on cell c: 15 for a channel (3 for a page), else its rule's max.
function fieldMax(img, p, c, kind, field) {
  const cell = M.readCell(img, p, c);
  if (kind === 'enc') {
    const r = M.encoderRules(cell.enc, c)[field];
    return field === 'channel' ? 15 : r?.max ?? 127;
  }
  const r = M.pushRules(cell.push, c)[field];
  return field === 'channel' ? (r?.kind === 'page' ? 3 : 15) : 127;
}

// Sets one field on every cell it applies to. Returns how many it set.
export function applyField(img, p, cells, kind, field, v) {
  let n = 0;
  for (const c of cells) {
    if (!fieldApplies(img, p, c, kind, field)) continue;
    if (kind === 'push' && field === 'type' && M.isKey(c) && !M.pushTypeOnKey(v)) continue; // a key has no encoder

    setField(img, p, c, kind, field, v);
    n++;
  }
  return n;
}

// Ascending values in cell order, from the first cell's value on, wrapping at each cell's range
// (channels 1-16, CC numbers 0-127, 14-bit MSBs 0-31). Cells the field doesn't apply to are
// skipped. Returns how many were filled.
export function fill(img, p, cells, kind, field) {
  const order = [...cells].sort((a, b) => a - b).filter((c) => fieldApplies(img, p, c, kind, field));
  if (!order.length) return 0;
  const start = readField(img, p, order[0], kind, field);
  order.forEach((c, k) => setField(img, p, c, kind, field, (start + k) % (fieldMax(img, p, c, kind, field) + 1)));
  return order.length;
}

// The records of the cells, in cell order.
export function copyCells(img, p, cells) {
  return [...cells].sort((a, b) => a - b).map((c) => M.readRecord(img, p, c));
}

// One record goes into every target; several into consecutive cells from the first target on,
// knobs into knobs and keys into keys, as many as fit. The last knob and the last key have no
// link. Returns the cells written.
export function pasteCells(img, p, targets, recs) {
  const sorted = [...targets].sort((a, b) => a - b);
  if (!sorted.length || !recs.length) return [];
  const last = M.isKey(sorted[0]) ? M.CELLS - 1 : M.KNOBS - 1;
  const pairs = recs.length === 1
    ? sorted.map((c) => [c, recs[0]])
    : recs.map((r, k) => [sorted[0] + k, r]).filter(([c]) => c <= last);
  for (const [c, rec] of pairs) {
    const r = Uint8Array.from(rec);
    if (c === M.KNOBS - 1 || c === M.CELLS - 1) {
      r[1] = r[1] === 0xFF ? 0xFF : r[1] & 0x7F; // no link on the last knob or key
      r[14] = r[14] === 0xFF ? 0xFF : r[14] & 0x7F;
    }
    M.writeRecord(img, p, c, r);
  }
  return pairs.map(([c]) => c);
}

// The cells from a to b (inclusive), as Shift-click selects them: knobs and keys apart, a range
// that starts on a knob stays on the knobs.
export function cellRange(a, b) {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const out = [];
  for (let c = lo; c <= hi; c++) if (M.isKey(c) === M.isKey(a)) out.push(c);
  return out;
}
