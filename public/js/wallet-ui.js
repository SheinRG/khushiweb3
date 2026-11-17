// Wallet tab: manage browser wallets, send signed transactions, mine blocks.
import { api } from './api.js';
import { createBrowserWallet, createSignedTransaction, addressFromPublicKey } from './wallet-crypto.js';
import { $, esc, short, hashHtml, timeAgo, fmtMs, fmtNum, countTo, toast, copyText, motion, enter, spring, ref } from './ui.js';

const STORAGE_KEY = 'minichain.wallets.v1';
const SELECTED_KEY = 'minichain.selected.v1';

// localStorage can be unavailable (private mode, blocked storage): fail soft.
function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not persisted */ }
}

let wallets = load(STORAGE_KEY, []);
let selected = load(SELECTED_KEY, wallets[0]?.address ?? null);
let lastActivityKey = '';
let refreshApp = () => {};
let getStats = () => null;

const current = () => wallets.find((w) => w.address === selected) ?? null;
const persist = () => { store(STORAGE_KEY, wallets); store(SELECTED_KEY, selected); };

function select(address) {
  selected = address;
  persist();
  lastActivityKey = '';
  renderWallets(true);
  refreshWallet();
}

// --------------------------------------------------------------- rendering ---

function renderWallets(animateIn = false) {
  const wallet = current();
  $('#wallet-chips').innerHTML = wallets.map((w) => `
    <button data-address="${esc(w.address)}" class="wallet-chip inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition
      ${w.address === selected ? 'border-accent/50 bg-accent/10 text-white' : 'border-line bg-white/[0.02] text-muted hover:text-white'}">
      <span class="h-2 w-2 rounded-full" style="background:hsl(${parseInt(w.address.slice(0, 6), 16) % 360} 70% 60%)"></span>
      ${esc(w.label)}
    </button>`).join('');

  $('#wallet-empty').hidden = wallets.length > 0;
  $('#wallet-detail').hidden = !wallet;
  if (wallet) $('#wallet-address').textContent = wallet.address;

  // Quick-fill buttons for sending to your other wallets.
  $('#send-quick').innerHTML = wallets.filter((w) => w.address !== selected).map((w) => `
    <button type="button" data-fill="${esc(w.address)}" class="chip hover:border-accent/40 hover:text-white">→ ${esc(w.label)}</button>`).join('');

  if (animateIn) enter([...document.querySelectorAll('.wallet-chip')], 0.03);
}

function renderActivity(transactions, address) {
  const key = transactions.map((t) => t.hash + t.status).join();
  if (key === lastActivityKey) return;
  const isFirstRender = lastActivityKey === '';
  lastActivityKey = key;

  const list = $('#activity');
  if (!transactions.length) {
    list.innerHTML = '<li class="py-6 text-center text-sm text-muted">No transactions yet. Mine a block to earn your first coins.</li>';
    return;
  }
  list.innerHTML = transactions.slice(0, 12).map((tx) => {
    const reward = tx.from === 'COINBASE';
    const incoming = tx.to === address && !reward;
    const outgoing = tx.from === address;
    const sign = outgoing && tx.to !== address ? '−' : '+';
    const amount = outgoing && tx.to !== address ? tx.amount + tx.fee : tx.amount;
    const title = reward ? 'Mining reward' : outgoing ? `Sent to ${short(tx.to, 6, 4)}` : `Received from ${short(tx.from, 6, 4)}`;
    const icon = reward ? '⛏' : incoming ? '↓' : '↑';
    const tone = reward ? 'text-accent bg-accent/10' : incoming ? 'text-accent-2 bg-accent-2/10' : 'text-slate-300 bg-white/5';
    return `
      <li class="activity-row flex items-center gap-3 py-3">
        <span class="grid h-9 w-9 shrink-0 place-items-center rounded-full ${tone}">${icon}</span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm text-white">${esc(title)}</p>
          <p class="text-xs text-muted">${ref('tx', tx.hash, short(tx.hash, 6, 4))} · ${tx.status === 'pending'
            ? '<span class="text-warn">pending</span>'
            : `block #${tx.blockIndex}`} · ${timeAgo(tx.timestamp)}</p>
        </div>
        <span class="font-semibold tabular-nums ${sign === '+' ? 'text-accent' : 'text-slate-200'}">${sign}${fmtNum(amount)}</span>
      </li>`;
  }).join('');
  if (!isFirstRender) enter([...list.children].slice(0, 3));
}

export async function refreshWallet() {
  const wallet = current();
  const stats = getStats();
  if (stats) $('#mine-target').innerHTML = `<span class="zeros">${'0'.repeat(stats.difficulty)}</span>…  (difficulty ${stats.difficulty})`;
  if (!wallet) { $('#activity').innerHTML = ''; lastActivityKey = ''; return; }

  const info = await api.get(`/address/${wallet.address}`);
  if (wallet.address !== selected) return; // user switched wallet meanwhile
  countTo($('#wallet-balance'), info.balance);
  countTo($('#wallet-pending'), info.pendingBalance);
  countTo($('#wallet-nonce'), info.nonce);
  renderActivity(info.transactions, wallet.address);
}

// ----------------------------------------------------------------- actions ---

async function createWallet() {
  const wallet = await createBrowserWallet(`Wallet ${wallets.length + 1}`);
  wallets.push(wallet);
  toast(`${wallet.label} created: ${short(wallet.address)}`, 'success');
  select(wallet.address);
}

async function importWallet(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data.publicKey || !data.privateJwk) throw new Error('not a MiniChain browser wallet file');
    const address = await addressFromPublicKey(data.publicKey);
    if (wallets.some((w) => w.address === address)) throw new Error('wallet already imported');
    wallets.push({ ...data, address, label: data.label || `Wallet ${wallets.length + 1}` });
    toast('Wallet imported', 'success');
    select(address);
  } catch (err) {
    toast(`Import failed: ${err.message}`, 'error');
  }
}

function exportWallet() {
  const wallet = current();
  const blob = new Blob([JSON.stringify(wallet, null, 2)], { type: 'application/json' });
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `minichain-${wallet.address.slice(0, 8)}.json` });
  link.click();
  URL.revokeObjectURL(link.href);
}

let deleteArmed = null;
function deleteWallet() {
  const button = $('#wallet-delete');
  if (!deleteArmed) {
    button.textContent = 'Click again to delete';
    deleteArmed = setTimeout(() => { button.textContent = 'Delete'; deleteArmed = null; }, 3000);
    return;
  }
  clearTimeout(deleteArmed);
  deleteArmed = null;
  button.textContent = 'Delete';
  wallets = wallets.filter((w) => w.address !== selected);
  toast('Wallet deleted from this browser');
  select(wallets[0]?.address ?? null);
}

function renameWallet() {
  const wallet = current();
  const input = Object.assign(document.createElement('input'), { className: 'input py-1.5', value: wallet.label, maxLength: 24 });
  const chip = document.querySelector(`.wallet-chip[data-address="${wallet.address}"]`);
  chip.replaceWith(input);
  input.focus();
  input.select();
  const done = () => {
    wallet.label = input.value.trim() || wallet.label;
    persist();
    renderWallets();
  };
  input.addEventListener('blur', done, { once: true });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
}

async function sendTransaction(event) {
  event.preventDefault();
  const wallet = current();
  if (!wallet) return toast('Create a wallet first', 'error');

  const to = $('#send-to').value.trim().toLowerCase();
  const amount = Number($('#send-amount').value);
  const fee = Number($('#send-fee').value || 0);
  if (!/^[0-9a-f]{40}$/.test(to)) return toast('Recipient must be a 40-character hex address', 'error');
  if (!Number.isSafeInteger(amount) || amount <= 0) return toast('Amount must be a whole number above 0', 'error');
  if (!Number.isSafeInteger(fee) || fee < 0) return toast('Fee must be a whole number ≥ 0', 'error');

  const button = $('#send-btn');
  button.disabled = true;
  button.textContent = 'Signing…';
  try {
    // The nonce must be the next one the chain expects (counting pending txs).
    const { nextNonce } = await api.get(`/balance/${wallet.address}`);
    const tx = await createSignedTransaction(wallet, { to, amount, fee, nonce: nextNonce });
    button.textContent = 'Broadcasting…';
    await api.post('/transactions', tx);

    const result = $('#send-result');
    result.innerHTML = `
      <div class="mt-4 rounded-xl border border-accent/30 bg-accent/[0.06] p-4 text-sm">
        <p class="font-medium text-accent">✓ Signed in your browser and accepted into the mempool</p>
        <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
          <dt class="text-muted">hash</dt><dd class="truncate">${ref('tx', tx.hash, short(tx.hash, 14, 8))}</dd>
          <dt class="text-muted">signature</dt><dd class="truncate text-slate-400">${esc(short(tx.signature, 18, 8))}</dd>
          <dt class="text-muted">nonce</dt><dd>${tx.nonce}</dd>
        </dl>
        <details class="mt-2 text-xs">
          <summary class="cursor-pointer text-muted hover:text-white">What exactly was signed?</summary>
          <pre class="scroll-thin mt-2 overflow-x-auto rounded-lg bg-ink/80 p-3 text-[11px] leading-relaxed text-slate-400">${esc(JSON.stringify(tx, null, 2))}</pre>
        </details>
        <p class="mt-2 text-xs text-muted">Now mine a block to confirm it.</p>
      </div>`;
    motion(result.firstElementChild, { opacity: [0, 1], scale: [0.97, 1] }, spring);
    $('#send-amount').value = '';
    toast(`Sent ${amount} MINI (fee ${fee})`, 'success');
    refreshApp();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Sign & broadcast';
  }
}

// While the node mines (one HTTP request), show random hashes rolling by.
// It's only a visual: the real search happens on the server.
function startHashAnimation(difficulty) {
  const hashEl = $('#mine-hash');
  const hex = '0123456789abcdef';
  const timer = setInterval(() => {
    let h = '';
    for (let i = 0; i < 64; i++) h += hex[(Math.random() * 16) | 0];
    hashEl.innerHTML = `<span class="text-slate-500">${h.slice(0, difficulty)}</span>${h.slice(difficulty)}`;
  }, 45);
  return () => clearInterval(timer);
}

async function mineBlock() {
  const wallet = current();
  if (!wallet) return toast('Create a wallet first: it receives the mining reward', 'error');

  const button = $('#mine-btn');
  const card = $('#mine-card');
  button.disabled = true;
  $('#mine-label').textContent = 'Mining…';
  card.classList.add('is-mining');
  const stop = startHashAnimation(getStats()?.difficulty ?? 3);
  try {
    const result = await api.post('/mine', { minerAddress: wallet.address }, { timeout: 180_000 });
    stop();
    $('#mine-hash').innerHTML = hashHtml(result.block.hash);
    $('#mr-block').innerHTML = ref('block', String(result.block.index), `#${result.block.index}`);
    $('#mr-time').textContent = fmtMs(result.timeMs);
    $('#mr-nonce').textContent = fmtNum(result.nonce);
    $('#mr-attempts').textContent = fmtNum(result.attempts);
    const dl = $('#mine-result');
    dl.hidden = false;
    enter([...dl.children], 0.06);
    motion('#mine-hash', { scale: [1.03, 1], opacity: [0.4, 1] }, spring);
    const txCount = result.block.transactions.length - 1;
    toast(`Block #${result.block.index} mined with ${txCount} transaction${txCount === 1 ? '' : 's'}`, 'success');
    refreshApp();
  } catch (err) {
    stop();
    $('#mine-hash').textContent = 'mining failed';
    toast(err.message, 'error');
  } finally {
    card.classList.remove('is-mining');
    button.disabled = false;
    $('#mine-label').textContent = 'Mine block';
  }
}

export function initWallet({ onChange, stats }) {
  refreshApp = onChange;
  getStats = stats;
  if (!current() && wallets.length) selected = wallets[0].address;
  renderWallets();

  $('#wallet-new').addEventListener('click', () => createWallet().catch((err) => toast(err.message, 'error')));
  $('#wallet-import').addEventListener('change', (e) => { if (e.target.files[0]) importWallet(e.target.files[0]); e.target.value = ''; });
  $('#wallet-copy').addEventListener('click', () => copyText(selected));
  $('#wallet-export').addEventListener('click', exportWallet);
  $('#wallet-delete').addEventListener('click', deleteWallet);
  $('#wallet-rename').addEventListener('click', renameWallet);
  $('#wallet-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-address]');
    if (chip && chip.dataset.address !== selected) select(chip.dataset.address);
  });
  $('#send-quick').addEventListener('click', (e) => {
    const button = e.target.closest('[data-fill]');
    if (button) $('#send-to').value = button.dataset.fill;
  });
  $('#send-form').addEventListener('submit', sendTransaction);
  $('#mine-btn').addEventListener('click', mineBlock);
}
