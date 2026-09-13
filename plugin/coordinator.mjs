// The datstr coordinator, level 1 (SPEC.md sections 8 to 11): verifies signed shares with the
// engine, keeps the difficulty-summed window, dictates the coinbase split, relays blocks, and
// writes every document an auditor needs. Transport-agnostic: connect() takes anything with
// send/onMessage/onClose. Hosted by standalone.mjs or as a JSS plugin (index.mjs).
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { signEvent, verifyEvent, content as contentOf, pubkeyOf } from '../gateway/lib/nostr.mjs';
import { rootFromBranches } from '../gateway/lib/merkle.mjs';
import { computeSplit, windowOf, scaleSplit, difficultyOf } from '../gateway/lib/split.mjs';
import { meets } from '../gateway/lib/target.mjs';
import { scriptToAddress } from '../gateway/lib/address.mjs';

export const KIND = { share: 23400, ack: 23401, assignment: 23402, split: 23403, pool: 33400, miner: 33401, delegation: 33402, snapshot: 33404, block: 33405 };
const RULES = ['segwit', 'blake2b'];
const DEFAULTS = { feeBps: 0, feeScript: null, windowMultiple: 2, windowMinWeight: 0, minDifficulty: 1, minPayout: 546, maxOutputs: 512, staleDepth: 3, splitGrace: 30, poll: 1, splitDelayMs: 500 };

export class Coordinator {
  constructor({ k, pow, hash, rpc, key, params, dataDir, log = console.log }) {
    Object.assign(this, { k, pow, hash, rpc, key, dataDir, log });
    this.params = { ...DEFAULTS, ...Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && !Number.isNaN(v))) };
    this.pubkey = pubkeyOf(key);
    this.chain = this.params.chain;
    this.shares = []; this.seen = new Set(); this.masters = new Map(); this.workers = new Map(); this.clients = new Set();
    this.splits = new Map(); this.blocks = []; this.owed = {}; this.tip = null; this.prevAt = new Map();
    this.stats = { shares: 0, rejected: 0, blocks: 0, byCode: {} };
    this.started = Date.now();
  }

  // --- persistence: append-only files an auditor can replay ---
  async start() {
    await mkdir(`${this.dataDir}/snapshots`, { recursive: true }); await mkdir(`${this.dataDir}/blocks`, { recursive: true }); await mkdir(`${this.dataDir}/shares`, { recursive: true });
    const lines = async (f) => existsSync(f) ? (await readFile(f, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    for (const m of await lines(`${this.dataDir}/masters.jsonl`)) this.masters.set(m.pubkey, m);
    for (const d of await lines(`${this.dataDir}/delegations.jsonl`)) this.workers.set(d.worker, d);
    for (const s of await lines(`${this.dataDir}/shares.jsonl`)) { this.shares.push(s); this.seen.add(s.hash); }
    for (const b of await lines(`${this.dataDir}/blocks.jsonl`)) this.blocks.unshift(b);
    if (existsSync(`${this.dataDir}/owed.json`)) this.owed = JSON.parse(await readFile(`${this.dataDir}/owed.json`, 'utf8'));
    this.stats.shares = this.shares.length; this.stats.blocks = this.blocks.length;
    this.descriptor = signEvent(this.key, { kind: KIND.pool, tags: [['d', this.chain]], content: { chain: this.chain, ...this.params, endpoints: this.params.endpoints ?? {} } });
    await writeFile(`${this.dataDir}/pool.json`, JSON.stringify(this.descriptor, null, 1));
    this.log(`coordinator ${this.pubkey.slice(0, 16)}… on ${this.chain}: ${this.shares.length} shares, ${this.masters.size} masters, ${this.blocks.length} blocks loaded from ${this.dataDir}`);
    await this.poll();
    this.timer = setInterval(() => this.poll().catch((e) => this.log(`poll: ${e.message}`)), this.params.poll * 1000);
  }
  stop() { clearInterval(this.timer); for (const c of this.clients) c.close?.(); }

  // --- the tip, from the coordinator's own node; a new tip issues a split for the next height ---
  async poll() {
    const t = await this.rpc('getblocktemplate', { rules: RULES });
    if (this.tip && this.tip.height === t.height && this.tip.prev === t.previousblockhash) return;
    this.tip = { height: t.height, prev: t.previousblockhash, target: t.target, value: t.coinbasevalue, difficulty: difficultyOf(t.target), bits: t.bits, at: Date.now() };
    this.prevAt.set(t.height, t.previousblockhash);
    // a moment's delay so the share that found the block is credited before the split for the next height
    clearTimeout(this.splitTimer);
    await new Promise((r) => { this.splitTimer = setTimeout(r, this.params.splitDelayMs); });
    if (this.tip.height === t.height) await this.issueSplit(t.height);
  }

  need() { return Math.max(this.params.windowMultiple * (this.tip?.difficulty ?? 0), this.params.windowMinWeight); }

  async issueSplit(height) {
    const win = windowOf(this.shares, this.need());
    const r = computeSplit(win.shares, this.tip.value, this.params, this.owed);
    const outputs = r.outputs.map((o) => [o.script ?? this.masters.get(o.master)?.payout, o.value]).filter(([s]) => s);
    const ev = signEvent(this.key, { kind: KIND.split, tags: [['chain', this.chain], ['h', String(height)]], content: {
      chain: this.chain, height, outputs, window: { from: win.shares[0]?.seq ?? null, to: win.shares.at(-1)?.seq ?? null, weight: win.weight, need: this.need() }, owed: Object.entries(r.owed),
    } });
    const split = { event: ev, height, outputs, window: win, owedAfter: r.owed, W: r.W, sharesUpTo: this.shares.length, issued: Date.now() };
    this.splits.set(height, split);
    for (const h of [...this.splits.keys()]) if (h < height - this.params.staleDepth - 1) this.splits.delete(h);
    const perMaster = {}; for (const s of win.shares) perMaster[s.master] = (perMaster[s.master] ?? 0) + s.weight;
    await writeFile(`${this.dataDir}/snapshots/${height}.json`, JSON.stringify({
      '@type': 'datstr:LedgerSnapshot', chain: this.chain, height, split: ev.id, tipValue: this.tip.value, need: this.need(), sharesUpTo: this.shares.length,
      window: { fromSeq: win.shares[0]?.seq ?? null, toSeq: win.shares.at(-1)?.seq ?? null, weight: win.weight, shares: win.shares.map((s) => s.id) },
      perMaster, outputs, owedBefore: this.owed, owedAfter: r.owed, event: ev,
    }, null, 1));
    this.log(`split h${height}: ${outputs.length} outputs from ${win.shares.length} shares (weight ${win.weight} of ${this.need()} needed), value ${this.tip.value}`);
    this.broadcast({ type: 'split', event: ev });
  }

  broadcast(msg) { const s = JSON.stringify(msg); for (const c of this.clients) c.send(s); }

  // --- a gateway connection ---
  connect(conn) {
    conn.send = ((send) => (s) => { try { send(typeof s === 'string' ? s : JSON.stringify(s)); } catch {} })(conn.send.bind(conn));
    this.clients.add(conn);
    conn.onClose(() => { this.clients.delete(conn); this.log(`gateway ${conn.remote ?? ''} closed`); });
    conn.onMessage(async (raw) => {
      let m; try { m = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return conn.send({ type: 'error', error: 'bad json' }); }
      try {
        if (m.type === 'hello') return await this.hello(conn, m);
        if (m.type === 'share') return await this.share(conn, m.event);
        conn.send({ type: 'error', error: `unknown type ${m.type}` });
      } catch (e) { this.log(`gateway ${conn.remote ?? ''}: ${e.message}`); conn.send({ type: 'error', error: e.message }); }
    });
  }

  async hello(conn, m) {
    const d = m.descriptor;
    if (!d || d.kind !== KIND.miner || !verifyEvent(d)) return conn.send({ type: 'error', error: 'hello needs a signed miner descriptor (kind 33401)' });
    const c = contentOf(d);
    const payout = c?.payout?.[this.chain] ?? c?.payout;
    if (typeof payout !== 'string' || !/^[0-9a-f]+$/i.test(payout)) return conn.send({ type: 'error', error: 'descriptor has no payout script for this chain' });
    const known = this.masters.get(d.pubkey);
    if (!known || known.descriptor.created_at < d.created_at) {
      this.masters.set(d.pubkey, { pubkey: d.pubkey, payout: payout.toLowerCase(), descriptor: d });
      await appendFile(`${this.dataDir}/masters.jsonl`, JSON.stringify(this.masters.get(d.pubkey)) + '\n');
    }
    // a delegation (kind 33402) signed by the same master names the worker key the gateway signs with
    const g = m.delegation;
    if (g) {
      if (g.kind !== KIND.delegation || !verifyEvent(g) || g.pubkey !== d.pubkey) return conn.send({ type: 'error', error: 'delegation must be kind 33402 signed by the descriptor\'s master' });
      const gc = contentOf(g); const worker = gc?.worker, rule = gc?.chains?.[this.chain];
      if (!/^[0-9a-f]{64}$/i.test(worker ?? '') || !rule) return conn.send({ type: 'error', error: 'delegation names no worker for this chain' });
      const rec = { worker: worker.toLowerCase(), master: d.pubkey, expires: rule.expires ?? null, delegation: g };
      const old = this.workers.get(rec.worker);
      if (!old || old.delegation.created_at < g.created_at) { this.workers.set(rec.worker, rec); await appendFile(`${this.dataDir}/delegations.jsonl`, JSON.stringify(rec) + '\n'); }
      conn.worker = rec.worker;
    }
    conn.master = d.pubkey; conn.agent = m.agent ?? '';
    this.log(`gateway ${conn.remote ?? ''} hello: master ${d.pubkey.slice(0, 16)}…${conn.worker ? ` worker ${conn.worker.slice(0, 16)}…` : ''} (${conn.agent})`);
    const split = this.tip && this.splits.get(this.tip.height);
    conn.send({ type: 'welcome', pool: this.descriptor, split: split?.event ?? null });
  }

  // --- SPEC 8.1, in order ---
  async verify(ev) {
    const fail = (code, detail) => ({ ok: false, code, detail });
    if (ev.kind !== KIND.share || !verifyEvent(ev)) return fail('sig');
    const c = contentOf(ev); if (!c) return fail('content');
    // the signer is a delegated worker, or a master signing for itself
    const del = this.workers.get(ev.pubkey);
    const masterKey = del ? del.master : ev.pubkey;
    const master = this.masters.get(masterKey);
    if (!master) return fail('delegation-missing', del ? 'delegating master has no descriptor' : 'no miner descriptor or delegation for this key');
    if (del && del.expires != null && c.height > del.expires) return fail('delegation-expired', `expired at height ${del.expires}`);
    if (c.chain !== this.chain) return fail('chain-unknown', c.chain);
    let header; try { header = this.k.codec.decode('BlockHeader', c.header); } catch (e) { return fail('header-decode', e.message); }
    if (!this.tip) return fail('stale', 'no tip yet');
    if (!(c.height <= this.tip.height && c.height > this.tip.height - this.params.staleDepth)) return fail('stale', `height ${c.height}, tip ${this.tip.height}`);
    if (header.height !== c.height) return fail('header-decode', 'height mismatch');
    let prev = this.prevAt.get(c.height);
    if (!prev) { try { prev = await this.rpc('getblockhash', c.height - 1); this.prevAt.set(c.height, prev); } catch { return fail('stale', 'unknown height'); } }
    if (header.prevBlockHash !== prev) return fail('stale', 'prev mismatch');
    let coinbase; try { coinbase = this.k.codec.decode('Transaction', c.coinbase); } catch (e) { return fail('coinbase-decode', e.message); }
    if (this.k.blocks.bip34Height(coinbase) !== c.height) return fail('coinbase-height');
    const cbTxid = this.k.codec.txid(coinbase);
    if (rootFromBranches(cbTxid, c.branches ?? []) !== header.merkleRoot) return fail('merkle');
    const last = coinbase.outputs.at(-1);
    const parentsRoot = '00'.repeat(32);
    const expected = '6a20' + this.hash.bytesToHex(this.hash.taggedHash('datstr/share', this.hash.hexToBytes(ev.pubkey + parentsRoot)));
    if (!last || last.value !== 0 || last.scriptPubKey !== expected) return fail('commitment');
    const hasWitness = coinbase.outputs.length >= 2 && coinbase.outputs.at(-2).scriptPubKey.startsWith('6a24aa21a9ed');
    const payOutputs = coinbase.outputs.slice(0, coinbase.outputs.length - 1 - (hasWitness ? 1 : 0));
    if (c.split === 'solo') {
      if (payOutputs.length !== 1 || payOutputs[0].scriptPubKey !== master.payout) return fail('split', 'solo share must pay the master alone');
    } else {
      const split = [...this.splits.values()].find((s) => s.event.id === c.split);
      if (!split) return fail('split', 'unknown split');
      if (split.height !== c.height) return fail('split', 'split is for another height');
      const V = payOutputs.reduce((a, o) => a + o.value, 0);
      const want = scaleSplit(split.outputs, V);
      if (payOutputs.length !== want.length || payOutputs.some((o, i) => o.scriptPubKey !== want[i][0] || o.value !== want[i][1])) return fail('split', 'coinbase outputs differ from the split');
    }
    const d = this.pow.hashHeaderV2Detailed(header);
    if (!/^[0-9a-f]{64}$/i.test(c.target ?? '')) return fail('pow', 'no target');
    if (!meets(this.hash.hexToBytes(d.blake2b2), this.hash.hexToBytes(c.target))) return fail('pow', 'hash above the share target');
    const weight = difficultyOf(c.target);
    if (weight < this.params.minDifficulty) return fail('difficulty-floor', `${weight} < ${this.params.minDifficulty}`);
    if (this.seen.has(d.blockHash)) return fail('duplicate');
    const netTarget = c.height === this.tip.height ? this.tip.target : null;
    const isBlock = netTarget ? meets(this.hash.hexToBytes(d.blockHash), this.hash.hexToBytes(netTarget)) : false;
    return { ok: true, weight, master: masterKey, worker: ev.pubkey, hash: d.blockHash, isBlock, height: c.height, coinbaseTxid: cbTxid, splitId: c.split };
  }

  async share(conn, ev) {
    const r = await this.verify(ev);
    if (!r.ok) {
      this.stats.rejected++; this.stats.byCode[r.code] = (this.stats.byCode[r.code] ?? 0) + 1;
      this.log(`share ${ev?.id?.slice(0, 12)}… refused: ${r.code}${r.detail ? ' (' + r.detail + ')' : ''}`);
      return conn.send({ type: 'ack', event: signEvent(this.key, { kind: KIND.ack, tags: [['e', ev?.id ?? '']], content: { share: ev?.id ?? null, result: r.code, detail: r.detail ?? null, weight: 0 } }) });
    }
    const rec = { seq: this.shares.length + 1, id: ev.id, master: r.master, worker: r.worker, weight: r.weight, height: r.height, hash: r.hash, split: r.splitId, at: Math.floor(Date.now() / 1000) };
    this.shares.push(rec); this.seen.add(r.hash); this.stats.shares++;
    await appendFile(`${this.dataDir}/shares.jsonl`, JSON.stringify(rec) + '\n');
    await writeFile(`${this.dataDir}/shares/${ev.id}.json`, JSON.stringify(ev));
    const ack = signEvent(this.key, { kind: KIND.ack, tags: [['e', ev.id]], content: { share: ev.id, result: 'ok', weight: r.weight, seq: rec.seq } });
    conn.send({ type: 'ack', event: ack });
    this.log(`share #${rec.seq} ${r.hash.slice(0, 16)}… h${r.height} master ${r.master.slice(0, 12)}… weight ${r.weight}${r.isBlock ? ' BLOCK' : ''}`);
    if (r.isBlock) await this.block(ev, r);
  }

  async block(ev, r) {
    const c = contentOf(ev);
    let result = 'no block data';
    if (c.block) { try { result = await this.rpc('submitblock', c.block); result = result === null ? 'accepted' : result; } catch (e) { result = e.message; } }
    let onChain = false; try { onChain = (await this.rpc('getblockheader', r.hash)).confirmations >= 0; } catch {}
    const split = r.splitId === 'solo' ? null : [...this.splits.values()].find((s) => s.event.id === r.splitId);
    if (split) { this.owed = split.owedAfter; await writeFile(`${this.dataDir}/owed.json`, JSON.stringify(this.owed)); }
    const rec = { '@type': 'datstr:BlockRecord', chain: this.chain, height: r.height, hash: r.hash, share: ev.id, master: r.master, coinbase: r.coinbaseTxid, split: r.splitId, relay: result, onChain, at: Math.floor(Date.now() / 1000) };
    this.blocks.unshift(rec); this.stats.blocks++;
    await appendFile(`${this.dataDir}/blocks.jsonl`, JSON.stringify(rec) + '\n');
    await writeFile(`${this.dataDir}/blocks/${r.hash}.json`, JSON.stringify(rec, null, 1));
    this.log(`BLOCK h${r.height} ${r.hash} by ${r.master.slice(0, 12)}…: relay ${result}, on chain ${onChain}`);
  }

  snapshot() {
    const now = Date.now();
    const win = this.tip ? windowOf(this.shares, this.need()) : { shares: [], weight: 0 };
    const perMaster = {}; for (const s of win.shares) perMaster[s.master] = (perMaster[s.master] ?? 0) + s.weight;
    const addr = (spk) => scriptToAddress(spk, this.k.params.bech32Hrp) ?? spk;
    const cut = now / 1000 - 600, recent = this.shares.filter((s) => s.at >= cut);
    const since = Math.max(cut, this.started / 1000), rate = recent.reduce((a, s) => a + s.weight * 4294967296, 0) / Math.max(1, now / 1000 - since);
    const lastByMaster = {}; for (const s of this.shares) lastByMaster[s.master] = s.at;
    const totalByMaster = {}; for (const s of this.shares) totalByMaster[s.master] = (totalByMaster[s.master] ?? 0) + s.weight;
    const split = this.tip ? this.splits.get(this.tip.height) : null;
    return {
      version: 'datstr-coordinator/0.0.1', pubkey: this.pubkey, chain: this.chain, node: this.rpc.url, params: this.params, uptime_seconds: Math.floor((now - this.started) / 1000), tip: this.tip,
      stats: this.stats, shares_total: this.shares.length, hashrate: rate, shares_last_10min: recent.length,
      masters: [...this.masters.values()].map((m) => ({ pubkey: m.pubkey, payout: m.payout, address: addr(m.payout), weight_window: perMaster[m.pubkey] ?? 0, weight_total: totalByMaster[m.pubkey] ?? 0, last_share_seconds: lastByMaster[m.pubkey] ? Math.floor(now / 1000 - lastByMaster[m.pubkey]) : null, connected: [...this.clients].some((c) => c.master === m.pubkey) })),
      window: { shares: win.shares.length, weight: win.weight, need: this.need(), perMaster, from_seq: win.shares[0]?.seq ?? null, to_seq: win.shares.at(-1)?.seq ?? null },
      split: split ? { id: split.event.id, height: split.height, issued_seconds_ago: Math.floor((now - split.issued) / 1000), outputs: split.outputs.map(([spk, v]) => ({ script: spk, value_sats: v, address: addr(spk) })), value: this.tip.value } : null,
      gateways: [...this.clients].map((c) => ({ remote: c.remote ?? null, master: c.master ?? null, worker: c.worker ?? null, agent: c.agent ?? null })), owed: this.owed, blocks: this.blocks.slice(0, 50),
      workers: [...this.workers.values()].map((w) => ({ worker: w.worker, master: w.master, expires: w.expires })),
    };
  }
}

// Build a coordinator from a config object shared by the standalone host and the JSS plugin.
export async function createCoordinator(config, log) {
  const { makeRpc } = await import('../gateway/lib/rpc.mjs');
  const { loadEngine } = await import('../gateway/lib/engine.mjs');
  const network = config.network ?? 'btc:testnet4-blake2b';
  const rpc = await makeRpc(config.conf ?? '~/knots-testnet4/bitcoin.conf', network);
  const { k, pow, hash } = await loadEngine({ network, activationHeight: Number(config.activation ?? 0), headline: config.headline ?? '' });
  let key = config.key;
  if (!key) {
    const { randomKey } = await import('../gateway/lib/nostr.mjs');
    const f = `${config.dataDir}/coordinator.key`;
    await mkdir(config.dataDir, { recursive: true });
    key = existsSync(f) ? (await readFile(f, 'utf8')).trim() : randomKey();
    if (!existsSync(f)) await writeFile(f, key + '\n', { mode: 0o600 });
  }
  const co = new Coordinator({ k, pow, hash, rpc, key, params: { chain: network, ...(config.params ?? {}) }, dataDir: config.dataDir, log });
  await co.start();
  return co;
}

// HTTP routes every host serves, as (path, handler) pairs returning [status, type, body].
export async function routes(co) {
  const json = (o) => [200, 'application/json', JSON.stringify(o)];
  const file = async (p) => existsSync(p) ? [200, 'application/json', await readFile(p, 'utf8')] : [404, 'text/plain', 'not found'];
  const safe = (s) => /^[0-9a-zA-Z_-]+$/.test(s);
  const html = existsSync(new URL('./status.html', import.meta.url)) ? await readFile(new URL('./status.html', import.meta.url), 'utf8') : '<p>no status page</p>';
  const auditUrl = new URL('../audit/index.html', import.meta.url);
  const audit = existsSync(auditUrl) ? await readFile(auditUrl, 'utf8') : '<p>no audit page</p>';
  return async (path) => {
    if (path === '/' || path === '') return [200, 'text/html; charset=utf-8', html];
    if (path === '/audit' || path === '/audit/') return [200, 'text/html; charset=utf-8', audit];
    if (path === '/gateway/lib/split.mjs') return [200, 'text/javascript; charset=utf-8', await readFile(new URL('../gateway/lib/split.mjs', import.meta.url), 'utf8')];
    if (path === '/stats.json') return json(co.snapshot());
    if (path === '/pool.json') return json(co.descriptor);
    let m;
    if ((m = /^\/snapshots\/(\d+)\.json$/.exec(path))) return file(`${co.dataDir}/snapshots/${m[1]}.json`);
    if ((m = /^\/blocks\/([0-9a-f]{64})\.json$/.exec(path))) return file(`${co.dataDir}/blocks/${m[1]}.json`);
    if ((m = /^\/shares\/([0-9a-f]{64})\.json$/.exec(path))) return file(`${co.dataDir}/shares/${m[1]}.json`);
    if (path === '/shares.jsonl') return existsSync(`${co.dataDir}/shares.jsonl`) ? [200, 'application/x-ndjson', await readFile(`${co.dataDir}/shares.jsonl`, 'utf8')] : [200, 'application/x-ndjson', ''];
    if (path === '/delegations.jsonl') return existsSync(`${co.dataDir}/delegations.jsonl`) ? [200, 'application/x-ndjson', await readFile(`${co.dataDir}/delegations.jsonl`, 'utf8')] : [200, 'application/x-ndjson', ''];
    if (path === '/masters.jsonl') return existsSync(`${co.dataDir}/masters.jsonl`) ? [200, 'application/x-ndjson', await readFile(`${co.dataDir}/masters.jsonl`, 'utf8')] : [200, 'application/x-ndjson', ''];
    return safe(path) ? [404, 'text/plain', 'not found'] : [404, 'text/plain', 'not found'];
  };
}
