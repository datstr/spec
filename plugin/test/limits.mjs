// The coordinator's socket hygiene, with fake connections and a fake node. No network.
//   node plugin/test/limits.mjs
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Coordinator } from '../coordinator.mjs';
import { loadEngine } from '../../gateway/lib/engine.mjs';
import { randomKey } from '../../gateway/lib/nostr.mjs';

const { k, pow, hash } = await loadEngine({ network: 'btc:regtest-blake2b', activationHeight: 1 });
const rpc = async (m) => m === 'getblocktemplate' ? { height: 2, previousblockhash: '00'.repeat(32), target: '7fffff' + '00'.repeat(29), coinbasevalue: 5000000000, bits: '207fffff', transactions: [] } : null;
const dir = await mkdtemp(`${tmpdir()}/datstr-limits-`);
const log = () => {};
const co = new Coordinator({ k, pow, hash, rpc, key: randomKey(), params: { chain: 'btc:regtest-blake2b', maxConnections: 3, maxPerAddress: 2, maxMessageBytes: 200, maxMessagesPerSecond: 5, helloTimeoutMs: 100 }, dataDir: dir, log });
await co.start();
const fake = (remote) => { const c = { remote, sent: [], closed: false, send: (s) => c.sent.push(JSON.parse(s)), close: () => { c.closed = true; c._close?.(); }, onMessage: (cb) => { c._msg = cb; }, onClose: (cb) => { c._close = cb; } }; return c; };
const say = (c, o) => c._msg(typeof o === 'string' ? o : JSON.stringify(o));
let pass = 0, fail = 0; const t = (name, ok) => { (ok ? pass++ : fail++); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); };

const a1 = fake('10.0.0.1:1'), a2 = fake('10.0.0.1:2'), a3 = fake('10.0.0.1:3');
co.connect(a1); co.connect(a2); co.connect(a3);
t('third socket from one address refused', a3.closed && a3.sent[0]?.error?.includes('too many connections from'));
const b1 = fake('10.0.0.2:1'), b2 = fake('10.0.0.3:1');
co.connect(b1); co.connect(b2);
t('connection cap refuses the fourth in all', b2.closed && b2.sent[0]?.error?.includes('too many connections ('));
await say(a1, { type: 'share', event: {} });
t('share before hello is answered "hello first"', a1.sent.at(-1)?.error === 'hello first');
await say(a1, 'x'.repeat(300));
t('oversized message drops the socket', a1.closed && a1.sent.at(-1)?.error?.includes('over the'));
for (let i = 0; i < 12; i++) await say(a2, { type: 'nothing' });
t('message flood drops the socket', a2.closed && a2.sent.at(-1)?.error?.includes('messages a second'));
await new Promise((r) => setTimeout(r, 150));
t('no hello within the timeout drops the socket', b1.closed && b1.sent.at(-1)?.error === 'no hello');
t('stats count refusals and drops', co.stats.refusedConnections === 2 && co.stats.droppedConnections === 3);
co.stop(); await rm(dir, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
