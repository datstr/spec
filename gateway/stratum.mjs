// Stratum v1 server, Siacoin dialect, for BLAKE2b (v2 header) hardware and ratum's sia-test-miner.
//
// What the miner sees (SPEC.md section 7): an 8-byte extranonce1 and extranonce2_size 8, which
// together fill the header's 16-byte extranonce; a notify with a 35-byte coinb1 (three zero
// bytes and H2), an empty coinb2, no branches, the hidden prevblock and an 8-byte ntime field;
// a submit with extranonce2, the ntime field and an 8-byte nonce field. The two 8-byte fields
// are pairs of little-endian u32: nonce = (nonce, nonce2), ntime = (timeOffset, nonce3).
import net from 'node:net';

export class StratumServer {
  constructor({ onShare, difficulty = 1, log = console.log }) {
    this.onShare = onShare; this.difficulty = difficulty; this.log = log;
    this.clients = new Set(); this.job = null; this.jobs = new Map(); this.sid = 0;
    this.server = net.createServer((sock) => this.accept(sock));
  }
  listen(port, host = '0.0.0.0') { return new Promise((res) => this.server.listen(port, host, () => res(this.server.address().port))); }
  close() { for (const c of this.clients) c.sock.destroy(); this.server.close(); }

  // A job: what every connection is told to mine. Kept by id for submits that arrive after
  // a newer one; the caller decides how many to keep alive by calling retire().
  publish(job, clean) {
    this.job = job; this.jobs.set(job.id, job);
    for (const c of this.clients) if (c.subscribed) this.notify(c, job, clean);
  }
  retire(keep = 8) { const ids = [...this.jobs.keys()]; while (ids.length > keep) this.jobs.delete(ids.shift()); }

  accept(sock) {
    const c = { sock, buf: '', subscribed: false, user: null, en1: null, remote: `${sock.remoteAddress}:${sock.remotePort}` };
    this.clients.add(c);
    sock.setNoDelay(true);
    sock.on('data', (d) => { c.buf += d; let i; while ((i = c.buf.indexOf('\n')) >= 0) { const line = c.buf.slice(0, i); c.buf = c.buf.slice(i + 1); if (line.trim()) this.handle(c, line); } });
    sock.on('error', () => {}); sock.on('close', () => { this.clients.delete(c); this.log(`stratum: ${c.remote} closed`); });
    this.log(`stratum: ${c.remote} connected`);
  }
  send(c, obj) { if (!c.sock.destroyed) c.sock.write(JSON.stringify(obj) + '\n'); }
  reply(c, id, result) { this.send(c, { id, result, error: null }); }
  refuse(c, id, code, msg) { this.send(c, { id, result: null, error: [code, msg, null] }); }

  notify(c, job, clean) {
    this.send(c, { id: null, method: 'mining.notify', params: [job.id, job.prevHidden, job.coinb1, '', [], '', job.bits, job.ntimeField, !!clean] });
  }
  setDifficulty(c) { this.send(c, { id: null, method: 'mining.set_difficulty', params: [this.difficulty] }); }

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
      case 'mining.authorize': { c.user = String(params[0] ?? ''); this.reply(c, id, true); this.log(`stratum: ${c.remote} authorized ${c.user}`); return; }
      case 'mining.configure': return this.reply(c, id, {});
      case 'mining.extranonce.subscribe': return this.reply(c, id, true);
      case 'mining.submit': {
        const [user, jobId, en2, ntime, nonce] = params.map((p) => String(p ?? ''));
        const job = this.jobs.get(jobId);
        if (!job) return this.refuse(c, id, 21, 'job not found');
        if (!/^[0-9a-f]{16}$/i.test(en2) || !/^[0-9a-f]{16}$/i.test(ntime) || !/^[0-9a-f]{16}$/i.test(nonce)) return this.refuse(c, id, 20, 'bad field size');
        const le = (h, at) => parseInt(h.slice(at, at + 8).match(/../g).reverse().join(''), 16);
        const fields = { extranonce: (c.en1 + en2).toLowerCase(), nonce: le(nonce, 0), nonce2: le(nonce, 8), timeOffset: le(ntime, 0), nonce3: le(ntime, 8) };
        try {
          const r = await this.onShare({ job, fields, user: user || c.user, client: c });
          if (r.ok) this.reply(c, id, true); else this.refuse(c, id, r.code ?? 23, r.reason);
        } catch (e) { this.log(`stratum: share error ${e.message}`); this.refuse(c, id, 20, 'internal'); }
        return;
      }
      default: return this.refuse(c, id, 20, `unknown method ${method}`);
    }
  }
}
