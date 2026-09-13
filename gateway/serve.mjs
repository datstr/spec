#!/usr/bin/env node
// datstr gateway: getblocktemplate from your own node → datstr coinbase → stratum jobs → shares →
// blocks submitted to your own node. No coordinator yet: the split is the payout addresses given.
//
//   node gateway/serve.mjs --conf <bitcoin.conf> --network btc:testnet4-blake2b --pay <addr>[,<addr>]
//                          [--port 3333] [--diff 1] [--poll 2] [--refresh 30] [--worker <hex>] [--activation N]
//                          [--stop-height N] [--min-bits 1d00ffff] [--api 3334]
//
// --api N          serve a status page at http://127.0.0.1:N/ and its data at /stats.json
//
// --stop-height N  never mine a height above N: jobs stop and clients are told nothing new.
//                  For testnet4 before the 151,200 retarget: --stop-height 151198.
// --min-bits X     only serve work while the template's bits equal X, i.e. wait for the
//                  min-difficulty window (testnet4: 1d00ffff, twenty minutes after the tip)
//                  instead of hashing at the real difficulty in between.
import { homedir } from 'node:os';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { makeRpc } from './lib/rpc.mjs';
import { loadEngine } from './lib/engine.mjs';
import { buildBlock } from './lib/block.mjs';
import { targetForDifficulty, meets } from './lib/target.mjs';
import { StratumServer } from './stratum.mjs';
import { scriptToAddress } from './lib/address.mjs';
import { execSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] === undefined || all[i + 1].startsWith('--') ? true : all[i + 1]] : []).filter(Boolean));
const NETWORK = args.network ?? 'btc:testnet4-blake2b';
const RULES = ['segwit', 'blake2b'];
const DIFF = Number(args.diff ?? 1), POLL = Number(args.poll ?? 2) * 1000, REFRESH = Number(args.refresh ?? 30) * 1000;
const STOP = args['stop-height'] ? Number(args['stop-height']) : Infinity;
const MIN_BITS = args['min-bits'] ? String(args['min-bits']).toLowerCase() : null;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const rpc = await makeRpc(args.conf ?? '~/knots-testnet4/bitcoin.conf', NETWORK);
const { k, pow, hash, script } = await loadEngine({ network: NETWORK, activationHeight: Number(args.activation ?? 0), headline: args.headline ?? '' });
const { hexToBytes, bytesToHex, taggedHash } = hash;
const payAddrs = (args.pay ?? (await readFile(`${homedir()}/knots-testnet4/miner-addresses.txt`, 'utf8')).trim().split('\n')[0]).split(',').map((s) => s.trim());
const payScripts = payAddrs.map((a) => { const s = script.addressToScript(a, k.params); if (!s) throw new Error(`bad address for ${NETWORK}: ${a}`); return s; });
const shareTarget = targetForDifficulty(DIFF);

let jobSeq = 0, current = null, seen = new Set();
const stats = { shares: 0, rejected: 0, blocks: 0 };
const started = Date.now();
let VERSION = 'datstr-gateway/0.0.1';
try { VERSION += '/' + execSync('git rev-parse --short HEAD', { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
const history = []; // [unix seconds, hashes per second], one sample a minute, a day kept
let nodeWarnings = [];
const blocks = []; // found blocks, newest first
const recent = []; // [time, difficulty] of accepted shares, for the hashrate estimate
const clientStats = new WeakMap();
const cstat = (c) => { let x = clientStats.get(c); if (!x) { x = { shares: 0, rejected: 0, lastShare: null, since: Date.now(), recent: [] }; clientStats.set(c, x); } return x; };
const rateOf = (samples, now) => { const cut = now - 600000; while (samples.length && samples[0][0] < cut) samples.shift(); const from = Math.max(cut, started); return samples.reduce((a, [, d]) => a + d * 4294967296, 0) / Math.max(1, (now - from) / 1000); };

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

const stratum = new StratumServer({ difficulty: DIFF, log, onShare: async ({ job, fields, user, client }) => {
  const header = { ...job.block.header, ...fields };
  const d = pow.hashHeaderV2Detailed(header);
  const powBytes = hexToBytes(d.blake2b2), hashBytes = hexToBytes(d.blockHash);
  const cs = cstat(client);
  if (!meets(powBytes, shareTarget)) { stats.rejected++; cs.rejected++; return { ok: false, code: 23, reason: 'low difficulty' }; }
  if (seen.has(d.blockHash)) { stats.rejected++; cs.rejected++; return { ok: false, code: 22, reason: 'duplicate' }; }
  seen.add(d.blockHash);
  stats.shares++; cs.shares++; cs.lastShare = Date.now(); recent.push([Date.now(), DIFF]); cs.recent.push([Date.now(), DIFF]);
  const isBlock = meets(hashBytes, job.networkTarget);
  const stale = job.prev !== current?.prev;
  log(`share ${d.blockHash.slice(0, 20)}… job ${job.id} h${job.height} ${user}${isBlock ? ' BLOCK' : ''}${stale ? ' (stale job)' : ''}`);
  if (isBlock && job.height > STOP) { log(`BLOCK ${d.blockHash} at height ${job.height} NOT submitted: above --stop-height ${STOP}`); return { ok: true }; }
  if (isBlock) {
    const hex = k.codec.encodeHex('Block', { header, transactions: job.block.transactions });
    const r = await rpc('submitblock', hex);
    blocks.unshift({ height: job.height, hash: d.blockHash, time: Math.floor(Date.now() / 1000), user, coinbase: job.block.cbTxid, commitment: job.block.commitment, value: job.template.coinbasevalue, txs: job.block.transactions.length, accepted: r === null, result: r });
    if (blocks.length > 200) blocks.pop();
    if (r === null) { stats.blocks++; log(`BLOCK ${d.blockHash} height ${job.height} accepted by the node, coinbase ${job.block.cbTxid}, commitment ${job.block.commitment.slice(0, 16)}…`); await refresh(true); }
    else log(`BLOCK ${d.blockHash} refused by the node: ${r}`);
  }
  return { ok: true };
} });

let holding = null; // why no work is being served, logged once per reason
function hold(reason) { if (holding !== reason) { holding = reason; log(`holding: ${reason}`); } }

async function refresh(force) {
  let t; try { t = await rpc('getblocktemplate', { rules: RULES }); } catch (e) { log(`getblocktemplate: ${e.message}`); return; }
  if (t.height > STOP) return hold(`height ${t.height} is above --stop-height ${STOP}`);
  if (MIN_BITS && t.bits.toLowerCase() !== MIN_BITS) return hold(`bits ${t.bits}, waiting for ${MIN_BITS} (min-difficulty window)`);
  holding = null;
  const tip = t.previousblockhash !== current?.prev;
  const bits = current && t.bits !== current.bits;
  const txs = current && t.transactions.length !== current.template.transactions.length;
  const old = current && Date.now() - current.made > REFRESH;
  if (!force && current && !tip && !bits && !txs && !old) return;
  if (tip) seen = new Set();
  current = makeJob(t);
  stratum.publish(current, tip); stratum.retire(8);
  log(`job ${current.id} h${t.height} prev ${t.previousblockhash.slice(0, 16)}… bits ${t.bits} txs ${t.transactions.length} value ${t.coinbasevalue}${tip ? ' (new tip)' : bits ? ' (bits changed)' : txs ? ' (mempool)' : ' (refresh)'}`);
}

function snapshot() {
  const now = Date.now();
  const hashrate = rateOf(recent, now);
  const j = current;
  const weight = j ? k.blocks.blockWeight({ header: j.block.header, transactions: j.block.transactions }) : 0;
  const status = holding ? 'Holding' : j ? 'Serving work' : 'No job';
  return {
    version: VERSION, network: NETWORK, node: rpc.url, uptime_seconds: Math.floor((now - started) / 1000), status, holding,
    difficulty: DIFF, stop_height: STOP < Infinity ? STOP : null, min_bits: MIN_BITS, pay: payAddrs,
    work_update_seconds: REFRESH / 1000, poll_seconds: POLL / 1000, node_warnings: nodeWarnings,
    stratum: { listening: true, connections: stratum.clients.size, subscriptions: [...stratum.clients].filter((c) => c.subscribed).length, hashrate },
    shares_accepted: { count: stats.shares, diff: stats.shares * DIFF }, shares_rejected: { count: stats.rejected, diff: stats.rejected * DIFF }, blocks_found: stats.blocks,
    hashrate: { history, interval_seconds: 60 },
    job: j && {
      job_id: j.id, height: j.height, previous_block: j.prev, bits: j.bits, txn_count: j.template.transactions.length, value_sats: j.template.coinbasevalue,
      txn_total_weight: weight, weightlimit: j.template.weightlimit, created_seconds_ago: Math.floor((now - j.made) / 1000), difficulty: DIFF,
      coinbase_outputs: j.block.nSplit, payout: 'addresses', commitment: j.block.commitment,
    },
    coinbaser: j ? j.block.coinbase.outputs.slice(0, j.block.nSplit).map((o, i) => ({ value_sats: o.value, address: scriptToAddress(o.scriptPubKey, k.params.bech32Hrp) ?? o.scriptPubKey, remainder: i === 0 && j.block.nSplit > 1 })) : [],
    clients: [...stratum.clients].map((c) => { const cs = cstat(c); return {
      remote: c.remote, username: c.user, useragent: c.agent ?? '', subscribed: c.subscribed, difficulty: DIFF, hashrate: rateOf(cs.recent, now),
      accepted_count: cs.shares, accepted_diff: cs.shares * DIFF, rejected_count: cs.rejected, rejected_diff: cs.rejected * DIFF,
      last_accepted_seconds: cs.lastShare ? Math.floor((now - cs.lastShare) / 1000) : null, connected_seconds: Math.floor((now - cs.since) / 1000),
    }; }),
    blocks,
  };
}
setInterval(() => { history.push([Math.floor(Date.now() / 1000), rateOf(recent, Date.now())]); if (history.length > 1440) history.shift(); }, 60000);
setInterval(async () => { try { const m = await rpc('getmininginfo'); nodeWarnings = Array.isArray(m.warnings) ? m.warnings : m.warnings ? [m.warnings] : []; } catch (e) { nodeWarnings = [`node unreachable: ${e.message}`]; } }, 60000);
if (args.api !== 'false') {
  const page = await readFile(new URL('./status.html', import.meta.url), 'utf8');
  const apiPort = Number(args.api ?? 3334);
  http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    const cors = { 'access-control-allow-origin': '*' };
    if (path === '/stats.json') { res.writeHead(200, { 'content-type': 'application/json', ...cors }); return res.end(JSON.stringify(snapshot())); }
    if (path === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(page); }
    res.writeHead(404, cors); res.end('not found');
  }).listen(apiPort, '127.0.0.1', () => log(`status page at http://127.0.0.1:${apiPort}/`));
}

const port = await stratum.listen(Number(args.port ?? 3333));
log(`datstr gateway on ${NETWORK}: stratum :${port} diff ${DIFF} paying ${payAddrs.join(', ')} via ${rpc.url}${STOP < Infinity ? ` stop-height ${STOP}` : ''}${MIN_BITS ? ` min-bits ${MIN_BITS}` : ''}`);
await refresh(true);
setInterval(() => refresh(false), POLL);
setInterval(() => log(`stats: shares ${stats.shares} rejected ${stats.rejected} blocks ${stats.blocks} clients ${stratum.clients.size}`), 60000);
