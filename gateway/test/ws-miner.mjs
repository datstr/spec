// A Node stand-in for the browser miner: the same core over the gateway's /stratum WebSocket.
//   node gateway/test/ws-miner.mjs ws://127.0.0.1:3334/stratum <user> [difficulty] [sharesWanted]
import { SCHEMA } from '../lib/engine.mjs';
import { workHeader, mine, nonceField, parseNotify, targetForDifficulty, bytesToHex } from '../miner-core.mjs';
const { blake2b } = await import(`${SCHEMA}/codec/pow/blake2b.js`);
const [url, user, diffArg, wantArg] = process.argv.slice(2);
const want = Number(wantArg ?? 1);
const ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
let en1, job, en2, target, accepted = 0, nextId = 100, hashes = 0, t0 = Date.now(), mining = false;
const send = (o) => ws.send(JSON.stringify(o) + '\n');
ws.onopen = () => { send({ id: '1', method: 'mining.subscribe', params: ['ws-miner-test'] }); send({ id: '2', method: 'mining.authorize', params: [user, diffArg ? 'd=' + diffArg : 'x'] }); };
ws.onmessage = (e) => { for (const line of new TextDecoder().decode(e.data).split('\n')) if (line.trim()) onLine(JSON.parse(line)); };
function onLine(m) {
  if (m.id === '1') { en1 = m.result[1]; console.log('subscribed', en1); }
  else if (m.id === '2') console.log('authorized', m.result);
  else if (m.method === 'mining.set_difficulty') { target = targetForDifficulty(m.params[0]); console.log('difficulty', m.params[0]); }
  else if (m.method === 'mining.notify') { job = parseNotify(m.params); console.log('job', job.id); if (!mining) run(); }
  else if (m.result === true) { accepted++; console.log(`share accepted (${accepted}/${want}) after ${hashes} hashes, ${Math.round(hashes / ((Date.now() - t0) / 1000) / 1000)} kH/s`); if (accepted >= want) { ws.close(); process.exit(0); } }
  else if (m.error) { console.log('share rejected', JSON.stringify(m.error)); }
}
async function run() {
  mining = true;
  while (true) {
    if (!job || !en1 || !target) { await new Promise((r) => setTimeout(r, 50)); continue; }
    const my = job; en2 = bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
    const header = workHeader(blake2b, my, en1 + en2); let n = 0;
    while (job === my) {
      const r = mine(blake2b, header, target, n, 1, 20000); hashes += r.hashes; n = (n + r.hashes) >>> 0;
      if (r.nonce !== null) { send({ id: String(nextId++), method: 'mining.submit', params: [user, my.id, en2, my.ntime, nonceField(r.nonce)] }); n = (r.nonce + 1) >>> 0; }
      await new Promise((r) => setImmediate(r));
    }
  }
}
setTimeout(() => { console.log('timeout without enough shares'); process.exit(1); }, 180000);
