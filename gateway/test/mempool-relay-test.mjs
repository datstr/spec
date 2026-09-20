// The mempool publisher (SPEC 6.3) against a fake node and a local relay: every new mempool
// transaction goes out once as a kind 23404 event with the chain tag and the hex; a transaction the
// node drops is forgotten so a later reappearance is published again; events verify.
//   node test/mempool-relay-test.mjs
import { createServer } from 'node:http';
import { mempoolPublisher, MEMPOOL_KIND } from '../lib/mempool-relay.mjs';
import { randomKey, pubkeyOf, verifyEvent } from '../lib/nostr.mjs';
import { homedir } from 'node:os';
const SCHEMA = process.env.SCHEMA ?? `${homedir()}/bitcoin-desktop/schema`; const { attachWsServer } = await import(`${SCHEMA}/codec/ws.js`);
let ok = 0, bad = 0; const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
// a relay that records what it is sent
const got = []; const server = createServer();
attachWsServer(server, (client) => { client.onMessage((b) => { const m = JSON.parse(new TextDecoder().decode(b)); if (m[0] === 'EVENT') { got.push(m[1]); client.send(new TextEncoder().encode(JSON.stringify(['OK', m[1].id, true, '']))); } }); });
await new Promise((r) => server.listen(0, '127.0.0.1', r)); const url = `ws://127.0.0.1:${server.address().port}`;
// a fake node: a mempool we control
let pool = { aa: '0100aa', bb: '0100bb' }; const rpc = async (m, a) => { if (m === 'getrawmempool') return Object.keys(pool); if (m === 'getrawtransaction') { if (!(a in pool)) throw new Error('No such mempool transaction'); return pool[a]; } throw new Error(m); };
const key = randomKey(); const pub = mempoolPublisher({ rpc, relays: [url], key, network: 'btc:regtest-blake2b', every: 60000 });
await new Promise((r) => setTimeout(r, 300)); await pub.tick(); await new Promise((r) => setTimeout(r, 200));
t('two mempool transactions are published, one event each', got.length === 2 && new Set(got.map((e) => e.content)).size === 2);
t('kind 23404, chain tag, hex content, signed by the gateway key, verifies', got.every((e) => e.kind === MEMPOOL_KIND && e.tags.some((x) => x[0] === 'chain' && x[1] === 'btc:regtest-blake2b') && /^[0-9a-f]+$/.test(e.content) && e.pubkey === pubkeyOf(key) && verifyEvent(e)));
await pub.tick(); await new Promise((r) => setTimeout(r, 200)); t('a second tick publishes nothing new', got.length === 2);
pool = { bb: '0100bb', cc: '0100cc' }; await pub.tick(); await new Promise((r) => setTimeout(r, 200)); t('a new transaction is published; a dropped one is forgotten', got.length === 3 && got[2].content === '0100cc' && !pub.seen.has('aa'));
pool = { aa: '0100aa', cc: '0100cc' }; await pub.tick(); await new Promise((r) => setTimeout(r, 200)); t('a transaction that comes back after being dropped is published again', got.length === 4 && got[3].content === '0100aa');
t('published counter', pub.published === 4);
pub.close(); server.close(); console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
