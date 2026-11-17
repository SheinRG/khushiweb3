// Small UI helpers: DOM shortcuts, formatting, animations (Motion) and toasts.
const { animate, stagger } = window.Motion;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

export { stagger };

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// Motion's animate(), but instant for people who prefer reduced motion.
export function motion(target, keyframes, options = {}) {
  if (!target || (Array.isArray(target) && target.length === 0)) return null;
  return animate(target, keyframes, reducedMotion ? { duration: 0 } : options);
}

export const spring = { type: 'spring', stiffness: 380, damping: 32 };

export function enter(elements, delayStep = 0.04) {
  const list = Array.isArray(elements) ? elements : [elements];
  return motion(list, { opacity: [0, 1], y: [12, 0] }, { duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: stagger(delayStep) });
}

// Escape everything that comes from the network before putting it in HTML.
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function short(hash, head = 8, tail = 6) {
  if (!hash || hash.length <= head + tail + 1) return hash ?? '';
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

// Highlight the leading zeros: they ARE the proof of work.
export function hashHtml(hash, maxLength) {
  const text = maxLength && hash.length > maxLength ? `${hash.slice(0, maxLength)}…` : hash;
  const zeros = text.match(/^0*/)[0];
  return `<span class="zeros">${zeros}</span>${esc(text.slice(zeros.length))}`;
}

export function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function fmtMs(ms) {
  if (ms == null) return '–';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

export const fmtNum = (n) => Number(n).toLocaleString();

// Smoothly count from the previous value to the new one.
export function countTo(el, value) {
  if (!el) return;
  const from = Number(el.dataset.value ?? value);
  el.dataset.value = value;
  if (from === value || reducedMotion) { el.textContent = fmtNum(value); return; }
  animate(from, value, { duration: 0.7, ease: 'easeOut', onUpdate: (v) => { el.textContent = fmtNum(Math.round(v)); } });
  motion(el, { scale: [1.08, 1] }, { duration: 0.4 });
}

export function toast(message, type = 'info') {
  const colors = {
    info: 'border-line text-slate-200',
    success: 'border-accent/40 text-accent',
    error: 'border-danger/40 text-danger',
  };
  const node = document.createElement('div');
  node.className = `pointer-events-auto max-w-sm rounded-xl border bg-panel/95 px-4 py-3 text-sm shadow-2xl shadow-black/50 backdrop-blur ${colors[type]}`;
  node.textContent = message;
  $('#toasts').append(node);
  motion(node, { opacity: [0, 1], y: [16, 0], scale: [0.96, 1] }, spring);
  setTimeout(async () => {
    await motion(node, { opacity: 0, x: 24 }, { duration: 0.25 });
    node.remove();
  }, type === 'error' ? 5000 : 3200);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard', 'success');
  } catch {
    toast('Could not copy (clipboard blocked)', 'error');
  }
}

// A stable colour per hash, so identical chain tips look identical.
export const hashColor = (hash) => `hsl(${parseInt(hash.slice(-6), 16) % 360} 75% 62%)`;

// Clickable reference that opens something in the explorer (handled in app.js).
export function ref(kind, id, label = short(id)) {
  return `<a class="link font-mono" data-open="${kind}:${esc(id)}">${esc(label)}</a>`;
}
