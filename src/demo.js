import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Starts a 3-node network on one machine. Each node is a separate process
// with its own chain file and peer list (data/node-<port>.json), just like
// three computers on the internet would be.
const PORTS = [3001, 3002, 3003];
const COLORS = ['\x1b[36m', '\x1b[35m', '\x1b[33m'];
const RESET = '\x1b[0m';
const serverPath = fileURLToPath(new URL('./server.js', import.meta.url));

const children = PORTS.map((port, i) => {
  const peers = PORTS.filter((p) => p !== port).map((p) => `http://localhost:${p}`).join(',');
  const child = spawn(process.execPath, [serverPath, '--port', String(port), '--peers', peers], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = (stream) => (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim()) stream.write(`${COLORS[i]}${line}${RESET}\n`);
    }
  };
  child.stdout.on('data', prefix(process.stdout));
  child.stderr.on('data', prefix(process.stderr));
  child.on('exit', (code) => {
    if (code) console.log(`${COLORS[i]}[${port}] exited with code ${code}${RESET}`);
  });
  return child;
});

console.log(`
  MiniChain demo network — 3 nodes, all peered together
  ─────────────────────────────────────────────────────
  Node A  →  http://localhost:3001
  Node B  →  http://localhost:3002
  Node C  →  http://localhost:3003

  Open any of them in your browser. Press Ctrl+C to stop all nodes.
`);

const stopAll = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
