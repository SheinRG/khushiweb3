// Explorer tab: latest blocks as a visual chain, block/tx/address details, mempool.
import { api } from './api.js';
import { $, esc, short, hashHtml, timeAgo, fmtNum, toast, motion, enter, spring, ref } from './ui.js';

let topHash = null;
let lastBlocks = null;
let hasRendered = false;
let mempoolKey = null;
let openItem = null; // { kind, id } currently shown in the detail panel

// ------------------------------------------------------------ block strip ---

function blockCard(block) {
  const isOpen = openItem?.kind === 'block' && Number(openItem.id) === block.index;
  return `
    <button data-open="block:${block.index}" class="block-card group relative w-44 shrink-0 rounded-xl border p-3.5 text-left transition
      ${isOpen ? 'border-accent/60 bg-accent/[0.07]' : 'border-line bg-ink/60 hover:border-slate-600 hover:bg-white/[0.03]'}">
      <div class="flex items-center justify-between text-[11px] text-muted">
        <span>${block.index === 0 ? 'Genesis' : 'Block'}</span><span>${block.index === 0 ? '' : timeAgo(block.timestamp)}</span>
      </div>
      <p class="mt-1 text-xl font-semibold text-white">#${block.index}</p>
      <p class="mt-1 truncate font-mono text-[11.5px] text-slate-400">${hashHtml(block.hash, 22)}</p>
      <div class="mt-3 flex items-center justify-between text-[11px] text-muted">
        <span>${block.txCount} tx${block.txCount === 1 ? '' : 's'}</span>
        <span class="rounded-md bg-white/5 px-1.5 py-0.5 font-mono">d${block.difficulty}</span>
      </div>
    </button>`;
}

// The short line between cards stands for "previousHash points back here".
const link = '<div class="flex w-7 shrink-0 items-center" aria-hidden="true"><div class="h-px w-full bg-linear-to-r from-line to-accent/50"></div></div>';

function renderBlocks(blocks) {
  const strip = $('#block-strip');
  const newTop = blocks[0]?.hash;
  const isNewBlock = hasRendered && newTop !== topHash;
  strip.innerHTML = blocks.map(blockCard).join(link);
  if (!hasRendered) enter([...strip.querySelectorAll('.block-card')], 0.035);
  hasRendered = true;
  topHash = newTop;
  lastBlocks = blocks;
  if (isNewBlock) {
    const card = strip.querySelector('.block-card');
    motion(card, { opacity: [0, 1], x: [-30, 0], scale: [0.9, 1] }, spring);
    motion(card, { boxShadow: ['0 0 0 2px rgba(62,230,168,.7)', '0 0 0 0 rgba(62,230,168,0)'] }, { duration: 1.4 });
  }
}

// --------------------------------------------------------------- mempool ---

function txRow(tx, { showStatus = false } = {}) {
  const reward = tx.from === 'COINBASE';
  return `
    <div class="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-ink/50 px-3.5 py-2.5 sm:grid-cols-[1.2fr_2fr_auto]">
      <div class="min-w-0">${ref('tx', tx.hash, short(tx.hash, 8, 4))}</div>
      <div class="order-3 col-span-2 min-w-0 truncate font-mono text-xs text-muted sm:order-none sm:col-span-1">
        ${reward ? '<span class="text-accent">COINBASE</span>' : ref('address', tx.from, short(tx.from, 6, 4))}
        <span class="mx-1">→</span>${ref('address', tx.to, short(tx.to, 6, 4))}
      </div>
      <div class="text-right text-sm font-semibold tabular-nums text-white">${fmtNum(tx.amount)}
        <span class="text-xs font-normal text-muted">${reward ? 'reward' : `fee ${tx.fee}`}</span>
        ${showStatus ? `<span class="ml-1 text-xs font-normal ${tx.status === 'pending' ? 'text-warn' : 'text-muted'}">${tx.status === 'pending' ? 'pending' : `#${tx.blockIndex}`}</span>` : ''}
      </div>
    </div>`;
}

function renderMempool({ transactions }) {
  const key = transactions.map((t) => t.hash).join();
  if (key === mempoolKey) return;
  mempoolKey = key;
  const list = $('#mempool-list');
  list.innerHTML = transactions.length
    ? `<div class="space-y-2">${transactions.map((tx) => txRow(tx)).join('')}</div>`
    : '<p class="py-4 text-center text-sm text-muted">Empty. Every transaction has been mined.</p>';
  enter([...list.querySelectorAll('.space-y-2 > div')], 0.03);
}

// ---------------------------------------------------------------- details ---

const field = (label, value, mono = true) => `
  <div class="min-w-0 rounded-xl border border-line bg-ink/50 px-3.5 py-2.5">
    <dt class="label">${label}</dt>
    <dd class="mt-1 break-all text-sm text-white ${mono ? 'font-mono text-[12.5px]' : ''}">${value}</dd>
  </div>`;

function blockDetail(block) {
  const coinbase = block.transactions[0];
  return `
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-2xl font-semibold text-white">Block #${block.index}</h2>
      <span class="chip">${block.confirmations} confirmation${block.confirmations === 1 ? '' : 's'}</span>
      ${block.index === 0 ? '<span class="chip text-accent">hardcoded genesis</span>' : ''}
    </div>
    <dl class="mt-4 grid gap-2.5 sm:grid-cols-2">
      ${field('Hash', hashHtml(block.hash))}
      ${field('Previous hash', block.index > 0 ? ref('block', String(block.index - 1), block.previousHash) : esc(block.previousHash))}
      ${field('Merkle root', esc(block.merkleRoot))}
      ${field('Mined by', coinbase ? ref('address', coinbase.to, coinbase.to) : '—')}
      ${field('Nonce', fmtNum(block.nonce))}
      ${field('Difficulty', `${block.difficulty} → hash starts with <span class="zeros">${'0'.repeat(block.difficulty)}</span>`)}
      ${field('Timestamp', `${new Date(block.timestamp).toLocaleString()} <span class="text-muted">(${timeAgo(block.timestamp)})</span>`, false)}
      ${field('Transactions', String(block.transactions.length), false)}
    </dl>
    <p class="mt-3 text-xs text-muted">The hash covers the header only (index, timestamp, previous hash, Merkle root, nonce, difficulty). The Merkle root commits to every transaction below.</p>
    <h3 class="mt-5 mb-2 text-sm font-semibold text-white">Transactions</h3>
    <div class="space-y-2">${block.transactions.map((tx) => txRow(tx)).join('') || '<p class="text-sm text-muted">No transactions (genesis).</p>'}</div>`;
}

function txDetail({ status, transaction: tx, blockIndex, confirmations }) {
  const reward = tx.from === 'COINBASE';
  return `
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-2xl font-semibold text-white">${reward ? 'Coinbase transaction' : 'Transaction'}</h2>
      ${status === 'pending'
        ? '<span class="chip border-warn/40 text-warn">pending in mempool</span>'
        : `<span class="chip border-accent/40 text-accent">confirmed · ${confirmations} conf.</span>`}
    </div>
    <dl class="mt-4 grid gap-2.5 sm:grid-cols-2">
      ${field('Hash', esc(tx.hash))}
      ${field('Block', status === 'pending' ? '<span class="text-warn">not mined yet</span>' : ref('block', String(blockIndex), `#${blockIndex}`))}
      ${field('From', reward ? '<span class="text-accent">COINBASE</span> (new coins)' : ref('address', tx.from, tx.from))}
      ${field('To', ref('address', tx.to, tx.to))}
      ${field('Amount', `${fmtNum(tx.amount)} MINI`, false)}
      ${field('Fee', `${fmtNum(tx.fee)} MINI`, false)}
      ${field('Nonce', `${tx.nonce}${reward ? ' <span class="text-muted">(= block index)</span>' : ''}`)}
      ${field('Timestamp', new Date(tx.timestamp).toLocaleString(), false)}
    </dl>
    ${reward ? '<p class="mt-3 text-xs text-muted">A coinbase has no signature: the block rules only allow it to pay the block reward plus the fees of the block.</p>' : `
    <dl class="mt-2.5 grid gap-2.5">
      ${field('Public key (SPKI, hex)', `<span class="text-slate-400">${esc(tx.publicKey)}</span>`)}
      ${field('Signature (ECDSA r‖s)', `<span class="text-slate-400">${esc(tx.signature)}</span>`)}
    </dl>
    <p class="mt-3 text-xs text-muted">Anyone can verify: sha256(public key) gives the "from" address, and the signature over the hash checks out with the public key.</p>`}`;
}

function addressDetail(info) {
  return `
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-2xl font-semibold text-white">Address</h2>
      <code class="chip font-mono">${esc(info.address)}</code>
    </div>
    <dl class="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      ${field('Balance', `${fmtNum(info.balance)} MINI`, false)}
      ${field('After pending', `${fmtNum(info.pendingBalance)} MINI`, false)}
      ${field('Nonce (txs sent)', String(info.nonce), false)}
      ${field('Transactions', String(info.transactions.length), false)}
    </dl>
    <p class="mt-3 text-xs text-muted">The chain stores no balances. This number is computed by replaying every transaction since genesis.</p>
    <h3 class="mt-5 mb-2 text-sm font-semibold text-white">History</h3>
    <div class="space-y-2">${info.transactions.map((tx) => txRow(tx, { showStatus: true })).join('') || '<p class="text-sm text-muted">No transactions for this address.</p>'}</div>`;
}

const loaders = {
  block: async (id) => blockDetail(await api.get(`/blocks/${id}`)),
  tx: async (id) => txDetail(await api.get(`/tx/${id}`)),
  address: async (id) => addressDetail(await api.get(`/address/${id}`)),
};

export async function openDetail(kind, id, { animateIn = true } = {}) {
  const panel = $('#detail');
  try {
    const html = await loaders[kind](id);
    openItem = { kind, id };
    panel.innerHTML = `
      <div class="mb-3 flex justify-end"><button class="text-xs text-muted hover:text-white" data-close-detail>Close ✕</button></div>${html}`;
    panel.hidden = false;
    if (animateIn) {
      motion(panel, { opacity: [0, 1], y: [16, 0] }, spring);
      enter([...panel.querySelectorAll('dl > div')], 0.02);
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    if (lastBlocks) renderBlocks(lastBlocks); // re-highlight the selected block card
  } catch (err) {
    if (animateIn) toast(`${kind} not found: ${err.message}`, 'error');
  }
}

export async function refreshExplorer() {
  const [blocks, mempool] = await Promise.all([api.get('/blocks?limit=15'), api.get('/mempool')]);
  renderBlocks(blocks);
  renderMempool(mempool);
  // Keep the open detail fresh (e.g. a pending tx becoming confirmed).
  if (openItem) await openDetail(openItem.kind, openItem.id, { animateIn: false });
}

export function resetExplorer() {
  topHash = null;
  lastBlocks = null;
  hasRendered = false;
  mempoolKey = null;
  openItem = null;
  $('#detail').hidden = true;
}

export function initExplorer() {
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#search-input').value.trim().toLowerCase();
    if (/^\d+$/.test(q)) openDetail('block', q);
    else if (/^[0-9a-f]{64}$/.test(q)) openDetail('tx', q);
    else if (/^[0-9a-f]{40}$/.test(q)) openDetail('address', q);
    else toast('Enter a block number, a 64-char tx hash or a 40-char address', 'error');
  });
  $('#detail').addEventListener('click', (e) => {
    if (e.target.closest('[data-close-detail]')) {
      openItem = null;
      motion('#detail', { opacity: 0, y: 8 }, { duration: 0.2 })?.then(() => { $('#detail').hidden = true; });
      if (lastBlocks) renderBlocks(lastBlocks);
    }
  });
}
