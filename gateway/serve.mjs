#!/usr/bin/env node
// datstr gateway: getblocktemplate from your own node → datstr coinbase → stratum jobs → shares →
// blocks submitted to your own node. No coordinator yet: the split is the payout addresses given.
//
//   node gateway/serve.mjs --conf <bitcoin.conf> --network btc:testnet4-blake2b --pay <addr>[,<addr>]
//                          [--port 3333] [--diff 1] [--poll 2] [--refresh 30] [--worker <hex>] [--activation N]
//                          [--stop-height N] [--min-bits 1d00ffff] [--api 3334]
//                          [--pool ws://host:port/ws] [--key <hex>] [--key-file <path>]
//                          [--vardiff on|off] [--vardiff-target 10] [--vardiff-min 0.0001] [--vardiff-max 1000000]
//                          [--descriptor <file> --delegation <file>]
//
// --descriptor F   a miner descriptor (kind 33401) signed by a master key, with
// --delegation F   a delegation (kind 33402) from that master to this gateway's worker key,
//                  both made by gateway/delegate.mjs where the master key lives. The
//                  coordinator then credits the master and the gateway never holds its key.
//                  Without them the worker is its own master, paid at --pay.
//
// --diff D         the difficulty every miner starts at (ratum's convention: 1 expects 2^32 hashes).
// --vardiff        on by default: each connection's difficulty moves so it sends a share about
//                  every --vardiff-target seconds. A miner pins its own with d=<n> in the password.
//
// --pool URL       a datstr coordinator. The gateway signs shares with its worker key, follows
//                  the coordinator's coinbase split, and falls back to solo work while it is
//                  unreachable. --key-file (default ~/.datstr/<network>.key) holds the key,
//                  created on first run; --key overrides it.
//
// --api N          serve a status page at http://127.0.0.1:N/ and its data at /stats.json
//
// --stop-height N  never mine a height above N: jobs stop and clients are told nothing new.
//                  For testnet4 before the 151,200 retarget: --stop-height 151198.
// --min-bits X     accepted for compatibility; no longer holds work. Miners never idle, so
//                  holding only made their shares stale. Work is served at every difficulty.
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
import { signEvent, randomKey, pubkeyOf, verifyEvent, content as contentOf } from './lib/nostr.mjs';
import { coinbaseBranches } from './lib/merkle.mjs';
import { scaleSplit } from './lib/split.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { SCHEMA } from './lib/engine.mjs';
const { attachWsServer } = await import(`${SCHEMA}/codec/ws.js`);
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
const VARDIFF = args.vardiff === 'off' ? null : { targetSeconds: Number(args['vardiff-target'] ?? 10), min: Number(args['vardiff-min'] ?? 0.0001), max: Number(args['vardiff-max'] ?? 1e6) };

// --- the worker key and the coordinator (SPEC 4, 8, 9) ---
let KEY = args.key;
if (!KEY) {
  const f = (args['key-file'] ?? `~/.datstr/${NETWORK.replace(/[^a-z0-9]+/gi, '-')}.key`).replace(/^~/, homedir());
  if (existsSync(f)) KEY = (await readFile(f, 'utf8')).trim();
  else { KEY = randomKey(); await mkdir(f.replace(/\/[^/]+$/, ''), { recursive: true }); await writeFile(f, KEY + '\n', { mode: 0o600 }); log(`new worker key written to ${f}`); }
}
const WORKER = pubkeyOf(KEY);
const pool = { url: args.pool ?? null, ws: null, connected: false, pubkey: null, splits: new Map(), acked: 0, refused: 0, lastAck: null, backoff: 1000 };
const DESCRIPTOR = args.descriptor ? JSON.parse(await readFile(args.descriptor, 'utf8')) : null;
const DELEGATION = args.delegation ? JSON.parse(await readFile(args.delegation, 'utf8')) : null;
if (DESCRIPTOR && !verifyEvent(DESCRIPTOR)) throw new Error('--descriptor does not verify');
if (DELEGATION && (!verifyEvent(DELEGATION) || (contentOf(DELEGATION)?.worker ?? '').toLowerCase() !== WORKER)) throw new Error(`--delegation does not verify or is not for this worker ${WORKER}`);
if ((DESCRIPTOR && !DELEGATION) || (!DESCRIPTOR && DELEGATION)) throw new Error('--descriptor and --delegation go together');
const MASTER = DESCRIPTOR ? DESCRIPTOR.pubkey : WORKER;
const MASTER_PAYOUT = DESCRIPTOR ? (contentOf(DESCRIPTOR)?.payout?.[NETWORK] ?? '').toLowerCase() : payScripts[0];
if (DESCRIPTOR && !MASTER_PAYOUT) throw new Error(`--descriptor has no payout for ${NETWORK}`);
const descriptor = () => DESCRIPTOR ?? signEvent(KEY, { kind: 33401, tags: [['d', WORKER], ['chain', NETWORK]], content: { chain: NETWORK, payout: { [NETWORK]: payScripts[0] } } });
const ackedSeqs = []; // seq of every share the coordinator credited, for the split guard
let mastersKnown = { at: 0, scripts: new Set() };
async function knownScripts() {
  if (Date.now() - mastersKnown.at < 60000) return mastersKnown.scripts;
  try { const t = await (await fetch(pool.url.replace(/^ws/, 'http').replace(/\/ws$/, '/masters.jsonl'))).text(); mastersKnown = { at: Date.now(), scripts: new Set(t.split('\n').filter(Boolean).map((l) => JSON.parse(l).payout)) }; } catch {}
  return mastersKnown.scripts;
}
function poolConnect() {
  if (!pool.url) return;
  let ws; try { ws = new WebSocket(pool.url); } catch (e) { log(`pool: ${e.message}`); return setTimeout(poolConnect, pool.backoff); }
  pool.ws = ws;
  ws.onopen = () => { pool.connected = true; pool.backoff = 1000; log(`pool: connected to ${pool.url} as worker ${WORKER.slice(0, 16)}…${DESCRIPTOR ? ` for master ${MASTER.slice(0, 16)}…` : ''}`); ws.send(JSON.stringify({ type: 'hello', descriptor: descriptor(), ...(DELEGATION ? { delegation: DELEGATION } : {}), agent: VERSION })); };
  ws.onmessage = async (e) => {
    const raw = typeof e.data === 'string' ? e.data : e.data instanceof Blob ? await e.data.text() : Buffer.from(e.data).toString();
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'welcome') { pool.pubkey = m.pool?.pubkey ?? null; if (m.split) onSplit(m.split); log(`pool: welcome from ${pool.pubkey?.slice(0, 16)}…`); }
    else if (m.type === 'split') onSplit(m.event);
    else if (m.type === 'ack') { const c = contentOf(m.event) ?? {}; if (c.result === 'ok') { pool.acked++; if (c.seq) { ackedSeqs.push(c.seq); if (ackedSeqs.length > 10000) ackedSeqs.shift(); } } else pool.refused++; pool.lastAck = c; if (c.result !== 'ok') log(`pool: share refused: ${c.result}${c.detail ? ' (' + c.detail + ')' : ''}`); }
    else if (m.type === 'error') log(`pool: error ${m.error}`);
  };
  ws.onclose = () => { if (pool.connected) log(`pool: disconnected, solo work until it is back`); pool.connected = false; pool.ws = null; pool.backoff = Math.min(pool.backoff * 2, 30000); setTimeout(poolConnect, pool.backoff); if (current) refresh(true).catch(() => {}); };
  ws.onerror = () => {};
}
async function onSplit(ev) {
  if (!verifyEvent(ev) || (pool.pubkey && ev.pubkey !== pool.pubkey)) return log('pool: split with a bad signature ignored');
  const c = contentOf(ev); if (!c || c.chain !== NETWORK) return;
  // the guard (SPEC 9.3): a split that leaves this master out while its shares are in the window,
  // or that pays a script no master registered, is refused and the gateway mines solo for that height
  const outs = Array.isArray(c.outputs) ? c.outputs : [];
  const w = c.window ?? {};
  const mine = w.from != null && w.to != null && ackedSeqs.some((q) => q >= w.from && q <= w.to);
  const paysMe = outs.some(([spk]) => spk === MASTER_PAYOUT);
  if (outs.length && mine && !paysMe) { pool.splits.delete(c.height); return log(`pool: split for h${c.height} REFUSED: my shares are in its window but it pays my master nothing; solo for this height`); }
  if (outs.length) {
    const known = await knownScripts();
    const strangers = outs.filter(([spk]) => !known.has(spk) && spk !== MASTER_PAYOUT);
    if (known.size && strangers.length) { pool.splits.delete(c.height); return log(`pool: split for h${c.height} REFUSED: pays ${strangers.length} script(s) no master registered (${strangers[0][0].slice(0, 20)}…); solo for this height`); }
  }
  pool.splits.set(c.height, { id: ev.id, outputs: c.outputs, event: ev });
  for (const h of [...pool.splits.keys()]) if (h < c.height - 4) pool.splits.delete(h);
  log(`pool: split for h${c.height}, ${c.outputs.length} outputs`);
  if (current && current.height === c.height && current.splitId !== ev.id) refresh(true).catch(() => {});
}
function poolSend(obj) { if (pool.connected && pool.ws) pool.ws.send(JSON.stringify(obj)); }
poolConnect();

let jobSeq = 0, current = null, seen = new Set();
const stats = { shares: 0, rejected: 0, blocks: 0, diff: 0, rejectedDiff: 0 };
const started = Date.now();
let VERSION = 'datstr-gateway/0.0.1';
try { VERSION += '/' + execSync('git rev-parse --short HEAD', { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
const history = []; // [unix seconds, hashes per second], one sample a minute, a day kept
let nodeWarnings = [];
const blocks = []; // found blocks, newest first
const recent = []; // [time, difficulty] of accepted shares, for the hashrate estimate
const clientStats = new WeakMap();
const cstat = (c) => { let x = clientStats.get(c); if (!x) { x = { shares: 0, rejected: 0, diff: 0, rejectedDiff: 0, lastShare: null, since: Date.now(), recent: [] }; clientStats.set(c, x); } return x; };
const rateOf = (samples, now) => { const cut = now - 600000; while (samples.length && samples[0][0] < cut) samples.shift(); const from = Math.max(cut, started); return samples.reduce((a, [, d]) => a + d * 4294967296, 0) / Math.max(1, (now - from) / 1000); };

function makeJob(t) {
  const sp = pool.connected ? pool.splits.get(t.height) : null;
  const split = sp && sp.outputs.length ? scaleSplit(sp.outputs, t.coinbasevalue) : null;
  const b = buildBlock({ k, hash, template: t, payScripts, worker: WORKER, split });
  const d = pow.hashHeaderV2Detailed(b.header);
  const prevHidden = taggedHash('Bitcoin prevblock header, hashed', hexToBytes(t.previousblockhash)); prevHidden.fill(0, 0, 6);
  return {
    id: (++jobSeq).toString(16).padStart(8, '0'), height: t.height, prev: t.previousblockhash, template: t, block: b,
    prevHidden: bytesToHex(prevHidden), coinb1: '000000' + d.h2, bits: t.bits, ntimeField: '00'.repeat(8),
    networkTarget: hexToBytes(t.target), made: Date.now(), splitId: split ? sp.id : 'solo',
    branches: coinbaseBranches([b.cbTxid, ...t.transactions.map((x) => x.txid)]),
  };
}

const stratum = new StratumServer({ difficulty: DIFF, vardiff: VARDIFF, log, maxClients: Number(args['max-clients'] ?? 1024), onShare: async ({ job, fields, user, client, diff, target }) => {
  const header = { ...job.block.header, ...fields };
  const d = pow.hashHeaderV2Detailed(header);
  const powBytes = hexToBytes(d.blake2b2), hashBytes = hexToBytes(d.blockHash);
  const cs = cstat(client);
  if (!meets(powBytes, target)) { stats.rejected++; cs.rejected++; cs.rejectedDiff += diff; stats.rejectedDiff += diff; return { ok: false, code: 23, reason: 'low difficulty' }; }
  if (seen.has(d.blockHash)) { stats.rejected++; cs.rejected++; cs.rejectedDiff += diff; stats.rejectedDiff += diff; return { ok: false, code: 22, reason: 'duplicate' }; }
  seen.add(d.blockHash);
  stats.shares++; stats.diff += diff; cs.shares++; cs.diff += diff; cs.lastShare = Date.now(); recent.push([Date.now(), diff]); cs.recent.push([Date.now(), diff]);
  const shareTargetHex = bytesToHex(target);
  const isBlock = meets(hashBytes, job.networkTarget);
  const stale = job.prev !== current?.prev;
  const blockHex = isBlock ? k.codec.encodeHex('Block', { header, transactions: job.block.transactions }) : null;
  poolSend({ type: 'share', event: signEvent(KEY, { kind: 23400, tags: [['chain', NETWORK], ['h', String(job.height)], ['split', job.splitId]], content: {
    chain: NETWORK, height: job.height, header: k.codec.encodeHex('BlockHeader', header), coinbase: k.codec.encodeHex('Transaction', job.block.coinbase), branches: job.branches,
    target: shareTargetHex, split: job.splitId, parents: [], job: job.id, ...(blockHex && job.height <= STOP ? { block: blockHex } : {}),
  } }) });
  log(`share ${d.blockHash.slice(0, 20)}… job ${job.id} h${job.height} diff ${diff} ${user}${isBlock ? ' BLOCK' : ''}${stale ? ' (stale job)' : ''}${job.splitId === 'solo' ? '' : ' split ' + job.splitId.slice(0, 8)}`);
  if (isBlock && job.height > STOP) { log(`BLOCK ${d.blockHash} at height ${job.height} NOT submitted: above --stop-height ${STOP}`); return { ok: true }; }
  if (isBlock) {
    const hex = blockHex;
    const r = await rpc('submitblock', hex);
    blocks.unshift({ height: job.height, hash: d.blockHash, time: Math.floor(Date.now() / 1000), user, coinbase: job.block.cbTxid, commitment: job.block.commitment, value: job.template.coinbasevalue, txs: job.block.transactions.length, accepted: r === null, result: r });
    if (blocks.length > 200) blocks.pop();
    if (r === null) { stats.blocks++; log(`BLOCK ${d.blockHash} height ${job.height} accepted by the node, coinbase ${job.block.cbTxid}, commitment ${job.block.commitment.slice(0, 16)}…`); await refresh(true); }
    else log(`BLOCK ${d.blockHash} refused by the node: ${r}`);
  }
  return { ok: true };
} });

let holding = null; // why no work is being served, logged once per reason
let minBitsNoted = false;
let awaiting = null; const SPLIT_WAIT = Number(args['split-wait'] ?? 3) * 1000;
function hold(reason) { if (holding !== reason) { holding = reason; log(`holding: ${reason}`); } stratum.pause(true); }

async function refresh(force) {
  let t; try { t = await rpc('getblocktemplate', { rules: RULES }); } catch (e) { log(`getblocktemplate: ${e.message}`); return; }
  if (t.height > STOP) return hold(`height ${t.height} is above --stop-height ${STOP}`);
  // --min-bits used to hold work outside a chain's minimum-difficulty window. Miners never idle: they
  // kept hashing the last job, whose shares were stale the moment the tip moved. Serving the current
  // tip at whatever difficulty it has costs the same CPU and every share is proof of work on the
  // real tip, so the flag is now informational only.
  if (MIN_BITS && !minBitsNoted) { minBitsNoted = true; log(`--min-bits ${MIN_BITS}: noted; work is served at every difficulty, shares stay valid across the hold`); }
  // joined to a coordinator but no split for this height yet: give it a moment before going solo
  if (pool.connected && !pool.splits.get(t.height)) {
    if (awaiting?.height !== t.height) awaiting = { height: t.height, since: Date.now() };
    if (Date.now() - awaiting.since < SPLIT_WAIT) return hold(`waiting for the coordinator's split for h${t.height}`);
  }
  holding = null; stratum.pause(false);
  const tip = t.previousblockhash !== current?.prev;
  const bits = current && t.bits !== current.bits;
  const txs = current && t.transactions.length !== current.template.transactions.length;
  const old = current && Date.now() - current.made > REFRESH;
  if (!force && current && !tip && !bits && !txs && !old) return;
  if (tip) seen = new Set();
  current = makeJob(t);
  stratum.publish(current, tip); stratum.retire(8);
  log(`job ${current.id} h${t.height} prev ${t.previousblockhash.slice(0, 16)}… bits ${t.bits} txs ${t.transactions.length} value ${t.coinbasevalue} ${current.splitId === 'solo' ? 'solo' : 'split ' + current.splitId.slice(0, 8) + ' (' + current.block.nSplit + ' outputs)'}${tip ? ' (new tip)' : bits ? ' (bits changed)' : txs ? ' (mempool)' : ' (refresh)'}`);
}

function snapshot() {
  const now = Date.now();
  const hashrate = rateOf(recent, now);
  const j = current;
  const weight = j ? k.blocks.blockWeight({ header: j.block.header, transactions: j.block.transactions }) : 0;
  const status = holding ? 'Holding' : j ? 'Serving work' : 'No job';
  return {
    version: VERSION, network: NETWORK, node: rpc.url, uptime_seconds: Math.floor((now - started) / 1000), status, holding, worker: WORKER, master: MASTER, delegated: !!DESCRIPTOR,
    pool: pool.url ? { url: pool.url, connected: pool.connected, pubkey: pool.pubkey, acked: pool.acked, refused: pool.refused, last: pool.lastAck, split: j?.splitId ?? null } : null,
    difficulty: DIFF, stop_height: STOP < Infinity ? STOP : null, min_bits: MIN_BITS, pay: payAddrs,
    work_update_seconds: REFRESH / 1000, poll_seconds: POLL / 1000, node_warnings: nodeWarnings,
    stratum: { listening: true, connections: stratum.clients.size, subscriptions: [...stratum.clients].filter((c) => c.subscribed).length, hashrate },
    shares_accepted: { count: stats.shares, diff: stats.diff }, shares_rejected: { count: stats.rejected, diff: stats.rejectedDiff }, blocks_found: stats.blocks, vardiff: VARDIFF,
    hashrate: { history, interval_seconds: 60 },
    job: j && {
      job_id: j.id, height: j.height, previous_block: j.prev, bits: j.bits, txn_count: j.template.transactions.length, value_sats: j.template.coinbasevalue,
      txn_total_weight: weight, weightlimit: j.template.weightlimit, created_seconds_ago: Math.floor((now - j.made) / 1000), difficulty: DIFF,
      coinbase_outputs: j.block.nSplit, payout: j.splitId === 'solo' ? 'gateway address' : 'pool split', commitment: j.block.commitment, split: j.splitId,
    },
    coinbaser: j ? j.block.coinbase.outputs.slice(0, j.block.nSplit).map((o, i) => ({ value_sats: o.value, address: scriptToAddress(o.scriptPubKey, k.params.bech32Hrp) ?? o.scriptPubKey, remainder: i === 0 && j.block.nSplit > 1 })) : [],
    clients: [...stratum.clients].map((c) => { const cs = cstat(c); return {
      remote: c.remote, username: c.user, useragent: c.agent ?? '', subscribed: c.subscribed, difficulty: c.diff, fixed: c.fixedDiff, hashrate: rateOf(cs.recent, now),
      accepted_count: cs.shares, accepted_diff: cs.diff, rejected_count: cs.rejected, rejected_diff: cs.rejectedDiff,
      last_accepted_seconds: cs.lastShare ? Math.floor((now - cs.lastShare) / 1000) : null, connected_seconds: Math.floor((now - cs.since) / 1000),
    }; }),
    blocks,
  };
}
setInterval(() => { history.push([Math.floor(Date.now() / 1000), rateOf(recent, Date.now())]); if (history.length > 1440) history.shift(); }, 60000);
setInterval(async () => { try { const m = await rpc('getmininginfo'); nodeWarnings = Array.isArray(m.warnings) ? m.warnings : m.warnings ? [m.warnings] : []; } catch (e) { nodeWarnings = [`node unreachable: ${e.message}`]; } }, 60000);
if (args.api !== 'false') {
  const apiPort = Number(args.api ?? 3334);
  const file = async (rel) => readFile(new URL(rel, import.meta.url), 'utf8');
  const server = http.createServer(async (req, res) => {
    const path = req.url.split('?')[0];
    const cors = { 'access-control-allow-origin': '*' };
    if (path === '/stats.json') { res.writeHead(200, { 'content-type': 'application/json', ...cors }); return res.end(JSON.stringify(snapshot())); }
    if (path === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(await file('./status.html')); }
    if (path === '/miner') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(await file('./miner.html')); }
    if (path === '/miner-core.mjs') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', ...cors }); return res.end(await file('./miner-core.mjs')); }
    res.writeHead(404, cors); res.end('not found');
  });
  // stratum over WebSocket at /stratum, for the browser miner: the same server, each socket wrapped to look like a TCP one
  attachWsServer(server, (client, req) => {
    if (req.url.split('?')[0] !== '/stratum') return client.close();
    const listeners = {};
    const sock = { remoteAddress: req.socket.remoteAddress, remotePort: req.socket.remotePort, destroyed: false, setNoDelay() {},
      on(ev, cb) { (listeners[ev] ??= []).push(cb); return sock; },
      write(s) { if (!sock.destroyed) client.send(new TextEncoder().encode(s)); },
      destroy() { if (!sock.destroyed) { sock.destroyed = true; try { client.close(); } catch {} } } };
    client.onMessage((payload) => { for (const cb of listeners.data ?? []) cb(new TextDecoder().decode(payload)); });
    client.onClose(() => { sock.destroyed = true; for (const cb of listeners.close ?? []) cb(); });
    stratum.accept(sock);
  });
  server.listen(apiPort, args['api-host'] ?? '127.0.0.1', () => log(`status page at http://127.0.0.1:${apiPort}/, browser miner at /miner, stratum over WebSocket at /stratum`));
}

const port = await stratum.listen(Number(args.port ?? 3333));
log(`datstr gateway on ${NETWORK}: stratum :${port} diff ${DIFF} paying ${payAddrs.join(', ')} via ${rpc.url}${STOP < Infinity ? ` stop-height ${STOP}` : ''}${MIN_BITS ? ` min-bits ${MIN_BITS}` : ''}`);
await refresh(true);
setInterval(() => refresh(false), POLL);
setInterval(() => log(`stats: shares ${stats.shares} rejected ${stats.rejected} blocks ${stats.blocks} clients ${stratum.clients.size}`), 60000);
