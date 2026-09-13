#!/usr/bin/env node
// Run this where the master key lives, never on a gateway (SPEC.md section 4).
//
//   node gateway/delegate.mjs --new-master --out <dir>
//       writes <dir>/master.key (keep it cold) and prints the master pubkey
//   node gateway/delegate.mjs --master-key-file <dir>/master.key --worker <worker pubkey>
//       --chain btc:testnet4-blake2b --pay <address> [--expires <height>] --out <dir>
//       writes <dir>/descriptor.json (kind 33401, the master's payout per chain)
//       and <dir>/delegation-<worker>.json (kind 33402, the worker may mine for the master)
//   The gateway takes both: serve.mjs --descriptor <file> --delegation <file>
//   A gateway's worker pubkey is printed at startup and in its stats.json as `worker`.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { signEvent, randomKey, pubkeyOf } from './lib/nostr.mjs';
import { loadEngine } from './lib/engine.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] === undefined || all[i + 1].startsWith('--') ? true : all[i + 1]] : []).filter(Boolean));
const out = args.out ?? '.';
await mkdir(out, { recursive: true });
if (args['new-master']) {
  const f = `${out}/master.key`;
  if (existsSync(f)) throw new Error(`${f} exists`);
  const key = randomKey(); await writeFile(f, key + '\n', { mode: 0o600 });
  console.log(`master key written to ${f}\nmaster pubkey ${pubkeyOf(key)}`);
  process.exit(0);
}
const master = args['master-key'] ?? (await readFile(args['master-key-file'], 'utf8')).trim();
const worker = args.worker, chain = args.chain ?? 'btc:testnet4-blake2b';
if (!/^[0-9a-f]{64}$/i.test(worker ?? '')) throw new Error('--worker <64-hex worker pubkey> is required');
const { k, script } = await loadEngine({ network: chain, activationHeight: Number(args.activation ?? 0) });
const spk = script.addressToScript(args.pay, k.params); if (!spk) throw new Error(`bad address for ${chain}: ${args.pay}`);
const M = pubkeyOf(master);
// the descriptor carries every chain the master is paid on; merge into an existing one
let payout = { [chain]: spk };
if (existsSync(`${out}/descriptor.json`)) { try { const old = JSON.parse(JSON.parse(await readFile(`${out}/descriptor.json`, 'utf8')).content); payout = { ...old.payout, ...payout }; } catch {} }
const descriptor = signEvent(master, { kind: 33401, tags: [['d', M], ...Object.keys(payout).map((c) => ['chain', c])], content: { chain, payout } });
const expires = args.expires ? Number(args.expires) : null;
const delegation = signEvent(master, { kind: 33402, tags: [['d', worker], ['chain', chain], ['p', M]], content: { master: M, worker, chains: { [chain]: { expires } } } });
await writeFile(`${out}/descriptor.json`, JSON.stringify(descriptor, null, 1));
await writeFile(`${out}/delegation-${worker.slice(0, 16)}.json`, JSON.stringify(delegation, null, 1));
console.log(`master ${M}\nworker ${worker} may mine ${chain} for it${expires ? ` until height ${expires}` : ''}, paid to ${args.pay}\nwrote ${out}/descriptor.json and ${out}/delegation-${worker.slice(0, 16)}.json`);
