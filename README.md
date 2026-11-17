# ⛓ MiniChain

**A working blockchain built from scratch in plain JavaScript, with zero dependencies, to understand how Web3 really works under the hood.**

MiniChain is a complete, small cryptocurrency network you can run on your laptop:

- 🔑 **Wallets**: ECDSA key pairs, addresses derived from public keys, digital signatures
- 💸 **Transactions**: signed, hashed, with nonces for replay and double-spend protection
- 📦 **Blocks**: Merkle trees, chained hashes, proof of work
- ⛏ **Mining**: mempool, fee priority, block reward + fees, automatic difficulty adjustment
- 🌐 **Network**: multiple nodes that broadcast to each other, resolve forks, and agree on one chain (heaviest-chain consensus)
- 🖥 **Web app**: wallet (signs in your browser), block explorer, mining panel and live network view
- ✅ **51 automated tests** covering every rule above

Everything runs on **Node.js built-ins only** (`node:crypto`, `node:http`, `node:fs`, `node:test`, …). There are no npm packages, databases, MetaMask, testnets or API keys.

---

## Table of contents

1. [Quick start](#1-quick-start)
2. [Architecture](#2-architecture)
3. [How it works, concept by concept](#3-how-it-works-concept-by-concept)
4. [Step-by-step demo](#4-step-by-step-demo)
5. [API reference](#5-api-reference)
6. [Tests: what each one proves](#6-tests-what-each-one-proves)
7. [Design decisions and trade-offs](#7-design-decisions-and-trade-offs)
8. [Security model and known limitations](#8-security-model-and-known-limitations)
9. [Defending the project: likely questions and answers](#9-defending-the-project-likely-questions-and-answers)
10. [Glossary](#10-glossary)

---

## 1. Quick start

**Requirements:** Node.js 20 or newer. Nothing else: there is no `npm install` step, because there are no dependencies.

```bash
npm test            # run all 51 tests (about 1 second)
npm start           # one node on http://localhost:3001
npm run demo        # three nodes on ports 3001, 3002 and 3003, all peered together
npm run reset       # delete saved chains (data/) to start from genesis again
```

Open **http://localhost:3001** in your browser. In demo mode, 3002 and 3003 work too, and the node picker in the top right switches between them.

Run a node by hand with any port and peers:

```bash
node src/server.js --port 3001 --peers http://localhost:3002,http://localhost:3003
node src/server.js --port 3004 --peers http://localhost:3001 --verbose   # also log GET requests
```

Each node saves its chain and mempool to `data/node-<port>.json` and reloads (and **re-validates**) it on restart.

---

## 2. Architecture

```
                         ┌────────────────────────── Browser (public/) ──────────────────────────┐
                         │  Wallet tab             Explorer tab            Network tab           │
                         │  • keys via Web Crypto  • blocks as a chain     • every node's tip    │
                         │  • signs tx locally     • block / tx / address  • add peers           │
                         │  • mine button          • mempool                                     │
                         └───────────────┬───────────────────────────────────────────────────────┘
                                         │ REST + JSON (signed transactions only, never keys)
                                         ▼
 ┌──────────────────────────────── One MiniChain node (src/server.js) ─────────────────────────────┐
 │                                                                                                  │
 │   node:http router ──► Blockchain (src/blockchain.js) ──────────────► data/node-3001.json       │
 │        │                 ├─ chain: [genesis, block1, block2, …]          (persistence)          │
 │        │                 ├─ mempool: pending, already validated txs                             │
 │        │                 ├─ state cache: address → {balance, nonce}  (derived by replay)        │
 │        │                 ├─ validation: every hash, link, PoW, Merkle root, signature, nonce   │
 │        │                 └─ consensus: replaceChain() if valid AND more cumulative work         │
 │        │                                                                                         │
 │        └─► P2PNetwork (src/p2p.js): broadcast tx/blocks, relay new ones, sync chains            │
 │                                                                                                  │
 │   Building blocks:  Block (block.js) → Transaction (transaction.js) → wallet.js → crypto-utils  │
 └───────────────▲──────────────────────────────────▲──────────────────────────────────────────────┘
                 │ HTTP: POST /transactions/receive  │ POST /blocks/receive   GET /chain
                 ▼                                   ▼
        ┌─────────────────┐                 ┌─────────────────┐
        │  Node :3002     │◄───────────────►│  Node :3003     │      every node keeps a FULL copy
        │  (own chain)    │                 │  (own chain)    │      and validates everything itself
        └─────────────────┘                 └─────────────────┘
```

### Project layout

```
├── package.json              scripts: start, test, demo, reset (no dependencies)
├── src/
│   ├── config.js             consensus rules: reward, difficulty, target block time…
│   ├── crypto-utils.js       sha256(), stableStringify() (deterministic JSON), hex checks
│   ├── wallet.js             key generation, address derivation, sign(), verify()
│   ├── transaction.js        Transaction class, coinbase, validateTransaction()
│   ├── block.js              Block class, Merkle root, proof-of-work mining
│   ├── blockchain.js         chain, mempool, state, validation, difficulty, consensus, persistence
│   ├── p2p.js                broadcasting, relaying, syncing with peers
│   ├── server.js             REST API (node:http), static file server, CLI entry point
│   ├── demo.js               starts a 3-node network
│   ├── cli.js                command-line wallet (create, balance, send, mine)
│   └── errors.js             ChainError (rule violation → HTTP 4xx)
├── public/
│   ├── index.html            single-page UI (Wallet / Explorer / Network)
│   ├── styles.css            background, glow and scrollbar styles
│   ├── js/wallet-crypto.js   browser key generation + transaction signing (Web Crypto)
│   ├── js/app.js             tabs, header stats, node switching, polling
│   ├── js/wallet-ui.js       wallet, send form, mining panel
│   ├── js/explorer.js        block chain view, details, search, mempool
│   ├── js/network.js         node health and sync view
│   ├── js/ui.js, js/api.js   helpers (animations, formatting, fetch)
│   └── vendor/               tailwind.js (4.3.3 browser build), motion.js (Motion 14.9.0)
├── tests/                    node:test suites (51 tests)
└── data/                     saved chains, one file per node (git-ignored)
```

---

## 3. How it works, concept by concept

### 3.1 Hashing: the fingerprint of data

`sha256(data)` turns any input into 64 hex characters. Three properties make blockchains possible:

- **Deterministic:** the same input always gives the same hash.
- **Avalanche effect:** changing one character changes the whole hash.
- **One-way:** you can't work backwards from a hash to an input, and you can't find two inputs with the same hash.

**Deterministic serialization.** `JSON.stringify({a,b})` and `JSON.stringify({b,a})` produce different text, so different hashes. `stableStringify()` sorts object keys first. That way every node, and the browser, hashes the exact same bytes. *(The browser has an identical copy in `public/js/wallet-crypto.js`, and a test proves both sides produce the same hash.)*

### 3.2 Wallets: keys, signatures and addresses (`src/wallet.js`)

A wallet is just a key pair. There is no "sign-up" anywhere.

| Piece | What it is | Who sees it |
|---|---|---|
| Private key | random secret number (PEM / JWK) | only the owner |
| Public key | point on the elliptic curve, exported as SPKI hex | everyone |
| Address | first 40 hex chars of `sha256(publicKeyBytes)` | everyone (like an account number) |

- **Signing:** `sign(hash, privateKey)` uses ECDSA over SHA-256. Only the private key can produce this signature.
- **Verifying:** `verify(hash, signature, publicKey)` lets anyone check it, without ever seeing the private key.
- Server and CLI wallets use **secp256k1**, the curve Bitcoin and Ethereum use. Browser wallets use **P-256** (see [§7](#7-design-decisions-and-trade-offs)).

### 3.3 Transactions and the account model (`src/transaction.js`)

```js
{ from, to, amount, fee, nonce, timestamp, publicKey, signature, hash }
```

- **Account model** (like Ethereum): the ledger is `address → { balance, nonce }`. Bitcoin's UTXO model tracks individual unspent coins instead.
- **`hash`** is `sha256(stableStringify(every field except signature))`. The signature can't be part of its own input.
- **`signature`** is a signature over the hash. Change *anything* (amount, recipient, fee, nonce) and the hash changes, so the signature no longer matches.
- Amounts and fees are **whole numbers** (think "satoshis"). Floating-point money causes rounding bugs.

**Validation rules** (`checkIntegrity()` + `validateTransaction()`):

1. `amount > 0` and `fee ≥ 0`, both safe integers
2. The stored hash equals the recomputed hash, so nothing was edited after signing
3. `sha256(publicKey)` equals `from`, so the key really owns the address
4. The signature is valid for that public key
5. `balance ≥ amount + fee`
6. `nonce === sender's current nonce` (**replay protection**: each signed transaction can be used once)

**Coinbase transaction.** `from = "COINBASE"` is the first transaction of each block. It creates `BLOCK_REWARD + sum of fees` for the miner. It has no signature: the block rules decide whether it is valid. Its nonce equals the block index, so every coinbase has a unique hash.

### 3.4 The mempool: the waiting room (`Blockchain.addTransaction`)

Valid, unconfirmed transactions wait here. A transaction is rejected if it is:

- a **duplicate** (already in the mempool or already in a block), or
- **invalid** against the sender's *pending* state, meaning their balance and nonce after their other pending transactions are applied.

Checking against the pending state means you can queue nonce 0, 1, 2, but **you can't spend the same coins twice while they wait**.

### 3.5 Blocks and the Merkle root (`src/block.js`)

```js
{ index, timestamp, transactions, previousHash, merkleRoot, nonce, difficulty, hash }
```

The **block hash covers only the header**: `index, timestamp, previousHash, merkleRoot, nonce, difficulty`. The **Merkle root** stands in for all transactions:

```
            root = H(H12 + H33)
           /                 \
     H12 = H(h1+h2)     H33 = H(h3+h3)   ← an odd count duplicates the last hash
       /     \             /     \
     h1      h2          h3     (h3 copy)
```

Change any transaction, and its hash changes, then the root, then the block hash. **`previousHash`** links each block to its parent. Editing an old block breaks every link after it. That chain of hashes *is* the blockchain.

### 3.6 Proof of work: mining (`Block.mine`)

Mining tries `nonce = 0, 1, 2, …` until `sha256(header)` starts with `difficulty` zeros. There is no shortcut; it is pure trial and error. Each extra hex zero means **~16× more attempts**. Checking the result takes a single hash.

Why it matters: to rewrite history, an attacker must **redo the work** of the edited block *and every block after it*, faster than the honest network keeps extending the chain.

`minePendingTransactions(minerAddress)` does the following:

1. Picks up to `MAX_TX_PER_BLOCK` (10) transactions, **highest fee first**, while keeping each sender's nonces in order.
2. Adds the coinbase (reward 50 + fees).
3. Builds the block with the correct difficulty and mines it.
4. Runs the **same `addBlock()` validation as for a stranger's block**. The node doesn't even trust itself.

### 3.7 Difficulty adjustment (`Blockchain.expectedDifficulty`)

The target is **one block every 10 s**. Every **10 blocks** the node compares the actual time with the target:

- blocks came **2× faster** than target → difficulty **+1**
- blocks came **2× slower** than target → difficulty **−1**
- difficulty is clamped between **1 and 5** (the cap keeps mining responsive on a laptop)

Difficulty is a **consensus rule**: every node recomputes the expected difficulty for every block and rejects blocks that don't match. Try it: click "Mine block" quickly ten times and watch the difficulty go up.

### 3.8 Ledger state by replay (`Blockchain._derived`)

The chain stores **only transactions, never balances**. Balances and nonces come from **replaying every transaction since genesis**, so every honest node computes the same state. The result is **cached** and updated incrementally when a block is added. It is rebuilt from scratch only when the whole chain is replaced.

### 3.9 Full chain validation (`isValidChain`)

Nothing received from the network, or loaded from disk, is trusted. For every block:

- the genesis block matches the hardcoded one exactly
- the `index` follows the previous block, and `previousHash` links to it
- the stored `hash` equals the recomputed header hash
- `difficulty` equals the expected difficulty, and the proof of work is present
- the `merkleRoot` matches the transactions
- the timestamp is not before the previous block and not more than 2 minutes in the future
- the first transaction is the coinbase, there is no second coinbase, and there are at most 10 user transactions
- every transaction passes all its rules **against the state at that point in the chain**, with no duplicates
- the coinbase pays **exactly** reward + fees, to a valid address

### 3.10 Consensus: the heaviest chain wins (`replaceChain`)

Two miners can find a block at the same time, so nodes may temporarily disagree (a **fork**). The rule:

> Replace our chain with a received one **only if it is fully valid AND has more cumulative work.**

Cumulative work is `Σ 16^difficulty` over all blocks. Counting **work, not length**, stops an attacker from winning with many cheap, low-difficulty blocks. When the chain is equal or weaker, the node keeps what it has ("first seen wins").

After a switch:

- Transactions already in the new chain are **dropped** from the mempool.
- Transactions from our abandoned blocks (**orphaned**) are **put back** into the mempool, so they are not lost.
- Transactions that are now invalid (for example the losing half of a double spend) are discarded.

### 3.11 Peer-to-peer networking (`src/p2p.js`)

- **Broadcast:** a new transaction or mined block is POSTed to every peer.
- **Relay:** a node that accepts something **new** forwards it to its own peers, except the sender. Known items are not forwarded, so messages can't loop forever. This is a small version of *gossip*.
- **Sync:** if a received block doesn't link to our tip (we are behind or on a fork), the node fetches the sender's full `/chain` and runs consensus.
- **Catch-up:** at startup a node announces itself to its peers and syncs. It also re-syncs every 15 s, so a node that was offline converges again.

### 3.12 Persistence

After every change, the chain and mempool are written to `data/node-<port>.json`. The node writes a temporary file and then renames it, so a crash mid-write can't corrupt the file. On startup the file is **fully re-validated**. A tampered file is rejected and the node starts from genesis, then syncs from its peers.

---

## 4. Step-by-step demo

### In the browser (recommended)

1. `npm run reset` then `npm run demo`
2. Open **http://localhost:3001** → **Wallet** tab → **New wallet** twice ("Wallet 1", "Wallet 2").
3. Select **Wallet 1** → **Mine block**. You see the nonce found, the hashes tried and the time taken. The hash starts with `000`, and Wallet 1 now has **50 MINI** from the coinbase.
4. In **Send coins**, click **→ Wallet 2** (it fills in the address), amount `20`, fee `2` → **Sign & broadcast**.
   - Open "What exactly was signed?" to see the transaction JSON, its hash and the signature.
   - The **Mempool** counter shows `1`. The transaction was gossiped to all nodes.
5. Switch the node picker (top right) to **localhost:3002**, select Wallet 2, and click **Mine block**. Node 3002 mines your transaction.
6. Check the result:
   - **Network** tab: all 3 nodes show the same tip colour and height ("in sync").
   - **Explorer** tab: the new block contains the coinbase and your transaction. Click anything to drill down.
   - Wallet 1 = 50 − 20 − 2 = **28**. Wallet 2 = 20 + 50 reward + 2 fee = **72**.

> Wallets live in each page origin's localStorage, and every port is a separate origin. Use the node picker to talk to other nodes from the same tab, or **Export JSON / Import** to move a wallet.

### From the terminal (CLI)

```bash
npm run demo                                   # in terminal 1

node src/cli.js wallet wallets/alice.json      # in terminal 2
node src/cli.js wallet wallets/bob.json
node src/cli.js mine <aliceAddress>                                    # alice: 50
node src/cli.js send wallets/alice.json <bobAddress> 20 2              # signed locally, sent to :3001
node src/cli.js mine <bobAddress> --node http://localhost:3002         # mined by another node
node src/cli.js balance <bobAddress> --node http://localhost:3003      # 72 on every node
```

### With curl

```bash
curl -X POST localhost:3001/wallet/new                       # learning-only wallet
curl -X POST localhost:3001/mine -H "content-type: application/json" -d '{"minerAddress":"<address>"}'
curl localhost:3002/stats
curl localhost:3003/balance/<address>
```

### Try to break it

- **Double spend:** sign two transactions with the same nonce. The second is rejected with `wrong nonce`.
- **Replay:** POST an already mined transaction again. It is rejected with `already confirmed`.
- **Tamper:** edit an amount in `data/node-3001.json` and restart that node. It refuses the file and re-syncs from its peers.
- **Overspend:** send more than your balance. It is rejected with `insufficient balance`.

---

## 5. API reference

All responses are JSON. Errors look like `{ "error": "message" }` with a meaningful status code:

| Status | Meaning |
|---|---|
| 400 | A rule was violated or the input is invalid |
| 404 | Not found |
| 409 | Duplicate transaction |
| 413 | Request body too large (over 1 MB) |
| 500 | Bug |

### Read endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/chain` | `{ length, cumulativeWork, chain: [...] }` the full chain |
| GET | `/blocks?limit=10` | Latest block summaries, newest first |
| GET | `/blocks/:index` | Full block plus `confirmations` |
| GET | `/tx/:hash` | `{ status: "pending" \| "confirmed", transaction, blockIndex?, confirmations? }` |
| GET | `/mempool` | `{ size, transactions }` |
| GET | `/balance/:address` | `{ balance, nonce, pendingBalance, nextNonce }`. Use `nextNonce` to sign your next transaction |
| GET | `/address/:address` | Balance info plus full history (confirmed and pending) |
| GET | `/peers` | `{ self, peers }` |
| GET | `/stats` | Height, latest hash, next difficulty, average block time, target, mempool size, peer count, cumulative work |

### Write endpoints

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/wallet/new` | none | A fresh secp256k1 wallet with a **"for local learning only"** warning |
| POST | `/transactions` | Signed transaction JSON | 201 when accepted into the mempool, then broadcast |
| POST | `/mine` | `{ "minerAddress": "<40 hex>" }` | 201 with `{ block, nonce, attempts, timeMs }`, then broadcast |
| POST | `/peers` | `{ "url": "http://localhost:3004" }` | Adds the peer and syncs with it |

### Peer-to-peer endpoints (used between nodes)

| Method | Path | Body | Behaviour |
|---|---|---|---|
| POST | `/transactions/receive` | `{ transaction, sender }` | Adds the transaction and relays it if new. Returns `known` if already seen |
| POST | `/blocks/receive` | `{ block, sender }` | Appends the block if it links to our tip and relays it. If it doesn't link, fetches the sender's chain and runs consensus |

Any other GET serves files from `public/` (path traversal is blocked). CORS is enabled so the UI can query every node.

---

## 6. Tests: what each one proves

`npm test` runs **51 tests** with `node:test`. They need no network and take about 1 s. Two of them start real HTTP nodes on random ports.

| File | Proves |
|---|---|
| `wallet.test.js` | Keys and addresses are well formed; signatures verify; verification fails for changed data or the wrong key; garbage input never crashes |
| `transaction.test.js` | Valid transactions pass. These are rejected: a **tampered** amount, a tampered transaction with a recomputed hash (bad signature), a signature from another key, a key that doesn't own the address, bad amounts or fees, **insufficient balance**, and **wrong nonce (replay)**. A **browser-signed P-256** transaction verifies on the server |
| `block.test.js` | Merkle root for 1, 2, 3 (odd → duplicate) and 4 hashes; **proof of work meets the difficulty**; changing a block breaks its proof of work; JSON round trip |
| `blockchain.test.js` | Genesis; rewards; balances, fees and nonces; mempool duplicates; pending double spends; **replay after mining**; **double spend: same nonce, only one gets in** (even inside a forged block); fee priority with nonce ordering; greedy coinbase rejected; **tampered chain fails** (amount, coinbase, re-mined block, genesis); difficulty up, down, minimum and interval; persistence |
| `consensus.test.js` | Work is not the same as length; **the heavier valid chain wins**; equal or weaker chains are kept out; an invalid longer chain is rejected; the mempool is cleaned after a switch; orphaned transactions return; **a double spend across two nodes ends with only one payment** |
| `network.test.js` | Full HTTP flow across 2 live nodes (wallet → mine → send → mine, with propagation at each step); browser-signed transaction over HTTP; a lagging node catches up via consensus; JSON errors and status codes; static files without path traversal |

---

## 7. Design decisions and trade-offs

| Decision | Why |
|---|---|
| **Browser wallets use P-256, server wallets secp256k1** | Web Crypto in browsers supports ECDSA only on P-256, P-384 and P-521, not secp256k1. The alternatives were hand-written curve math (error-prone, and the "no dependencies" rule ruled out a library) or signing on the server (would expose private keys). Public keys are stored as **SPKI**, which records its curve, so `crypto.verify()` handles both with the same code. The verifier allows **only** these two curves. Real chains use one curve; this is a deliberate learning-friendly compromise. |
| **Signatures as raw `r‖s` (`ieee-p1363`)** | That's what Web Crypto outputs. Node reads it with `dsaEncoding: 'ieee-p1363'`, so there is one format everywhere. |
| **The signed message is the transaction hash** | One hash commits to every field. The hash excludes the signature, so signature malleability can't change a transaction's ID. |
| **Address = 20 bytes of sha256(public key)** | Short, fixed size, and doesn't reveal the key until the first spend (same idea as Bitcoin and Ethereum). |
| **Integer amounts** | Floating point can't represent money exactly. |
| **Block hash = header only** | Like Bitcoin. The Merkle root commits to the transactions, which allows Merkle proofs and light clients. |
| **Work = Σ 16^difficulty** | Each hex zero is 4 bits, so ~16× more hashing per level. |
| **The miner validates its own block** | The same code path for local and remote blocks means one place for the rules, and no "trusted" shortcut. |
| **Derived state + cache** | The chain is the single source of truth. The cache keeps reads O(1). |
| **Mempool checks against pending state** | Lets users queue several transactions and blocks spending the same coins twice while waiting. |
| **Relay only new items** | Simple loop prevention without message IDs or TTLs. |
| **Tailwind + Motion vendored in `public/vendor/`** | Requested for a polished UI. They are served locally, so there is still **no CDN, no build step and no npm dependency**. Motion is the library formerly called Framer Motion; its plain-JS `animate()` works without React. |

---

## 8. Security model and known limitations

MiniChain teaches the **ideas**. It is not production software. Compared with real blockchains:

| Area | MiniChain | Real blockchains |
|---|---|---|
| Networking | HTTP POST to a fixed peer list, full-chain download on forks | TCP/libp2p gossip, peer discovery, headers-first sync, DoS protection, peer scoring |
| Ledger model | Account model, no UTXO | Bitcoin: UTXO; Ethereum: account model with gas |
| Programmability | No smart contracts or virtual machine | Bitcoin Script, EVM, … |
| Proof of work | Leading **hex** zeros, difficulty capped at 5, ±1 steps | 256-bit target, smooth retarget (Bitcoin: 2016 blocks, ×4 clamp) |
| Consensus security | A single laptop can out-mine the network (51% attack is trivial) | Huge hash power or stake makes rewriting history very expensive |
| Mining | Synchronous: blocks the node's event loop while mining | Dedicated hardware, separate from the node |
| Wallet security | Keys **unencrypted** in localStorage; `/wallet/new` sends a private key over HTTP (marked learning-only) | Hardware wallets, encrypted keystores, seed phrases (BIP-39), HD wallets |
| Signatures | No low-S normalization; two curves accepted | One curve, canonical signatures enforced |
| Transactions | Nonce gaps are rejected (no "future" queue); no expiry; no replacement-by-fee | Fee markets, RBF, mempool eviction policies |
| Timestamps | Not before the previous block, at most 2 min in the future | Median-time-past rules |
| Supply | Fixed 50-coin reward forever | Halvings, burn mechanisms, … |
| Storage | One JSON file rewritten on every change | LevelDB/RocksDB, pruning, snapshots |
| Peers | Trusts the `sender` URL in a message for syncing; no authentication | Encrypted, authenticated transports |

---

## 9. Defending the project: likely questions and answers

**Q: What is a blockchain, in one sentence?**
A: A list of blocks where each block contains the hash of the previous one, so history can't be changed without redoing all the work after it, copied and independently verified by every node.

**Q: Why can't someone just edit a balance?**
A: Balances aren't stored anywhere. They are computed by replaying signed transactions. To fake a balance you would need to forge a signature (impossible without the private key) or rewrite blocks. Rewriting a block changes its hash, which breaks the next block's `previousHash` and requires redoing the proof of work for every later block. Every node checks all of this (`isValidChain`).

**Q: How does the network know a transaction really came from the owner?**
A: The transaction carries the public key and an ECDSA signature over its hash. The node checks that `sha256(publicKey)` equals the `from` address and that the signature verifies with that key. Only the holder of the private key could have made that signature.

**Q: What stops me from sending the same signed transaction twice (replay)?**
A: The **nonce**. Each account has a counter, and a transaction is valid only when its nonce equals the current counter. After it is mined the counter goes up, so the same transaction is now invalid. It is also rejected as a duplicate hash. (Test: *replay: re-sending an already mined transaction is rejected*.)

**Q: And a double spend, two different transactions spending the same coins?**
A: Both would need the same nonce. The mempool accepts only one. A block containing both is invalid, because the second has a wrong nonce. If two nodes each accept a different one and both mine, consensus picks one chain and the other payment becomes invalid and is dropped. (Tests in `blockchain.test.js` and `consensus.test.js`.)

**Q: What is the Merkle root for, if the block hash already covers everything?**
A: The block hash covers only the header. The Merkle root is how the header commits to all transactions with one hash. It also allows **Merkle proofs**: proving that one transaction is in a block with `log2(n)` hashes instead of the full block, which light wallets rely on.

**Q: Why duplicate the last hash when the count is odd?**
A: Each tree level pairs hashes, so an odd one out needs a partner. Bitcoin uses the same convention.

**Q: What does "proof of work" actually prove?**
A: That someone very probably spent a known amount of computation, about 16^difficulty hashes on average, because there is no faster way to find such a hash than guessing. Anyone can verify it with one hash. It makes block creation costly, and therefore rewriting history costly.

**Q: Why adjust difficulty?**
A: To keep block times steady as mining power changes. More miners would otherwise mean faster blocks, more forks and faster coin creation. MiniChain retargets every 10 blocks towards 10 s per block.

**Q: Why "most cumulative work" and not "longest chain"?**
A: Length can be faked with many easy blocks. Work measures real cost. (Test: *cumulative work counts difficulty, not just length*.)

**Q: What happens to transactions in a block that loses a fork?**
A: They are "orphaned". MiniChain puts them back into the mempool unless the winning chain already contains them or they became invalid, so honest payments aren't lost. (Test: *transactions from orphaned blocks go back into the mempool*.)

**Q: How do miners get paid?**
A: The first transaction in each block is a coinbase that pays `BLOCK_REWARD + all fees`. Validators reject a coinbase that pays a single coin more. (Test: *the coinbase must pay exactly reward + fees*.)

**Q: Why do higher fees get mined first?**
A: Block space is limited (10 transactions), and miners maximize income. MiniChain sorts by fee but still respects each sender's nonce order.

**Q: Why does the browser use P-256 instead of secp256k1?**
A: Browsers' built-in Web Crypto doesn't support secp256k1, and I didn't want to hand-roll elliptic-curve math or sign on the server (that would leak private keys). The public key format (SPKI) records its curve, so the server verifies both. The verifier accepts only these two curves.

**Q: Is the private key ever sent to the server?**
A: Not from the browser wallet or the CLI: they sign locally and send only the signed transaction. The `/wallet/new` endpoint does return a server-generated key, and it is explicitly labelled "for local learning only".

**Q: How do the nodes talk to each other?**
A: Over HTTP. New transactions and blocks are POSTed to peers. A node forwards things that are **new** to it, which is a simple form of gossip; already-known items stop there. A block that doesn't fit triggers a full chain download and consensus. Nodes also re-sync every 15 s.

**Q: What if a node goes offline and comes back?**
A: It loads and re-validates its saved chain, announces itself to its peers, downloads their chains, and adopts the heaviest valid one. (Test: *a node that missed blocks catches up through consensus*.)

**Q: Is MiniChain secure?**
A: Its *rules* are enforced: signatures, nonces, balances, PoW and consensus. As a *network*, no: with three laptop nodes anyone can out-mine everyone else, and it skips many production protections. [§8](#8-security-model-and-known-limitations) lists them honestly.

**Q: Why no dependencies?**
A: To show that nothing is hidden. Hashing, signatures, networking, storage and testing all come from Node's standard library, and every blockchain rule is code in this repository. (Tailwind and Motion are only for the UI, and they are vendored files, not npm dependencies.)

**Q: How do you know it works?**
A: 51 automated tests cover every rule, including attacks (tampering, replay, double spend, forged coinbase, invalid longer chain), plus a live two-node HTTP test.

---

## 10. Glossary

| Term | Meaning |
|---|---|
| **Address** | A short identifier derived from a public key (here: 40 hex chars of sha256) |
| **Block** | A batch of transactions plus a header, sealed by proof of work |
| **Coinbase** | The first transaction in a block; creates the reward and fees for the miner |
| **Consensus** | The rule nodes use to agree on one chain (here: valid + most cumulative work) |
| **Difficulty** | Number of leading hex zeros a block hash needs |
| **Double spend** | Trying to spend the same coins twice |
| **Fork** | Two competing versions of the chain, usually short-lived |
| **Genesis block** | Block #0, hardcoded and identical on every node |
| **Mempool** | Valid transactions waiting to be mined |
| **Merkle root** | One hash summarizing all transactions in a block |
| **Nonce (transaction)** | The sender's transaction counter; prevents replay |
| **Nonce (block)** | The number miners change to search for a valid hash |
| **Orphaned block** | A block on the losing side of a fork |
| **Proof of work** | A hash below a target, proving computation was spent |
| **Replay attack** | Re-submitting an old, valid signed transaction |
| **Signature (ECDSA)** | Proof, made with a private key, that the owner approved a message |

---

*Built for learning. Read the source: every file starts with a comment explaining the blockchain idea it implements.*
