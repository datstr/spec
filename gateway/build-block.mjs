#!/usr/bin/env node
// datstr gateway, step 1: build a block the datstr way and ask the node whether it is valid.
//
//   node gateway/build-block.mjs [--conf ~/knots-testnet4/bitcoin.conf] [--network btc:testnet4-blake2b]
//                                [--pay <address>[,<address>...]] [--worker <32-byte hex pubkey>]
//                                [--out block.hex] [--submit]
//
// getblocktemplate with the segwit and blake2b rules, the coinbase per SPEC.md 6.1, the 164-byte
// header, a check with the schema engine, then getblocktemplate proposal mode: null means the
// node would accept the block with valid proof of work. --submit uses submitblock instead.
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { makeRpc } from './lib/rpc.mjs';
import { loadEngine } from './lib/engine.mjs';
import { buildBlock } from './lib/block.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] === undefined || all[i + 1].startsWith('--') ? true : all[i + 1]] : []).filter(Boolean));
const NETWORK = args.network ?? 'btc:testnet4-blake2b';
const RULES = ['segwit', 'blake2b'];
const rpc = await makeRpc(args.conf ?? '~/knots-testnet4/bitcoin.conf', NETWORK);
const { k, hash, script } = await loadEngine({ network: NETWORK, activationHeight: Number(args.activation ?? 0) });

const t = await rpc('getblocktemplate', { rules: RULES });
console.log(`${NETWORK}  template height ${t.height}  prev ${t.previousblockhash}\n  rules ${t.rules.join(' ')}  bits ${t.bits}  curtime ${t.curtime}  txs ${t.transactions.length}  coinbasevalue ${t.coinbasevalue}  weightlimit ${t.weightlimit}`);
const payAddrs = (args.pay ?? (await readFile(`${homedir()}/knots-testnet4/miner-addresses.txt`, 'utf8')).trim().split('\n')[0]).split(',').map((s) => s.trim());
const payScripts = payAddrs.map((a) => { const s = script.addressToScript(a, k.params); if (!s) throw new Error(`bad address for ${NETWORK}: ${a}`); return s; });
const b = buildBlock({ k, hash, template: t, payScripts, worker: args.worker });
const block = { header: b.header, transactions: b.transactions };
const hex = k.codec.encodeHex('Block', block);
console.log(`\ncoinbase ${b.cbTxid}\n  outputs: ${b.nSplit} split (${payAddrs.map((a) => a.slice(0, 12) + '…').join(', ')})${t.default_witness_commitment ? ', witness commitment' : ''}, datstr commitment ${b.commitment.slice(0, 16)}…\nheader 164 bytes  hash ${k.codec.blockHash(b.header)}\nblock ${hex.length / 2} bytes, weight ${k.blocks.blockWeight(block)} of ${t.weightlimit}, txCount ${b.header.txCount}`);
const st = k.blocks.validateBlockStructure(block);
const failed = st.results.filter((r) => r.ok === false);
console.log(`\nengine: ${st.results.filter((r) => r.ok === true).length}/${st.results.length} structural rules pass${failed.length ? '\n  FAIL ' + failed.map((r) => r.rule + (r.error ? ' — ' + r.error : '')).join('\n  FAIL ') : ''}`);
if (args.out) { await writeFile(args.out, hex + '\n'); console.log(`wrote ${args.out}`); }
if (args.submit) { const r = await rpc('submitblock', hex); console.log(`\nsubmitblock: ${r === null ? 'accepted' : r}`); }
else { const r = await rpc('getblocktemplate', { mode: 'proposal', data: hex, rules: RULES }); console.log(`\nproposal: ${r === null ? 'VALID — the node would accept this block with proof of work' : 'rejected: ' + r}`); process.exitCode = r === null ? 0 : 1; }
