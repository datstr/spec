// The datstr coordinator, level 1 (SPEC.md sections 8 to 11): verifies signed shares with the
// engine, keeps the difficulty-summed window, dictates the coinbase split, relays blocks, and
// writes every document an auditor needs. Transport-agnostic: connect() takes anything with
// send/onMessage/onClose. Hosted by standalone.mjs or as a JSS plugin (index.mjs).
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { signEvent, verifyEvent, content as contentOf, pubkeyOf } from '../gateway/lib/nostr.mjs';
import { rootFromBranches } from '../gateway/lib/merkle.mjs';
import { computeSplit, windowOf, scaleSplit, difficultyOf } from '../gateway/lib/split.mjs';
import { meets, targetForDifficulty } from '../gateway/lib/target.mjs';
import { scriptToAddress } from '../gateway/lib/address.mjs';

// Web Ledgers (https://webledgers.org/): the coordinator's balances as JSON-LD, agent URIs to amounts.
const WL = 'https://w3id.org/webledgers', DATSTR_CTX = 'https://datstr.com/spec/context.jsonld';
const ledger = ({ id, name, description, currency, entries, extra = {} }) => {
  const now = Math.floor(Date.now() / 1000);
  return { '@context': [WL, DATSTR_CTX], type: 'WebLedger', id, name, description, defaultCurrency: currency, created: now, updated: now, ...extra,
    entries: entries.filter((e) => Number(e.amount) !== 0).map(({ url, amount, ...rest }) => ({ type: 'Entry', url, amount: String(amount), ...rest })) };
};
const didOf = (pubkey) => `did:nostr:${pubkey}`;
export const KIND = { share: 23400, ack: 23401, assignment: 23402, split: 23403, pool: 33400, miner: 33401, delegation: 33402, snapshot: 33404, block: 33405 };
const RULES = ['segwit', 'blake2b'];
const DEFAULTS = { feeBps: 0, feeScript: null, windowMultiple: 2, windowMinWeight: 0, minDifficulty: 1, startDifficulty: 1, vardiffSeconds: 10, assignmentGrace: 120, maxDifficulty: 1e8, minPayout: 546, maxOutputs: 512, staleDepth: 3, splitGrace: 30, poll: 1, splitDelayMs: 500,
  // socket hygiene: connections in all and per remote address, bytes per message, messages per second per connection (burst is twice that)
  maxConnections: 256, maxPerAddress: 16, maxMessageBytes: 4 * 1024 * 1024, maxMessagesPerSecond: 200, helloTimeoutMs: 15000 };

export class Coordinator {
  constructor({ k, pow, hash, rpc, key, params, dataDir, log = console.log }) {
    Object.assign(this, { k, pow, hash, rpc, key, dataDir, log });
    this.params = { ...DEFAULTS, ...Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && !Number.isNaN(v))) };
    this.pubkey = pubkeyOf(key);
    this.chain = this.params.chain;
    this.shares = []; this.seen = new Set(); this.masters = new Map(); this.workers = new Map(); this.clients = new Set();
    this.splits = new Map(); this.blocks = []; this.owed = {}; this.tip = null; this.prevAt = new Map(); this.targetAt = new Map();
    this.assignments = new Map(); this.assignmentsByMaster = new Map(); this.lastRetarget = 0;
    this.stats = { shares: 0, receipts: 0, rejected: 0, blocks: 0, byCode: {}, refusedConnections: 0, droppedConnections: 0 };
    this.paid = new Map(); // address → sats paid on chain, from block records and their snapshots
    this.byAddress = new Map();
    this.started = Date.now();
  }

  // --- persistence: append-only files an auditor can replay ---
  async start() {
    await mkdir(`${this.dataDir}/snapshots`, { recursive: true }); await mkdir(`${this.dataDir}/blocks`, { recursive: true }); await mkdir(`${this.dataDir}/shares`, { recursive: true });
    const lines = async (f) => existsSync(f) ? (await readFile(f, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    for (const m of await lines(`${this.dataDir}/masters.jsonl`)) this.masters.set(m.pubkey, m);
    for (const d of await lines(`${this.dataDir}/delegations.jsonl`)) this.workers.set(d.worker, d);
    for (const s of await lines(`${this.dataDir}/shares.jsonl`)) { this.shares.push(s); this.seen.add(s.hash); }
    for (const a of await lines(`${this.dataDir}/assignments.jsonl`)) this.addAssignment(a);
    for (const r of await lines(`${this.dataDir}/receipts.jsonl`)) this.seen.add(r.hash);
    for (const b of await lines(`${this.dataDir}/blocks.jsonl`)) this.blocks.unshift(b);
    if (existsSync(`${this.dataDir}/owed.json`)) this.owed = JSON.parse(await readFile(`${this.dataDir}/owed.json`, 'utf8'));
    this.stats.shares = this.shares.length; this.stats.blocks = this.blocks.length;
    // blocks the node knows that were credited as plain shares (a tip race before targetAt existed): record them
    const known = new Set(this.blocks.map((b) => b.hash));
    for (const sh of this.shares.slice(-300)) {
      if (known.has(sh.hash)) continue;
      let hdr; try { hdr = await this.rpc('getblockheader', sh.hash); } catch { continue; }
      const rec = { '@type': 'datstr:BlockRecord', chain: this.chain, height: sh.height, hash: sh.hash, share: sh.id, master: sh.master, coinbase: null, split: sh.split, relay: 'found on chain at start', onChain: hdr.confirmations >= 0, at: sh.at };
      this.blocks.unshift(rec); this.stats.blocks++; known.add(sh.hash);
      await appendFile(`${this.dataDir}/blocks.jsonl`, JSON.stringify(rec) + '\n'); await writeFile(`${this.dataDir}/blocks/${sh.hash}.json`, JSON.stringify(rec, null, 1));
      this.log(`block record backfilled: h${sh.height} ${sh.hash}`);
    }
    this.blocks.sort((a, b) => b.height - a.height);
    for (const b of [...this.blocks].reverse()) if (b.onChain) await this.creditPaid(b);
    await mkdir(`${this.dataDir}/ledgers`, { recursive: true }); await this.writeLedger('paid');
    this.descriptor = signEvent(this.key, { kind: KIND.pool, tags: [['d', this.chain]], content: { chain: this.chain, ...this.params, endpoints: this.params.endpoints ?? {} } });
    await writeFile(`${this.dataDir}/pool.json`, JSON.stringify(this.descriptor, null, 1));
    this.log(`coordinator ${this.pubkey.slice(0, 16)}… on ${this.chain}: ${this.shares.length} shares, ${this.masters.size} masters, ${this.blocks.length} blocks loaded from ${this.dataDir}`);
    await this.poll();
    this.timer = setInterval(() => this.poll().catch((e) => this.log(`poll: ${e.message}`)), this.params.poll * 1000);
  }
  stop() { clearInterval(this.timer); for (const c of this.clients) c.close?.(); }

  // --- the tip, from the coordinator's own node; a new tip issues a split for the next height ---
  async poll() {
    await this.retargetAssignments();
    const t = await this.rpc('getblocktemplate', { rules: RULES });
    // the target for a height can change without a new tip (testnet4's minimum-difficulty window): track it every poll
    this.targetAt.set(t.height, t.target);
    if (this.tip && this.tip.height === t.height && this.tip.prev === t.previousblockhash) { this.tip.target = t.target; this.tip.bits = t.bits; this.tip.difficulty = difficultyOf(t.target); return; }
    this.tip = { height: t.height, prev: t.previousblockhash, target: t.target, value: t.coinbasevalue, difficulty: difficultyOf(t.target), bits: t.bits, at: Date.now() };
    this.prevAt.set(t.height, t.previousblockhash); this.targetAt.set(t.height, t.target);
    for (const h of [...this.targetAt.keys()]) if (h < t.height - 16) this.targetAt.delete(h);
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
    await this.writeLedgers(height, win, r, outputs);
    this.log(`split h${height}: ${outputs.length} outputs from ${win.shares.length} shares (weight ${win.weight} of ${this.need()} needed), value ${this.tip.value}`);
    this.broadcast({ type: 'split', event: ev });
  }

  broadcast(msg) { const s = JSON.stringify(msg); for (const c of this.clients) c.send(s); }

  // --- SPEC 8.4: assignments. A share's weight is the difficulty of a target the coordinator
  // fixed for its master before the work, never one the gateway names after finding a hash.
  addAssignment(rec) {
    this.assignments.set(rec.id, rec);
    const l = this.assignmentsByMaster.get(rec.master) ?? []; l.push(rec); l.sort((a, b) => a.from - b.from || a.at - b.at); this.assignmentsByMaster.set(rec.master, l);
  }
  currentAssignment(master) { return this.assignmentsByMaster.get(master)?.at(-1) ?? null; }
  // the assignments a share of `master` at `height`, signed at `time`, may name: the latest whose
  // `from` is at or below the height, or the one before it within the grace after the latest was issued
  // 8.4: the latest issued at or before the share's signing time, the one before it within the
  // grace, or the first issued after it within the grace (clock skew); never anything later
  validAssignments(master, height, time) {
    const grace = this.params.assignmentGrace;
    const all = (this.assignmentsByMaster.get(master) ?? []).filter((a) => a.from <= height);
    const before = all.filter((a) => a.at <= time), latest = before.at(-1), prev = before.at(-2);
    const next = all.find((a) => a.at > time && a.at <= time + grace);
    const ok = [];
    if (latest) ok.push(latest); if (latest && prev && time <= latest.at + grace) ok.push(prev); if (next) ok.push(next);
    return ok;
  }
  async issueAssignment(master, difficulty, why) {
    const target = this.hash.bytesToHex(targetForDifficulty(difficulty)), from = this.tip?.height ?? 0;
    const ev = signEvent(this.key, { kind: KIND.assignment, tags: [['p', master], ['chain', this.chain]], content: { chain: this.chain, master, target, difficulty: difficultyOf(target), from } });
    const rec = { id: ev.id, master, target, from, at: ev.created_at, event: ev };
    this.addAssignment(rec);
    await appendFile(`${this.dataDir}/assignments.jsonl`, JSON.stringify(rec) + '\n');
    for (const c of this.clients) if (c.identities?.has(master)) c.send({ type: 'assignment', event: ev });
    this.log(`assignment for ${master.slice(0, 12)}…: difficulty ${difficultyOf(target)} from h${from} (${why})`);
    return rec;
  }
  // northbound vardiff: aim at one credited share per vardiffSeconds for every connected master,
  // measured on the shares credited since the master's current assignment
  async retargetAssignments() {
    const now = Math.floor(Date.now() / 1000);
    if (now - this.lastRetarget < 10) return; this.lastRetarget = now;
    const p = this.params, maxD = p.maxDifficulty ?? 1e8;
    const connected = new Set(); for (const c of this.clients) for (const m of c.identities ?? []) connected.add(m);
    for (const master of connected) {
      const cur = this.currentAssignment(master); if (!cur) continue;
      const since = now - cur.at; let n = 0;
      for (let i = this.shares.length - 1; i >= 0 && this.shares[i].at >= cur.at; i--) if (this.shares[i].master === master) n++;
      const d0 = difficultyOf(cur.target); let d;
      if (d0 > maxD) d = maxD;                                              // a runaway or a bad start: back to the ceiling
      else if (n >= 200 && since >= 5) d = d0 * p.vardiffSeconds * n / since; // a flood: go straight to the measured rate
      else if (since < 60) continue;                                         // otherwise one step a minute
      else if (n === 0) d = since >= 120 ? d0 / 64 : d0;                    // nothing for two minutes: come down fast
      else d = d0 * p.vardiffSeconds * n / since;
      d = Math.min(d0 * 256, Math.max(d0 / 64, d)); d = Math.min(maxD, Math.max(p.minDifficulty, Number(d.toPrecision(3))));
      if (d / d0 > 1.4 || d / d0 < 0.7) await this.issueAssignment(master, d, `${n} shares in ${since} s`);
    }
  }

  // --- a gateway connection ---
  connect(conn) {
    const p = this.params;
    conn.send = ((send) => (s) => { try { send(typeof s === 'string' ? s : JSON.stringify(s)); } catch {} })(conn.send.bind(conn));
    const addr = (conn.remote ?? '').replace(/:\d+$/, '');
    const perAddr = this.byAddress.get(addr) ?? 0;
    const drop = (why) => { this.stats.refusedConnections++; this.log(`gateway ${conn.remote ?? ''} refused: ${why}`); conn.send({ type: 'error', error: why }); try { conn.close?.(); } catch {} };
    if (this.clients.size >= p.maxConnections) return drop(`too many connections (${p.maxConnections})`);
    if (perAddr >= p.maxPerAddress) return drop(`too many connections from ${addr} (${p.maxPerAddress})`);
    this.byAddress.set(addr, perAddr + 1);
    this.clients.add(conn); conn.identities = new Set();
    let tokens = p.maxMessagesPerSecond * 2, last = Date.now(), closed = false;
    const kick = (why) => { if (closed) return; closed = true; this.stats.droppedConnections++; this.log(`gateway ${conn.remote ?? ''} dropped: ${why}`); conn.send({ type: 'error', error: why }); try { conn.close?.(); } catch {} };
    const helloTimer = setTimeout(() => { if (!conn.master) kick('no hello'); }, p.helloTimeoutMs);
    conn.onClose(() => { closed = true; clearTimeout(helloTimer); this.clients.delete(conn); const n = (this.byAddress.get(addr) ?? 1) - 1; if (n > 0) this.byAddress.set(addr, n); else this.byAddress.delete(addr); this.log(`gateway ${conn.remote ?? ''} closed`); });
    // messages from one socket are handled in order: a register that follows a hello must see the hello's effect
    let chain = Promise.resolve();
    conn.onMessage((raw) => { chain = chain.then(() => handle(raw)).catch((e) => this.log(`gateway ${conn.remote ?? ''}: ${e.message}`)); return chain; });
    const handle = async (raw) => {
      if (closed) return;
      const size = typeof raw === 'string' ? raw.length : raw.byteLength ?? raw.length ?? 0;
      if (size > p.maxMessageBytes) return kick(`message of ${size} bytes over the ${p.maxMessageBytes} limit`);
      const now = Date.now(); tokens = Math.min(p.maxMessagesPerSecond * 2, tokens + (now - last) / 1000 * p.maxMessagesPerSecond); last = now;
      if (tokens < 1) return kick(`more than ${p.maxMessagesPerSecond} messages a second`); tokens -= 1;
      let m; try { m = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return conn.send({ type: 'error', error: 'bad json' }); }
      try {
        if (m?.type === 'hello') return await this.hello(conn, m);
        if (!conn.master) return conn.send({ type: 'error', error: 'hello first' });
        if (m?.type === 'register') { const r = await this.register(conn, m); if (r.error) return conn.send({ type: 'error', error: r.error }); conn.send({ type: 'registered', master: r.master, worker: r.worker ?? null }); return conn.send({ type: 'assignment', event: r.assignment }); }
        if (m?.type === 'share') return await this.share(conn, m.event);
        conn.send({ type: 'error', error: `unknown type ${m?.type}` });
      } catch (e) { this.log(`gateway ${conn.remote ?? ''}: ${e.message}`); conn.send({ type: 'error', error: e.message }); }
    };
  }

  // A gateway registers every identity it mines for: its own at hello, others (clients that brought
  // an address or a delegation) with `register` on the same socket. Same rules for both.
  async register(conn, m) {
    const d = m.descriptor;
    if (!d || d.kind !== KIND.miner || !verifyEvent(d)) return { error: 'a signed miner descriptor (kind 33401) is needed' };
    const c = contentOf(d);
    const payout = c?.payout?.[this.chain] ?? c?.payout;
    if (typeof payout !== 'string' || !/^[0-9a-f]+$/i.test(payout)) return { error: 'descriptor has no payout script for this chain' };
    const known = this.masters.get(d.pubkey);
    if (!known || known.descriptor.created_at < d.created_at) {
      this.masters.set(d.pubkey, { pubkey: d.pubkey, payout: payout.toLowerCase(), descriptor: d });
      await appendFile(`${this.dataDir}/masters.jsonl`, JSON.stringify(this.masters.get(d.pubkey)) + '\n');
    }
    // a delegation (kind 33402) signed by the same master names the worker key the gateway signs with
    const g = m.delegation; let worker = null;
    if (g) {
      if (g.kind !== KIND.delegation || !verifyEvent(g) || g.pubkey !== d.pubkey) return { error: 'delegation must be kind 33402 signed by the descriptor\'s master' };
      const gc = contentOf(g); worker = gc?.worker; const rule = gc?.chains?.[this.chain];
      if (!/^[0-9a-f]{64}$/i.test(worker ?? '') || !rule) return { error: 'delegation names no worker for this chain' };
      const rec = { worker: worker.toLowerCase(), master: d.pubkey, expires: rule.expires ?? null, delegation: g };
      const old = this.workers.get(rec.worker);
      if (!old || old.delegation.created_at < g.created_at) { this.workers.set(rec.worker, rec); await appendFile(`${this.dataDir}/delegations.jsonl`, JSON.stringify(rec) + '\n'); }
      worker = rec.worker;
    }
    if (m.type === 'register') this.log(`gateway ${conn.remote ?? ''} registered master ${d.pubkey.slice(0, 16)}…${worker ? ` worker ${worker.slice(0, 16)}…` : ''}`);
    conn.identities.add(d.pubkey);
    const a = this.currentAssignment(d.pubkey) ?? await this.issueAssignment(d.pubkey, this.params.startDifficulty, 'first assignment');
    return { master: d.pubkey, worker, assignment: a.event };
  }

  async hello(conn, m) {
    const r = await this.register(conn, m);
    if (r.error) return conn.send({ type: 'error', error: r.error });
    conn.master = r.master; conn.worker = r.worker; conn.agent = m.agent ?? '';
    this.log(`gateway ${conn.remote ?? ''} hello: master ${r.master.slice(0, 16)}…${r.worker ? ` worker ${r.worker.slice(0, 16)}…` : ''} (${conn.agent})`);
    const split = this.tip && this.splits.get(this.tip.height);
    conn.send({ type: 'welcome', pool: this.descriptor, split: split?.event ?? null });
    conn.send({ type: 'assignment', event: r.assignment });
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
      if (split.outputs.length === 0) { // an empty split: the window had no shares, the coinbase pays the share's master alone
        if (payOutputs.length !== 1 || payOutputs[0].scriptPubKey !== master.payout) return fail('split', 'an empty split pays the master alone');
      } else {
        const V = payOutputs.reduce((a, o) => a + o.value, 0);
        const want = scaleSplit(split.outputs, V);
        if (payOutputs.length !== want.length || payOutputs.some((o, i) => o.scriptPubKey !== want[i][0] || o.value !== want[i][1])) return fail('split', 'coinbase outputs differ from the split');
      }
    }
    const d = this.pow.hashHeaderV2Detailed(header);
    if (!/^[0-9a-f]{64}$/i.test(c.target ?? '')) return fail('pow', 'no target');
    if (!meets(this.hash.hexToBytes(d.blake2b2), this.hash.hexToBytes(c.target))) return fail('pow', 'hash above the share target');
    // SPEC 8.2/8.4: a solo share is a receipt and weighs nothing; any other share weighs the
    // difficulty of the assignment it names, which must be the coordinator's own, for this
    // master, valid at this height, and the target it carries must be the assignment's
    let weight = 0, assignmentId = null;
    if (c.split !== 'solo') {
      const a = this.assignments.get(c.assignment ?? '');
      if (!a) return fail('assignment', 'unknown assignment');
      if (a.master !== masterKey) return fail('assignment', 'assignment is for another master');
      if (!this.validAssignments(masterKey, c.height, ev.created_at).includes(a)) return fail('assignment', 'assignment not valid for this height');
      if (c.target.toLowerCase() !== a.target) return fail('assignment', 'target differs from the assignment');
      weight = difficultyOf(a.target); assignmentId = a.id;
      if (weight < this.params.minDifficulty) return fail('difficulty-floor', `${weight} < ${this.params.minDifficulty}`);
    }
    if (this.seen.has(d.blockHash)) return fail('duplicate');
    // the network target for the share's own height: the tip may already have moved on by the time the share arrives
    const netTarget = this.targetAt.get(c.height) ?? (c.height === this.tip.height ? this.tip.target : null);
    let isBlock = netTarget ? meets(this.hash.hexToBytes(d.blockHash), this.hash.hexToBytes(netTarget)) : false;
    // a share that carries the block is one the gateway submitted: if the node has it, it is a block whatever we recorded for the target
    if (!isBlock && c.block) { try { const h = await this.rpc('getblockheader', d.blockHash); if (h && h.confirmations >= 0) isBlock = true; } catch {} }
    return { ok: true, weight, master: masterKey, worker: ev.pubkey, hash: d.blockHash, isBlock, height: c.height, coinbaseTxid: cbTxid, splitId: c.split, assignment: assignmentId };
  }

  async share(conn, ev) {
    const r = await this.verify(ev);
    if (!r.ok) {
      this.stats.rejected++; this.stats.byCode[r.code] = (this.stats.byCode[r.code] ?? 0) + 1;
      this.log(`share ${ev?.id?.slice(0, 12)}… refused: ${r.code}${r.detail ? ' (' + r.detail + ')' : ''}`);
      return conn.send({ type: 'ack', event: signEvent(this.key, { kind: KIND.ack, tags: [['e', ev?.id ?? '']], content: { share: ev?.id ?? null, result: r.code, detail: r.detail ?? null, weight: 0 } }) });
    }
    if (r.splitId === 'solo') { // a receipt: verified, kept, never in the window
      const rec = { id: ev.id, master: r.master, worker: r.worker, height: r.height, hash: r.hash, at: Math.floor(Date.now() / 1000) };
      this.seen.add(r.hash); this.stats.receipts++;
      await appendFile(`${this.dataDir}/receipts.jsonl`, JSON.stringify(rec) + '\n');
      await writeFile(`${this.dataDir}/shares/${ev.id}.json`, JSON.stringify(ev));
      conn.send({ type: 'ack', event: signEvent(this.key, { kind: KIND.ack, tags: [['e', ev.id]], content: { share: ev.id, result: 'ok', weight: 0, seq: null, receipt: true } }) });
      this.log(`receipt ${r.hash.slice(0, 16)}… h${r.height} master ${r.master.slice(0, 12)}… (solo, weight 0)${r.isBlock ? ' BLOCK' : ''}`);
      if (r.isBlock) await this.block(ev, r);
      return;
    }
    const rec = { seq: this.shares.length + 1, id: ev.id, master: r.master, worker: r.worker, weight: r.weight, height: r.height, hash: r.hash, split: r.splitId, assignment: r.assignment, at: Math.floor(Date.now() / 1000) };
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
    if (onChain) { await this.creditPaid(rec); await this.writeLedger('paid'); }
  }

  // --- Web Ledgers (SPEC 11): the window, the split, what is owed, what was paid ---
  addressOf(spk) { return scriptToAddress(spk, this.k.params.bech32Hrp) ?? spk; }
  agentOfScript(spk) { const m = [...this.masters.values()].filter((x) => x.payout === spk); return m.length === 1 ? didOf(m[0].pubkey) : `bitcoin:${this.addressOf(spk)}`; }
  async creditPaid(b) {
    if (b.paidCredited) return; b.paidCredited = true;
    try { const snap = JSON.parse(await readFile(`${this.dataDir}/snapshots/${b.height}.json`, 'utf8')); if (snap.split !== b.split) return;
      for (const [spk, sats] of snap.outputs) { const a = this.addressOf(spk); this.paid.set(a, (this.paid.get(a) ?? 0) + sats); } } catch {}
  }
  ledgers(height, win, r, outputs) {
    const base = `${this.params.endpoints?.http ?? ''}ledgers/`;
    const perMaster = {}; for (const s of win?.shares ?? []) perMaster[s.master] = (perMaster[s.master] ?? 0) + s.weight;
    return {
      window: ledger({ id: base + 'window.json', name: 'datstr window', description: `Proof-of-work weight per master in the window that pays height ${height} on ${this.chain}`, currency: 'share',
        entries: Object.entries(perMaster).map(([m, w]) => ({ url: didOf(m), amount: w, address: this.masters.get(m) ? this.addressOf(this.masters.get(m).payout) : undefined })),
        extra: { chain: this.chain, coordinator: didOf(this.pubkey), height, window: { from: win?.shares?.[0]?.seq ?? null, to: win?.shares?.at(-1)?.seq ?? null, weight: win?.weight ?? 0, need: this.need() } } }),
      split: ledger({ id: base + 'split.json', name: 'datstr split', description: `Coinbase outputs the next block at height ${height} pays on ${this.chain}`, currency: 'satoshi',
        entries: outputs.map(([spk, sats]) => ({ url: this.agentOfScript(spk), amount: sats, address: this.addressOf(spk), script: spk })),
        extra: { chain: this.chain, coordinator: didOf(this.pubkey), height, split: this.splits.get(height)?.event.id ?? null } }),
      owed: ledger({ id: base + 'owed.json', name: 'datstr owed', description: `Sats owed to masters a coinbase could not fit, paid first from the next block on ${this.chain}`, currency: 'satoshi',
        entries: Object.entries(r?.owed ?? this.owed).map(([m, sats]) => ({ url: didOf(m), amount: sats })), extra: { chain: this.chain, coordinator: didOf(this.pubkey) } }),
      paid: ledger({ id: base + 'paid.json', name: 'datstr paid', description: `Sats paid on chain by coinbases that followed this coordinator's splits on ${this.chain}`, currency: 'satoshi',
        entries: [...this.paid].map(([a, sats]) => ({ url: `bitcoin:${a}`, amount: sats, address: a })), extra: { chain: this.chain, coordinator: didOf(this.pubkey), blocks: this.blocks.filter((b) => b.onChain).length } }),
    };
  }
  async writeLedgers(height, win, r, outputs) {
    await mkdir(`${this.dataDir}/ledgers`, { recursive: true });
    const L = this.ledgers(height, win, r, outputs); this.currentLedgers = L;
    for (const [name, l] of Object.entries(L)) await writeFile(`${this.dataDir}/ledgers/${name}.json`, JSON.stringify(l, null, 1));
    await writeFile(`${this.dataDir}/ledgers/split-${height}.json`, JSON.stringify(L.split, null, 1));
  }
  async writeLedger(name) { const L = this.ledgers(this.tip?.height ?? 0, null, null, []); await writeFile(`${this.dataDir}/ledgers/${name}.json`, JSON.stringify(L[name], null, 1)); }

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
  // pages are read per request: small files, and an edit shows without a restart
  const page = async (rel) => { const u = new URL(rel, import.meta.url); return existsSync(u) ? await readFile(u, 'utf8') : `<p>no ${rel}</p>`; };
  return async (path) => {
    if (path === '/' || path === '') return [200, 'text/html; charset=utf-8', await page('./status.html')];
    if (path === '/audit' || path === '/audit/') return [200, 'text/html; charset=utf-8', await page('../audit/index.html')];
    if (path === '/gateway/lib/split.mjs') return [200, 'text/javascript; charset=utf-8', await readFile(new URL('../gateway/lib/split.mjs', import.meta.url), 'utf8')];
    if (path === '/stats.json') return json(co.snapshot());
    if (path === '/pool.json') return json(co.descriptor);
    let m;
    if ((m = /^\/snapshots\/(\d+)\.json$/.exec(path))) return file(`${co.dataDir}/snapshots/${m[1]}.json`);
    if (path === '/ledgers' || path === '/ledgers/') return json({ '@context': DATSTR_CTX, type: 'datstr:Ledgers', coordinator: didOf(co.pubkey), chain: co.chain, ledgers: ['window', 'split', 'owed', 'paid'].map((n) => `ledgers/${n}.json`) });
    if ((m = /^\/ledgers\/([a-z]+(?:-\d+)?)\.json$/.exec(path))) return file(`${co.dataDir}/ledgers/${m[1]}.json`);
    if ((m = /^\/blocks\/([0-9a-f]{64})\.json$/.exec(path))) return file(`${co.dataDir}/blocks/${m[1]}.json`);
    if ((m = /^\/shares\/([0-9a-f]{64})\.json$/.exec(path))) return file(`${co.dataDir}/shares/${m[1]}.json`);
    if (path === '/shares.jsonl') return existsSync(`${co.dataDir}/shares.jsonl`) ? [200, 'application/x-ndjson', await readFile(`${co.dataDir}/shares.jsonl`, 'utf8')] : [200, 'application/x-ndjson', ''];
    if (path === '/delegations.jsonl') return existsSync(`${co.dataDir}/delegations.jsonl`) ? [200, 'application/x-ndjson', await readFile(`${co.dataDir}/delegations.jsonl`, 'utf8')] : [200, 'application/x-ndjson', ''];
    if (path === '/masters.jsonl') return existsSync(`${co.dataDir}/masters.jsonl`) ? [200, 'application/x-ndjson', await readFile(`${co.dataDir}/masters.jsonl`, 'utf8')] : [200, 'application/x-ndjson', ''];
    if (path === '/assignments.jsonl') return existsSync(`${co.dataDir}/assignments.jsonl`) ? [200, 'application/x-ndjson', await readFile(`${co.dataDir}/assignments.jsonl`, 'utf8')] : [200, 'application/x-ndjson', ''];
    if (path === '/receipts.jsonl') return existsSync(`${co.dataDir}/receipts.jsonl`) ? [200, 'application/x-ndjson', await readFile(`${co.dataDir}/receipts.jsonl`, 'utf8')] : [200, 'application/x-ndjson', ''];
    return safe(path) ? [404, 'text/plain', 'not found'] : [404, 'text/plain', 'not found'];
  };
}
