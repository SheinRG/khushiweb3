// Entry point: tabs, header stats, node switching and the polling loop.
import { api, getNode, setNode } from './api.js';
import { initWallet, refreshWallet } from './wallet-ui.js';
import { initExplorer, refreshExplorer, resetExplorer, openDetail } from './explorer.js';
import { initNetwork, refreshNetwork, resetNetwork } from './network.js';
import { $, $$, motion, enter, spring, countTo, fmtMs, toast } from './ui.js';

const POLL_MS = 3000;
const TABS = ['wallet', 'explorer', 'network'];
const refreshers = { wallet: refreshWallet, explorer: refreshExplorer, network: refreshNetwork };

let activeTab = null;
let stats = null;
const knownNodes = new Set([location.origin]);

// --------------------------------------------------------------------- tabs ---

function moveIndicator(button, instant) {
  const indicator = $('#tab-indicator');
  const target = { x: button.offsetLeft, width: button.offsetWidth };
  motion(indicator, target, instant ? { duration: 0 } : spring);
}

function showTab(name) {
  if (!TABS.includes(name)) name = 'wallet';
  if (name === activeTab) return;
  const first = activeTab === null;
  activeTab = name;

  for (const button of $$('[data-tab]')) {
    const selected = button.dataset.tab === name;
    button.setAttribute('aria-selected', String(selected));
    if (selected) moveIndicator(button, first);
  }
  for (const panel of $$('[data-panel]')) panel.hidden = panel.dataset.panel !== name;

  const panel = $(`[data-panel="${name}"]`);
  enter([...panel.children], 0.05);
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  tick();
}

// -------------------------------------------------------------------- stats ---

async function refreshStats() {
  stats = await api.get('/stats');
  countTo($('#stat-height'), stats.height);
  countTo($('#stat-difficulty'), stats.difficulty);
  countTo($('#stat-peers'), stats.peerCount);
  countTo($('#stat-mempool'), stats.mempoolSize);
  $('#stat-zeros').textContent = '0'.repeat(stats.difficulty);
  $('#stat-blocktime').textContent = fmtMs(stats.averageBlockTimeMs);
  $('#stat-target').textContent = fmtMs(stats.targetBlockTimeMs);

  // Offer every node we have heard of in the node switcher.
  const before = knownNodes.size;
  [stats.node, ...stats.peers].forEach((url) => knownNodes.add(url));
  if (knownNodes.size !== before || !$('#node-select').options.length) renderNodeSelect();
}

function renderNodeSelect() {
  const select = $('#node-select');
  select.innerHTML = [...knownNodes].sort().map((url) =>
    `<option value="${url}" ${url === getNode() ? 'selected' : ''}>${url.replace(/^https?:\/\//, '')}</option>`).join('');
}

function setLive(ok) {
  $('#live').classList.toggle('offline', !ok);
  $('#live').title = ok ? `Connected to ${getNode()}` : `Cannot reach ${getNode()}`;
}

// --------------------------------------------------------------------- loop ---

let ticking = false;
let wasOffline = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await refreshStats();
    await refreshers[activeTab]?.();
    setLive(true);
    if (wasOffline) toast(`Reconnected to ${getNode()}`, 'success');
    wasOffline = false;
  } catch (err) {
    setLive(false);
    if (!wasOffline) toast(`Node unreachable: ${err.message}`, 'error');
    wasOffline = true;
  } finally {
    ticking = false;
  }
}

// --------------------------------------------------------------------- boot ---

function boot() {
  initWallet({ onChange: tick, stats: () => stats });
  initExplorer();
  initNetwork({ onChange: tick });

  for (const button of $$('[data-tab]')) button.addEventListener('click', () => showTab(button.dataset.tab));
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
  window.addEventListener('resize', () => moveIndicator($(`[data-tab="${activeTab}"]`), true));

  // Any element with data-open="kind:id" opens that item in the explorer.
  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-open]');
    if (!target) return;
    e.preventDefault();
    const [kind, id] = target.dataset.open.split(':');
    showTab('explorer');
    openDetail(kind, id);
  });

  $('#node-select').addEventListener('change', (e) => {
    setNode(e.target.value);
    resetExplorer();
    resetNetwork();
    toast(`Now viewing ${e.target.value}`);
    tick();
  });

  renderNodeSelect();
  motion(document.body, { opacity: [0, 1] }, { duration: 0.4 });
  enter($$('.stat'), 0.05);
  showTab(location.hash.slice(1) || 'wallet');
  setInterval(tick, POLL_MS);
}

// The Tailwind browser build generates CSS at runtime; wait one frame for it.
requestAnimationFrame(boot);
