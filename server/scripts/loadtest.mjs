// Usage: node scripts/loadtest.mjs --api http://localhost:5000/api --ws ws://localhost:5000 --users 20
// Runs bots through the real flow against a RUNNING server (needs a real MongoDB and SFU).
// Raise AUTH_RATE_LIMIT_MAX on the server first, or registering many bots will hit the limit.
import { runLoad } from './lib/loadBot.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), [])
);
const apiUrl = args.api || 'http://localhost:5000/api';
const wsUrl = args.ws || 'ws://localhost:5000';
const users = Number(args.users || 20);
const publishers = Number(args.publishers || 3);
const holdMs = Number(args.hold || 4000);

console.log(`Load test: ${users} bots (${publishers} publishing audio) against ${apiUrl}`);
const report = await runLoad({ apiUrl, wsUrl, users, publishers, holdMs, log: console.log });
console.log(JSON.stringify(report, null, 2));
process.exit(report.failed > 0 ? 1 : 0);
