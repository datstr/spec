#!/usr/bin/env node
// datstr gateway, step 1: build a block the datstr way and ask the node whether it is valid.
//
//   node gateway/build-block.mjs [--conf ~/knots-testnet4/bitcoin.conf] [--network btc:testnet4-blake2b]
//                                [--pay <address>[,<address>...]] [--worker <32-byte hex pubkey>]
//                                [--out block.hex] [--submit]
//
// Polls getblocktemplate with the segwit and blake2b rules, builds the coinbase per SPEC.md
// section 6.1 (split outputs, witness commitment, then the 34-byte datstr commitment output
// last), assembles the 164-byte v2 header, checks the block with the schema engine's
// knots-blake2b overlay, and sends it back to the node in getblocktemplate proposal mode.
// A proposal answers null when the block would be accepted with valid proof of work.
// --submit sends it with submitblock instead, which only succeeds if the header hash meets
// the target, so it is for a block something else has already mined.
//
// env: SCHEMA  path to a bitcoin-desktop/schema checkout (default ~/bitcoin-desktop/schema)

import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]] : []).filter(Boolean));
const HOME = homedir();
const SCHEMA = process.env.SCHEMA ?? `${HOME}/bitcoin-desktop/schema`;
const CONF = resolve((args.conf ?? '~/knots-testnet4/bitcoin.conf').replace(/^~/, HOME));
const NETWORK = args.network ?? 'btc:testnet4-blake2b';
const WORKER = args.worker ?? '00'.repeat(32);
const RULES = ['segwit', 'blake2b'];

// --- node: JSON-RPC over HTTP with cookie or user/pass auth, read from bitcoin.conf ---
const conf = Object.fromEntries((await readFile(CONF, 'utf8')).split('\n').map((l) => l.replace(/#.*/, '').trim()).filter((l) => l.includes('=')).map((l) => l.split('=').map((s) => s.trim())));
const subdir = { 'btc:testnet4-blake2b': 'testnet4', 'btc:testnet4': 'testnet4', 'btc:mainnet-blake2b': '', 'btc:mainnet': '' }[NETWORK];
const datadir = resolve((conf.datadir ?? '~/.bitcoin').replace(/^~/, HOME));
const auth = conf.rpcuser ? `${conf.rpcuser}:${conf.rpcpassword}` : (await readFile(`${datadir}/${subdir ? subdir + '/' : ''}.cookie`, 'utf8')).trim();
const url = `http://${conf.rpcbind ?? '127.0.0.1'}:${conf.rpcport ?? (subdir ? 48332 : 8332)}/`;
let id = 0;
async function rpc(method, ...params) {
  const r = await fetch(url, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(auth).toString('base64'), 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '1.0', id: ++id, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

// --- engine ---
const { createKernel } = await import(`${SCHEMA}/codec/kernel.js`);
const { knotsBlake2b } = await import(`${SCHEMA}/codec/overlays/knots-blake2b.js`);
const { addressToScript } = await import(`${SCHEMA}/codec/script.js`);
const { taggedHash, hexToBytes, bytesToHex } = await import(`${SCHEMA}/codec/hash.js`);
const load = async (p) => JSON.parse(await readFile(`${SCHEMA}/${p}`, 'utf8'));
const k = createKernel({
  core: await load('schema/core.jsonld'), proof: await load('schema/proof.jsonld'), script: await load('schema/script.jsonld'),
  chain: await load('schema/chain.jsonld'), validate: await load('schema/validate.jsonld'),
  network: NETWORK, overlays: [knotsBlake2b(await load('schema/overlays/knots-blake2b.jsonld'))],
});

// --- template ---
const t = await rpc('getblocktemplate', { rules: RULES });
const txs = t.transactions.map((x) => k.codec.decode('Transaction', x.data));
const txids = t.transactions.map((x) => x.txid);
console.log(`${NETWORK}  template height ${t.height}  prev ${t.previousblockhash}\n  rules ${t.rules.join(' ')}  bits ${t.bits}  curtime ${t.curtime}  txs ${txs.length}  coinbasevalue ${t.coinbasevalue}  weightlimit ${t.weightlimit}`);

// --- coinbase (SPEC 6.1) ---
const payAddrs = (args.pay ?? (await readFile(`${HOME}/knots-testnet4/miner-addresses.txt`, 'utf8')).trim().split('\n')[0]).split(',');
const scripts = payAddrs.map((a) => { const s = addressToScript(a.trim(), k.params); if (!s) throw new Error(`bad address for ${NETWORK}: ${a}`); return s; });
// the split: with no coordinator yet, the template value is shared equally (SPEC 9.2 with one master per address, equal weight); the first output takes the rounding dust
const each = Math.floor(t.coinbasevalue / scripts.length);
const split = scripts.map((spk, i) => ({ value: i === 0 ? t.coinbasevalue - each * (scripts.length - 1) : each, scriptPubKey: spk }));
const hexLE = (n, bytes) => { const b = new Uint8Array(bytes); for (let i = 0; i < bytes; i++) b[i] = (n >>> (8 * i)) & 0xff; return bytesToHex(b); };
const heightPush = (h) => { let n = h, out = []; while (n > 0) { out.push(n & 0xff); n >>>= 8; } if (out.length && out[out.length - 1] & 0x80) out.push(0); return hexLE(out.length, 1) + bytesToHex(new Uint8Array(out)); };
const scriptSig = heightPush(t.height) + '04' + '00000000'; // BIP34 height, then a 4-byte extranonce push (zero for now)
const parentsRoot = '00'.repeat(32); // level 1
const commitment = bytesToHex(taggedHash('datstr/share', hexToBytes(WORKER + parentsRoot)));
const outputs = [...split];
if (t.default_witness_commitment) outputs.push({ value: 0, scriptPubKey: t.default_witness_commitment });
outputs.push({ value: 0, scriptPubKey: '6a20' + commitment }); // OP_RETURN <32 bytes>, 34 bytes, last
const coinbase = {
  version: 2,
  inputs: [{ prevout: { txid: '00'.repeat(32), vout: 0xffffffff }, scriptSig, sequence: 0xffffffff }],
  outputs,
  witness: t.default_witness_commitment ? [['00'.repeat(32)]] : undefined,
  lockTime: 0,
};
const cbTxid = k.codec.txid(coinbase);

// --- header (164 bytes, v2) ---
const header = {
  version: t.version, prevBlockHash: t.previousblockhash, merkleRoot: k.codec.merkleRoot([cbTxid, ...txids]),
  timeOnWire: t.curtime, bits: parseInt(t.bits, 16), nonce: 0, nonce2: 0, nonce3: 0, extranonce: '00'.repeat(16),
  timeOffset: 0, txCount: txs.length + 1, flags: 0, xorKeyMaskClearBits: 0, xorKey: '00'.repeat(16), height: t.height, mmRhs: '00'.repeat(32),
};
const block = { header, transactions: [coinbase, ...txs] };
const hex = k.codec.encodeHex('Block', block);
const hash = k.codec.blockHash(header);
const weight = k.blocks.blockWeight(block);
console.log(`\ncoinbase ${cbTxid}\n  scriptSig ${scriptSig}\n  outputs: ${split.length} split (${payAddrs.map((a) => a.slice(0, 12) + '…').join(', ')})${t.default_witness_commitment ? ', witness commitment' : ''}, datstr commitment ${commitment.slice(0, 16)}…\nheader ${k.codec.encodeHex('BlockHeader', header).length / 2} bytes  hash ${hash}\nblock ${hex.length / 2} bytes, weight ${weight} of ${t.weightlimit}, txCount ${header.txCount}`);

// --- engine verdict ---
const st = k.blocks.validateBlockStructure(block);
const failed = st.results.filter((r) => r.ok === false);
console.log(`\nengine: ${st.results.filter((r) => r.ok === true).length}/${st.results.length} structural rules pass${failed.length ? '\n  FAIL ' + failed.map((r) => r.rule + (r.error ? ' — ' + r.error : '')).join('\n  FAIL ') : ''}`);
console.log(`  witness commitment ${k.blocks.witnessCommitment(coinbase) === (t.default_witness_commitment ?? '').slice(12) ? 'matches template' : 'n/a'}`);

if (args.out) { await writeFile(args.out, hex + '\n'); console.log(`\nwrote ${args.out}`); }

// --- node verdict ---
if (args.submit) {
  const r = await rpc('submitblock', hex);
  console.log(`\nsubmitblock: ${r === null ? 'accepted' : r}`);
} else {
  const r = await rpc('getblocktemplate', { mode: 'proposal', data: hex, rules: RULES });
  console.log(`\nproposal: ${r === null ? 'VALID — the node would accept this block with proof of work' : 'rejected: ' + r}`);
  process.exitCode = r === null ? 0 : 1;
}
