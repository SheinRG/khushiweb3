// Network tab: ask every node for its stats and show whether they agree.
import { api, getNode } from './api.js';
import { $, esc, short, hashColor, fmtNum, toast, enter } from './ui.js';

let renderedOnce = false;

export async function refreshNetwork() {
  const { self, peers } = await api.get('/peers');
  const nodes = [self, ...peers];
  const results = await Promise.all(nodes.map((url) =>
    api.get('/stats', url).then((stats) => ({ url, stats })).catch(() => ({ url, offline: true }))));

  // The "best" tip is the one with the most cumulative work.
  const online = results.filter((r) => !r.offline);
  const best = online.reduce((a, b) => (b.stats.cumulativeWork > (a?.stats.cumulativeWork ?? -1) ? b : a), null);

  $('#node-list').innerHTML = results.map(({ url, stats, offline }) => {
    const isCurrent = url === getNode();
    if (offline) {
      return `
        <div class="node-row flex items-center gap-3 rounded-xl border border-danger/25 bg-danger/[0.04] p-3.5">
          <span class="h-2.5 w-2.5 rounded-full bg-danger"></span>
          <span class="font-mono text-sm text-white">${esc(url)}</span>
          <span class="ml-auto text-xs text-danger">offline</span>
        </div>`;
    }
    const synced = stats.latestHash === best.stats.latestHash;
    return `
      <div class="node-row rounded-xl border ${isCurrent ? 'border-accent/40 bg-accent/[0.04]' : 'border-line bg-ink/50'} p-3.5">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="h-2.5 w-2.5 rounded-full ${synced ? 'bg-accent' : 'bg-warn'}"></span>
          <span class="font-mono text-sm text-white">${esc(url)}</span>
          ${isCurrent ? '<span class="chip py-0.5 text-accent">viewing</span>' : ''}
          <span class="ml-auto text-xs ${synced ? 'text-accent' : 'text-warn'}">${synced ? 'in sync' : 'catching up / forked'}</span>
        </div>
        <div class="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <div><p class="label">Height</p><p class="mt-0.5 text-sm font-semibold text-white">#${stats.height}</p></div>
          <div><p class="label">Difficulty</p><p class="mt-0.5 text-sm font-semibold text-white">${stats.difficulty}</p></div>
          <div><p class="label">Mempool</p><p class="mt-0.5 text-sm font-semibold text-white">${stats.mempoolSize}</p></div>
          <div><p class="label">Work</p><p class="mt-0.5 text-sm font-semibold text-white">${fmtNum(stats.cumulativeWork)}</p></div>
        </div>
        <div class="mt-3 flex items-center gap-2 font-mono text-xs">
          <span class="h-3 w-3 shrink-0 rounded" style="background:${hashColor(stats.latestHash)}"></span>
          <span class="text-muted">tip</span><span class="truncate text-slate-300">${esc(short(stats.latestHash, 16, 10))}</span>
        </div>
      </div>`;
  }).join('');

  if (!renderedOnce) enter([...document.querySelectorAll('.node-row')], 0.06);
  renderedOnce = true;
}

export function resetNetwork() {
  renderedOnce = false;
}

export function initNetwork({ onChange }) {
  $('#peer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('#peer-url').value.trim();
    try {
      const { added } = await api.post('/peers', { url });
      toast(added ? `Connected to ${url}` : 'Already a peer', added ? 'success' : 'info');
      $('#peer-url').value = '';
      renderedOnce = false;
      onChange();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}
