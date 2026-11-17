import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Blockchain } from './blockchain.js';
import { P2PNetwork } from './p2p.js';
import { generateWallet } from './wallet.js';
import { ChainError } from './errors.js';
import { isAddress } from './crypto-utils.js';

// A NODE = a copy of the blockchain + a REST API + connections to peers.
// Every node keeps and validates its own full copy: there is no central server.

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');
const MAX_BODY_BYTES = 1024 * 1024;
const SYNC_INTERVAL_MS = 15_000;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ------------------------------------------------------------------ helpers ---

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object') throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'request body must be a JSON object');
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}

// Tiny router: '/blocks/:index' -> regex with a named group.
function compileRoute(method, path, handler) {
  const pattern = path.replace(/:(\w+)/g, '(?<$1>[^/]+)');
  return { method, regex: new RegExp(`^${pattern}$`), handler };
}

async function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const filePath = normalize(join(PUBLIC_DIR, relative));
  if (!filePath.startsWith(PUBLIC_DIR + sep)) return false; // blocks "../" path traversal
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream' });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

function blockSummary(block) {
  return {
    index: block.index,
    hash: block.hash,
    previousHash: block.previousHash,
    timestamp: block.timestamp,
    nonce: block.nonce,
    difficulty: block.difficulty,
    txCount: block.transactions.length,
    miner: block.transactions[0]?.to ?? null,
  };
}

// --------------------------------------------------------------------- node ---

export async function createNode({
  port = 3001,
  peers = [],
  dataDir = join(ROOT, 'data'),
  config = {},
  verbose = false,
  quiet = false,
} = {}) {
  const log = quiet ? () => {} : (msg) => console.log(`[${port}] ${msg}`);
  const blockchain = new Blockchain({ config, dataFile: dataDir && port ? join(dataDir, `node-${port}.json`) : null });

  const server = createServer();
  server.listen(port);
  await once(server, 'listening');
  const actualPort = server.address().port;
  const selfUrl = `http://localhost:${actualPort}`;
  const p2p = new P2PNetwork({ selfUrl, blockchain, log });
  for (const peer of peers) p2p.addPeer(peer);

  const routes = [
    compileRoute('GET', '/chain', () => ({
      body: { length: blockchain.chain.length, cumulativeWork: Blockchain.cumulativeWork(blockchain.chain), chain: blockchain.chain },
    })),

    // Latest blocks, newest first (used by the explorer). ?limit=10
    compileRoute('GET', '/blocks', ({ query }) => {
      const limit = Math.min(Math.max(Number(query.get('limit')) || 10, 1), 100);
      return { body: blockchain.chain.slice(-limit).reverse().map(blockSummary) };
    }),

    compileRoute('GET', '/blocks/:index', ({ params }) => {
      const block = blockchain.getBlock(Number(params.index));
      if (!/^\d+$/.test(params.index) || !block) throw new HttpError(404, `block ${params.index} not found`);
      return { body: { ...block.toJSON(), confirmations: blockchain.chain.length - block.index } };
    }),

    compileRoute('GET', '/tx/:hash', ({ params }) => {
      const found = blockchain.findTransaction(params.hash);
      if (!found) throw new HttpError(404, 'transaction not found');
      return { body: found };
    }),

    compileRoute('GET', '/mempool', () => ({ body: { size: blockchain.mempool.length, transactions: blockchain.mempool } })),

    compileRoute('GET', '/balance/:address', ({ params }) => {
      if (!isAddress(params.address)) throw new HttpError(400, 'address must be 40 hex characters');
      const confirmed = blockchain.getAccount(params.address);
      const pending = blockchain.getPendingAccount(params.address);
      return {
        body: {
          address: params.address,
          balance: confirmed.balance,
          nonce: confirmed.nonce,
          pendingBalance: pending.balance,
          nextNonce: pending.nonce, // the nonce to use for the next transaction
        },
      };
    }),

    compileRoute('GET', '/address/:address', ({ params }) => {
      if (!isAddress(params.address)) throw new HttpError(400, 'address must be 40 hex characters');
      return { body: blockchain.getAddressInfo(params.address) };
    }),

    compileRoute('GET', '/peers', () => ({ body: { self: selfUrl, peers: p2p.list() } })),

    compileRoute('GET', '/stats', () => ({
      body: { node: selfUrl, ...blockchain.getStats(), peerCount: p2p.peers.size, peers: p2p.list() },
    })),

    compileRoute('POST', '/wallet/new', () => ({
      status: 201,
      body: {
        warning: 'FOR LOCAL LEARNING ONLY. This private key was generated by a server and sent over the network. Never do this with real money: real wallets create keys on your own device.',
        ...generateWallet(),
      },
    })),

    compileRoute('POST', '/transactions', ({ body }) => {
      const tx = blockchain.addTransaction(body.transaction ?? body);
      log(`💸 new tx ${tx.hash.slice(0, 10)}… ${tx.amount} coins ${tx.from.slice(0, 8)}… → ${tx.to.slice(0, 8)}…`);
      p2p.broadcastTransaction(tx);
      return { status: 201, body: { message: 'transaction accepted into the mempool', transaction: tx } };
    }),

    compileRoute('POST', '/mine', ({ body }) => {
      const { block, attempts, timeMs } = blockchain.minePendingTransactions(body.minerAddress);
      log(`⛏  mined block #${block.index} in ${timeMs}ms (nonce ${block.nonce}, ${block.transactions.length - 1} txs) ${block.hash.slice(0, 16)}…`);
      p2p.broadcastBlock(block);
      return { status: 201, body: { message: `block #${block.index} mined`, timeMs, attempts, nonce: block.nonce, block } };
    }),

    compileRoute('POST', '/peers', ({ body }) => {
      let added;
      try { added = p2p.addPeer(body.url); } catch { throw new HttpError(400, 'body.url must be an http(s) URL'); }
      if (added) {
        log(`🤝 new peer ${P2PNetwork.normalize(body.url)}`);
        p2p.syncFrom(body.url).catch(() => {});
      }
      return { status: added ? 201 : 200, body: { added, peers: p2p.list() } };
    }),

    // ---- peer-to-peer endpoints ----

    compileRoute('POST', '/transactions/receive', ({ body }) => {
      try {
        const tx = blockchain.addTransaction(body.transaction);
        log(`📨 tx ${tx.hash.slice(0, 10)}… received from ${body.sender ?? 'unknown'}`);
        p2p.broadcastTransaction(tx, body.sender); // relay only NEW transactions
        return { status: 201, body: { status: 'added' } };
      } catch (err) {
        if (err.code === 'duplicate') return { body: { status: 'known' } };
        throw err;
      }
    }),

    compileRoute('POST', '/blocks/receive', async ({ body }) => {
      const result = blockchain.addBlock(body.block);
      if (result.added) {
        log(`📦 block #${blockchain.latestBlock.index} received from ${body.sender ?? 'unknown'}, appended`);
        p2p.broadcastBlock(blockchain.latestBlock, body.sender); // relay only NEW blocks
        return { status: 201, body: { status: 'added' } };
      }
      if (result.reason === 'known') return { body: { status: 'known' } };

      // The block doesn't fit our tip: we are behind or on a fork.
      // Ask the sender for its full chain and let consensus decide.
      if (result.reason === 'not-linked' && body.sender) {
        log(`🔀 block #${body.block?.index} does not link to our tip, syncing with ${body.sender}`);
        const sync = await p2p.syncFrom(body.sender);
        return { body: { status: sync.replaced ? 'chain-replaced' : 'kept-local-chain', reason: sync.reason } };
      }
      throw new HttpError(400, `block rejected: ${result.reason}`);
    }),
  ];

  server.on('request', async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, selfUrl);

    // Logging: writes and errors always; routine GETs (the UI polls) only with --verbose.
    res.on('finish', () => {
      if (verbose || req.method !== 'GET' || res.statusCode >= 400) {
        log(`${req.method} ${url.pathname} → ${res.statusCode} (${Date.now() - started}ms)`);
      }
    });

    // CORS lets the web UI on one node query the other nodes (network view).
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    try {
      for (const route of routes) {
        const match = route.method === req.method && route.regex.exec(url.pathname);
        if (!match) continue;
        const body = req.method === 'POST' ? await readJsonBody(req) : {};
        const result = await route.handler({ params: match.groups ?? {}, query: url.searchParams, body });
        return sendJson(res, result.status ?? 200, result.body);
      }
      if (req.method === 'GET' && await serveStatic(res, url.pathname)) return;
      throw new HttpError(404, `no route for ${req.method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      if (err instanceof ChainError) return sendJson(res, err.code === 'duplicate' ? 409 : 400, { error: err.message });
      console.error(err);
      return sendJson(res, 500, { error: 'internal server error' });
    }
  });

  // Catch up with the network now and every few seconds afterwards, so a
  // node that was offline or missed a broadcast converges again.
  const ready = p2p.connect();
  const syncTimer = setInterval(() => p2p.syncWithPeers(), SYNC_INTERVAL_MS);
  syncTimer.unref();

  async function close() {
    clearInterval(syncTimer);
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }

  return { server, blockchain, p2p, url: selfUrl, port: actualPort, ready, close };
}

// ---------------------------------------------------------------------- CLI ---

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '3001' },
      peers: { type: 'string', default: '' },
      'data-dir': { type: 'string' },
      verbose: { type: 'boolean', default: false },
    },
  });
  const port = Number(values.port);
  const peers = values.peers.split(',').map((p) => p.trim()).filter(Boolean);
  const node = await createNode({
    port,
    peers,
    verbose: values.verbose,
    ...(values['data-dir'] ? { dataDir: resolve(values['data-dir']) } : {}),
  });

  const stats = node.blockchain.getStats();
  console.log(`[${port}] MiniChain node running at ${node.url}  (height ${stats.height}, difficulty ${stats.difficulty})`);
  console.log(`[${port}] peers: ${node.p2p.list().join(', ') || 'none'}`);

  const shutdown = () => {
    node.blockchain.save();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port already in use: ${err.message}` : err);
    process.exit(1);
  });
}
