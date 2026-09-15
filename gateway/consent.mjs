#!/usr/bin/env node
// A gateway's consent to be delegated by a master (SPEC 4): its own worker key signs, for
// gateway/delegate.mjs where the master key lives. Runs where the gateway key is; the running
// gateway also answers GET /consent/<master> on its --api port.
//
//   node gateway/consent.mjs --key-file <file> --master <master pubkey> [--chain btc:testnet4-blake2b]
import { readFile } from 'node:fs/promises';
import { signConsent, pubkeyOf } from './lib/nostr.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] === undefined || all[i + 1].startsWith('--') ? true : all[i + 1]] : []).filter(Boolean));
const key = (args.key ?? (await readFile(args['key-file'], 'utf8'))).trim();
const master = String(args.master ?? '').toLowerCase(); if (!/^[0-9a-f]{64}$/.test(master)) throw new Error('--master <64-hex master pubkey> is required');
const chain = args.chain ?? 'btc:testnet4-blake2b';
// the gateway's own worker key is the one a --delegation names (serve.mjs prints it at startup, stats.json shows it as `worker`)
console.log(JSON.stringify({ chain, master, worker: pubkeyOf(key), consent: signConsent(key, master) }, null, 1));
