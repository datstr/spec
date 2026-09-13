#!/usr/bin/env node
// datstr gateway: getblocktemplate from your own node → datstr coinbase → stratum jobs → shares →
// blocks submitted to your own node. No coordinator yet: the split is the payout addresses given.
//
//   node gateway/serve.mjs --conf <bitcoin.conf> --network btc:testnet4-blake2b --pay <addr>[,<addr>]
//                          [--port 3333] [--diff 1] [--poll 2] [--refresh 30] [--worker <hex>] [--activation N]
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { makeRpc } from './lib/rpc.mjs';
import { loadEngine } from './lib/engine.mjs';
import { buildBlock } from './lib/block.mjs';
import { targetForDifficulty, meets } from './lib/target.mjs';
import { StratumServer } from './stratum.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] === undefined || all[i + 1].startsWith('--') ? true : all[i + 1]] : []).filter(Boolean));
const NETWORK = args.network ?? 'btc:testnet4-blake2b';
const RULES = ['segwit', 'blake2b'];
const DIFF = Number(args.diff ?? 1), POLL = Number(args.poll ?? 2) * 1000, REFRESH = Number(args.refresh ?? 30) * 1000;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const rpc = await makeRpc(args.conf ?? '~/knots-testnet4/bitcoin.conf', NETWORK);
const { k, pow, hash, script } = await loadEngine({ network: NETWORK, activationHeight: Number(args.activation ?? 0), headline: args.headline ?? '' });
const { hexToBytes, bytesToHex, taggedHash } = hash;
const payAddrs = (args.pay ?? (await readFile(`${homedir()}/knots-testnet4/miner-addresses.txt`, 'utf8')).trim().split('\n')[0]).split(',').map((s) => s.trim());
const payScripts = payAddrs.map((a) => { const s = script.addressToScript(a, k.params); if (!s) throw new Error(`bad address for ${NETWORK}: ${a}`); return s; });
const shareTarget = targetForDifficulty(DIFF);

let jobSeq = 0, current = null, seen = new Set();
const stats = { shares: 0, rejected: 0, blocks: 0 };

function makeJob(t) {
  const b = buildBlock({ k, hash, template: t, payScripts, worker: args.worker });
  const d = pow.hashHeaderV2Detailed(b.header);
  const prevHidden = taggedHash('Bitcoin prevblock header, hashed', hexToBytes(t.previousblockhash)); prevHidden.fill(0, 0, 6);
  return {
    id: (++jobSeq).toString(16).padStart(8, '0'), height: t.height, prev: t.previousblockhash, template: t, block: b,
    prevHidden: bytesToHex(prevHidden), coinb1: '000000' + d.h2, bits: t.bits, ntimeField: '00'.repeat(8),
    networkTarget: hexToBytes(t.target), made: Date.now(),
  };
}

const stratum = new StratumServer({ difficulty: DIFF, log, onShare: async ({ job, fields, user }) => {
  const header = { ...job.block.header, ...fields };
  const d = pow.hashHeaderV2Detailed(header);
  const powBytes = hexToBytes(d.blake2b2), hashBytes = hexToBytes(d.blockHash);
  if (!meets(powBytes, shareTarget)) { stats.rejected++; return { ok: false, code: 23, reason: 'low difficulty' }; }
  if (seen.has(d.blockHash)) { stats.rejected++; return { ok: false, code: 22, reason: 'duplicate' }; }
  seen.add(d.blockHash);
  stats.shares++;
  const isBlock = meets(hashBytes, job.networkTarget);
  const stale = job.prev !== current?.prev;
  log(`share ${d.blockHash.slice(0, 20)}… job ${job.id} h${job.height} ${user}${isBlock ? ' BLOCK' : ''}${stale ? ' (stale job)' : ''}`);
  if (isBlock) {
    const hex = k.codec.encodeHex('Block', { header, transactions: job.block.transactions });
    const r = await rpc('submitblock', hex);
    if (r === null) { stats.blocks++; log(`BLOCK ${d.blockHash} height ${job.height} accepted by the node, coinbase ${job.block.cbTxid}, commitment ${job.block.commitment.slice(0, 16)}…`); await refresh(true); }
    else log(`BLOCK ${d.blockHash} refused by the node: ${r}`);
  }
  return { ok: true };
} });

async function refresh(force) {
  let t; try { t = await rpc('getblocktemplate', { rules: RULES }); } catch (e) { log(`getblocktemplate: ${e.message}`); return; }
  const tip = t.previousblockhash !== current?.prev;
  const txs = current && t.transactions.length !== current.template.transactions.length;
  const old = current && Date.now() - current.made > REFRESH;
  if (!force && current && !tip && !txs && !old) return;
  if (tip) seen = new Set();
  current = makeJob(t);
  stratum.publish(current, tip); stratum.retire(8);
  log(`job ${current.id} h${t.height} prev ${t.previousblockhash.slice(0, 16)}… bits ${t.bits} txs ${t.transactions.length} value ${t.coinbasevalue}${tip ? ' (new tip)' : txs ? ' (mempool)' : ' (refresh)'}`);
}

const port = await stratum.listen(Number(args.port ?? 3333));
log(`datstr gateway on ${NETWORK}: stratum :${port} diff ${DIFF} paying ${payAddrs.join(', ')} via ${rpc.url}`);
await refresh(true);
setInterval(() => refresh(false), POLL);
setInterval(() => log(`stats: shares ${stats.shares} rejected ${stats.rejected} blocks ${stats.blocks} clients ${stratum.clients.size}`), 60000);
