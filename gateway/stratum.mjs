// Stratum v1 server, Siacoin dialect, for BLAKE2b (v2 header) hardware and ratum's sia-test-miner.
//
// What the miner sees (SPEC.md section 7): an 8-byte extranonce1 and extranonce2_size 8, which
// together fill the header's 16-byte extranonce; a notify with a 35-byte coinb1 (three zero
// bytes and H2), an empty coinb2, no branches, the hidden prevblock and an 8-byte ntime field;
// a submit with extranonce2, the ntime field and an 8-byte nonce field. The two 8-byte fields
// are pairs of little-endian u32: nonce = (nonce, nonce2), ntime = (timeOffset, nonce3).
import net from 'node:net';
import { targetForDifficulty } from './lib/target.mjs';

// Difficulty per connection: every miner starts at `difficulty`, then vardiff moves it so a
// share arrives about every `targetSeconds`, within [min, max]. A miner can pin its own with
// `d=<n>` in the password or after a comma in the username, or ask with
// mining.suggest_difficulty. The difficulty a share is judged at is the one its job was sent
// at: a change re-sends the current job under a new id, so ids pin difficulties.
export class StratumServer {
  constructor({ onShare, onAuthorize = null, onMethod = null, difficulty = 1, vardiff = null, log = console.log, maxClients = 1024, maxLineBytes = 16384, maxPerAddress = 64, idleSeconds = 1800, rawLog = false }) {
    this.onShare = onShare; this.onAuthorize = onAuthorize; this.onMethod = onMethod; this.difficulty = difficulty; this.log = log;
    this.maxClients = maxClients; this.maxLineBytes = maxLineBytes; this.maxPerAddress = maxPerAddress; this.refused = 0;
    // a rig spreads its hash over several sockets, so any one of them can be legitimately quiet for
    // minutes. Only a much longer silence means a dead peer behind a proxy.
    this.idleSeconds = idleSeconds; this.rawLog = rawLog;
    this.vardiff = vardiff && { targetSeconds: 10, min: 0.0001, max: 1e6, window: 60, ...vardiff };
    this.clients = new Set(); this.job = null; this.jobs = new Map(); this.sid = 0; this.clone = 0;
    this.server = net.createServer((sock) => this.accept(sock));
    if (this.vardiff) this.timer = setInterval(() => { for (const c of this.clients) if (c.subscribed) this.retarget(c); }, 5000);
    // a subscribed client that has sent nothing for idleSeconds is hung or behind a dead proxy: hang up so it reconnects
    this.idleTimer = setInterval(() => { const now = Date.now(), ms = (this.idleSeconds ?? 1800) * 1000;
      for (const c of this.clients) if (c.subscribed && now - (c.lastSeen ?? now) > ms) { this.log(`stratum: ${c.remote} dropped: silent for ${Math.round((now - c.lastSeen) / 1000)} s`); try { c.sock.destroy(); } catch {} } }, 15000);
  }
  oneSharePerJob(c) { return /^sia-test-miner/.test(c.agent ?? ''); }
  // A CPU miner cannot solve a real-difficulty block and, mining one share per job, sits idle
  // with no job in hand. While holdCpu is set (the chain is outside its minimum-difficulty
  // window) such clients get no job at all and go quiet; an ASIC, which can solve the real
  // block and which a marketplace counts as offline if starved, is never held.
  heldCpu(c) { return this.holdCpu && this.oneSharePerJob(c); }
  // The same job under a new id, with the header's spare nonce3 (the high half of the ntime field)
  // set to the clone number, so a miner that restarts its search from zero finds a new nonce.
  cloneJob(job) { const n = ++this.clone; const c = { ...job, id: `${job.id}${(n & 0xffff).toString(16).padStart(4, '0')}`, ntimeField: '00000000' + [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].map((b) => b.toString(16).padStart(2, '0')).join('') }; this.jobs.set(c.id, c); return c; }
  targetFor(d) { this.targets ??= new Map(); if (!this.targets.has(d)) { if (this.targets.size > 64) this.targets.clear(); this.targets.set(d, targetForDifficulty(d)); } return this.targets.get(d); }
  listen(port, host = '0.0.0.0') { return new Promise((res) => this.server.listen(port, host, () => res(this.server.address().port))); }
  close() { clearInterval(this.timer); for (const c of this.clients) c.sock.destroy(); this.server.close(); }

  // A job: what every connection is told to mine. Kept by id for submits that arrive after
  // a newer one; the caller decides how many to keep alive by calling retire().
  publish(job, clean) {
    this.job = job; this.jobs.set(job.id, job);
    for (const c of this.clients) if (c.subscribed) this.notify(c, job, clean);
  }
  retire(keep = 64) { const ids = [...this.jobs.keys()]; while (ids.length > keep) this.jobs.delete(ids.shift()); }

  accept(sock) {
    const addr = sock.remoteAddress ?? '';
    const same = [...this.clients].filter((x) => x.sock.remoteAddress === addr).length;
    if (this.clients.size >= this.maxClients || same >= this.maxPerAddress) { this.refused++; this.log(`stratum: ${addr} refused: ${this.clients.size >= this.maxClients ? 'max clients' : 'max per address'}`); return sock.destroy(); }
    const c = { sock, buf: '', subscribed: false, user: null, en1: null, remote: `${sock.remoteAddress}:${sock.remotePort}`, diff: this.difficulty, fixedDiff: null, jobDiff: new Map(), since: Date.now(), sharesSince: 0, lastRetarget: Date.now() };
    this.clients.add(c);
    sock.setNoDelay?.(true); sock.setKeepAlive?.(true, 30000); // a dead peer behind a proxy must not look alive forever; a socket wrapped over WebSocket may lack these
    c.lastSeen = Date.now();
    sock.on('data', (d) => {
      c.lastSeen = Date.now();
      c.buf += d;
      // split into lines first: an ASIC's burst of submits can be many lines in one read; only an unterminated line has a size cap
      let i; while ((i = c.buf.indexOf('\n')) >= 0) { const line = c.buf.slice(0, i); c.buf = c.buf.slice(i + 1); if (this.rawLog) this.log(`RAW IN  ${c.remote}: ${line.slice(0, 300)}`); if (line.length > this.maxLineBytes) { this.log(`stratum: ${c.remote} dropped: line over ${this.maxLineBytes} bytes`); return sock.destroy(); } if (line.trim()) this.handle(c, line); }
      if (c.buf.length > this.maxLineBytes) { this.log(`stratum: ${c.remote} dropped: line over ${this.maxLineBytes} bytes`); return sock.destroy(); }
    });
    sock.on('error', () => {}); sock.on('close', () => { this.clients.delete(c); this.log(`stratum: ${c.remote} closed`); });
    this.log(`stratum: ${c.remote} connected`);
  }
  send(c, obj) { if (this.rawLog) this.log(`RAW OUT ${c.remote}: ${JSON.stringify(obj).slice(0, 300)}`); if (!c.sock.destroyed) c.sock.write(JSON.stringify(obj) + '\n'); }
  reply(c, id, result) { this.send(c, { id, result, error: null }); }
  refuse(c, id, code, msg) { this.send(c, { id, result: null, error: [code, msg, null] }); }

  // A job may differ per client (its coinbase commits to the client's identity): job.variant(c) says how.
  notify(c, job, clean) {
    if (this.heldCpu(c)) { c.held = true; return; }
    c.held = false; c.jobDiff.set(job.id, c.diff); if (c.jobDiff.size > 128) c.jobDiff.delete(c.jobDiff.keys().next().value); // must outlast the retained jobs, or an old job's share is judged at the wrong difficulty
    const v = job.variant ? job.variant(c) : job;
    this.send(c, { id: null, method: 'mining.notify', params: [job.id, v.prevHidden, v.coinb1, '', [], '', v.bits, job.ntimeField ?? v.ntimeField, !!clean] });
  }
  // The current job again for one client, under a new id: after its identity changed, its coinbase did too.
  renotify(c, clean = true) { if (this.job && c.subscribed) this.notify(c, this.cloneJob(this.job), clean); }
  setDifficulty(c) { this.send(c, { id: null, method: 'mining.set_difficulty', params: [c.diff] }); }
  // never above the network difficulty of the current job: a connection that hard would not submit the hash that is a block
  clamp(d) { const v = this.vardiff ?? { min: 1e-6, max: 1e9 }; return Math.max(v.min, Math.min(this.job?.netDiff ?? Infinity, v.max, Number(d) || this.difficulty)); } // the floor wins over the network cap: on regtest a block takes next to nothing
  // A new difficulty takes effect through a re-sent job under a fresh id, so shares for the old id are still judged at the old difficulty.
  setDiff(c, d, why) {
    d = Number(d.toPrecision(3)); if (d === c.diff) return;
    const from = c.diff; c.diff = d; this.setDifficulty(c);
    // clean: the miner must abandon work on jobs issued at the old target, or it keeps mining them
    // and every such share is judged at the old difficulty. cloneJob bumps ntime so it is not deduped.
    if (this.job && c.subscribed) this.notify(c, this.cloneJob(this.job), true);
    this.log(`stratum: ${c.remote} difficulty ${from} → ${d} (${why})`);
    c.sharesSince = 0; c.lastRetarget = Date.now();
  }
  // While the gateway serves no work (holding), the clock stops: no shares are expected.
  pause(on) { if (on === this.paused) return; this.paused = on; const now = Date.now(); for (const c of this.clients) { c.lastRetarget = now; c.sharesSince = 0; } }
  // an ASIC on a CPU-sized target submits thousands of shares a second: raise it at once, above any assignment
  floodGuard(c) {
    const now = Date.now(); c.flood ??= { t: now, n: 0, until: 0 };
    if (now - c.flood.t >= 1000) { c.flood.t = now; c.flood.n = 0; }
    if (++c.flood.n > 300 && now >= c.flood.until) { c.flood.n = 0; c.flood.until = now + 10_000; this.setDiff(c, this.clamp(c.diff * 16), 'flood: over 300 shares a second'); } // then let the backlog drain before judging again; the next assignment takes over.
    // fixedDiff is left alone: clearing it re-enabled the local vardiff, which could then hold a pooled connection above its assignment, and pooled shares are weighed at the assignment -- a k-fold under-credit until the next one arrived
  }
  retarget(c) {
    const v = this.vardiff; if (!v || c.fixedDiff || this.paused) return;
    const now = Date.now(), elapsed = (now - c.lastRetarget) / 1000;
    if (c.sharesSince < 8 && elapsed < v.window) return;
    if (elapsed < 2) return; // a burst of queued submits is not a rate
    const perShare = elapsed / Math.max(c.sharesSince, 0.5);
    let d = c.diff * v.targetSeconds / perShare;
    d = Math.min(c.diff * 4, Math.max(c.diff / 4, d)); d = Math.max(this.clamp(d), c.floorDiff ?? 0); // never below the pool's assignment
    if (d / c.diff > 1.4 || d / c.diff < 0.7) this.setDiff(c, d, `${c.sharesSince} shares in ${elapsed.toFixed(0)} s`);
    else { c.sharesSince = 0; c.lastRetarget = now; }
  }
  parseFixed(user, pass) {
    const m = /(?:^|[,;\s])d=([0-9.eE+-]+)/.exec(String(pass ?? '')) ?? /,d=([0-9.eE+-]+)/.exec(String(user ?? ''));
    return m ? this.clamp(Number(m[1])) : null;
  }

  async handle(c, line) {
    let m; try { m = JSON.parse(line); } catch { return this.refuse(c, null, 20, 'bad json'); }
    const { id, method, params = [] } = m;
    switch (method) {
      case 'mining.subscribe': {
        this.sid = (this.sid + 1) >>> 0;
        c.en1 = '00000000' + this.sid.toString(16).padStart(8, '0'); // 4 zero bytes then the session id, as ratum lays it out
        c.agent = params[0] ?? ''; c.subscribed = true;
        this.reply(c, id, [[['mining.notify', c.en1 + '1'], ['mining.set_difficulty', c.en1 + '2']], c.en1, 8]);
        this.setDifficulty(c);
        if (this.job) this.notify(c, this.job, true);
        this.log(`stratum: ${c.remote} subscribed (${c.agent}) extranonce1 ${c.en1}`);
        return;
      }
      case 'mining.authorize': {
        c.user = String(params[0] ?? '').replace(/,d=[^,]*/, '');
        try { await this.onAuthorize?.(c, c.user, String(params[1] ?? '')); } catch (e) { this.log(`stratum: ${c.remote} authorize ${c.user}: ${e.message}`); return this.refuse(c, id, 24, e.message); }
        this.reply(c, id, true); this.log(`stratum: ${c.remote} authorized ${c.user}${c.identity ? ` as ${c.identity.mode} master ${c.identity.master.slice(0, 12)}…` : ''}`);
        const fixed = this.parseFixed(params[0], params[1]); if (fixed) { c.fixedDiff = fixed; this.setDiff(c, fixed, 'fixed by the miner'); }
        else if (c.identity && this.job) this.renotify(c, true);
        return;
      }
      case 'mining.suggest_difficulty': { const d = this.clamp(Number(params[0])); if (d > 0) { c.fixedDiff = d; this.setDiff(c, d, 'suggested by the miner'); } return this.reply(c, id, true); }
      case 'mining.configure': return this.reply(c, id, {});
      case 'mining.extranonce.subscribe': return this.reply(c, id, true);
      case 'mining.submit': {
        const [user, jobId, en2, ntime, nonce] = params.map((p) => String(p ?? ''));
        const job = this.jobs.get(jobId);
        if (!job) { c.notFound = (c.notFound ?? 0) + 1; this.stale = (this.stale ?? 0) + 1;
          if (c.notFound <= 3 || c.notFound % 100 === 0) this.log(`stratum: ${c.remote} job ${jobId} not found (${c.notFound} for this client; a marketplace counts these as rejects)`);
          return this.refuse(c, id, 21, 'job not found'); }
        if (!/^[0-9a-f]{16}$/i.test(en2) || !/^[0-9a-f]{16}$/i.test(ntime) || !/^[0-9a-f]{16}$/i.test(nonce)) return this.refuse(c, id, 20, 'bad field size');
        const le = (h, at) => parseInt(h.slice(at, at + 8).match(/../g).reverse().join(''), 16);
        const fields = { extranonce: (c.en1 + en2).toLowerCase(), nonce: le(nonce, 0), nonce2: le(nonce, 8), timeOffset: le(ntime, 0), nonce3: le(ntime, 8) };
        const diff = c.jobDiff.get(jobId) ?? c.diff, target = this.targetFor(diff);
        try {
          const r = await this.onShare({ job, fields, user: c.user || user, client: c, diff, target });
          if (r.ok) {
            this.reply(c, id, true); c.sharesSince++; this.floodGuard(c); this.retarget(c);
            // a miner that mines one share per job and then waits (ratum's sia-test-miner) gets the same job again under a new id
            if (this.oneSharePerJob(c) && this.job && !c.sock.destroyed) this.notify(c, this.cloneJob(this.job), false);
          } else this.refuse(c, id, r.code ?? 23, r.reason);
        } catch (e) { this.log(`stratum: share error ${e.message}`); this.refuse(c, id, 20, 'internal'); }
        return;
      }
      default: {
        if (this.onMethod) { try { const r = await this.onMethod(c, method, params); if (r !== undefined) return this.reply(c, id, r); } catch (e) { return this.refuse(c, id, 20, e.message); } }
        return this.refuse(c, id, 20, `unknown method ${method}`);
      }
    }
  }
}
