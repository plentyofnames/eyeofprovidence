// Tiny DOM helpers.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);

// Replaces the children of `el`, keeping focus (and the caret) on the element with the
// same data-key if there was one.
// A text input being typed in also keeps its text, so a redraw doesn't overwrite what the
// user is typing: when the new value is the typed text up to trailing spaces (names are
// stored as 4 characters), or when it is still the value the box was drawn with (a box that
// commits on change, redrawn for something else before that). If the box now shows another
// value (the device moved to another page), the typed text is dropped instead of landing there.
// (Lilypad e1f3d8b.)
export function replace(el, ...children) {
  const active = document.activeElement;
  const key = active && el.contains(active) ? active.dataset.key : null;
  const caret = key && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  const typed = key && active.tagName === 'INPUT' && active.type === 'text' ? active.value : null;
  const drawn = typed !== null ? active.defaultValue : null;
  el.replaceChildren();
  append(el, children);
  if (key) {
    const again = el.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (again) {
      const same = (a, b) => a.trimEnd() === b.trimEnd();
      if (typed !== null && again.type === 'text' && (same(again.value, typed) || same(again.value, drawn))) again.value = typed;
      again.dataset.restoring = '1'; // tells focus handlers this is not a new focus
      again.focus({ preventScroll: true });
      delete again.dataset.restoring;
      if (caret && again.setSelectionRange && again.type === 'text') {
        try {
          again.setSelectionRange(...caret);
        } catch {}
      }
    }
  }
}

export function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
