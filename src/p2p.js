// P2P networking over plain HTTP.
// Real blockchains use a gossip protocol over TCP (Bitcoin) or libp2p
// (Ethereum). MiniChain keeps the same IDEAS with simple HTTP calls:
//   1. Broadcast: tell every known peer about new transactions and blocks.
//   2. Relay: a node that accepts something NEW forwards it to its own peers.
//      Things it already knows are not forwarded, so messages don't loop forever.
//   3. Sync: if a block doesn't fit on our chain, download the sender's whole
//      chain and let consensus (most cumulative work) decide.
export class P2PNetwork {
  constructor({ selfUrl, blockchain, log = console.log, timeoutMs = 3000 }) {
    this.selfUrl = P2PNetwork.normalize(selfUrl);
    this.blockchain = blockchain;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.peers = new Set();
  }

  // Store peers as "http://host:port" so the same peer isn't added twice.
  static normalize(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('peer URL must be http(s)');
    return parsed.origin;
  }

  addPeer(url) {
    const peer = P2PNetwork.normalize(url);
    if (peer === this.selfUrl || this.peers.has(peer)) return false;
    this.peers.add(peer);
    return true;
  }

  list() {
    return [...this.peers];
  }

  async request(peer, path, body) {
    const res = await fetch(`${peer}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data;
  }

  // Fire-and-forget: one offline peer must not slow down or break the others.
  broadcast(path, body, exceptPeer) {
    const targets = this.list().filter((peer) => peer !== exceptPeer);
    return Promise.allSettled(targets.map((peer) => this.request(peer, path, body).catch((err) => {
      this.log(`  ↳ peer ${peer} did not accept ${path}: ${err.message}`);
    })));
  }

  broadcastTransaction(tx, exceptPeer) {
    return this.broadcast('/transactions/receive', { transaction: tx, sender: this.selfUrl }, exceptPeer);
  }

  broadcastBlock(block, exceptPeer) {
    return this.broadcast('/blocks/receive', { block, sender: this.selfUrl }, exceptPeer);
  }

  // Download a peer's chain and run consensus on it.
  async syncFrom(peer) {
    const { chain } = await this.request(P2PNetwork.normalize(peer), '/chain');
    const result = this.blockchain.replaceChain(chain);
    if (result.replaced) this.log(`⛓  adopted chain from ${peer} (height ${result.height}, more cumulative work)`);
    return result;
  }

  async syncWithPeers() {
    for (const peer of this.list()) {
      try { await this.syncFrom(peer); } catch { /* peer offline: try again next round */ }
    }
  }

  // On startup: introduce ourselves to every peer, then catch up with them.
  async connect() {
    await Promise.allSettled(this.list().map((peer) => this.request(peer, '/peers', { url: this.selfUrl })));
    await this.syncWithPeers();
  }
}
