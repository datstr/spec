// SPEC 6.3: a node with a mempool publishes the transactions it would relay, one event per
// transaction, kind 23404, content the transaction hex, tag `chain` the chain id. A web node
// subscribes and validates each against its own UTXO set; nothing about ordering, fees or the
// coinbase travels. This is the gateway's side: poll the node's mempool, publish what is new.
import { signEvent } from './nostr.mjs';

export const MEMPOOL_KIND = 23404;

// publish({ rpc, relays, key, network, log, every }) → { tick, close, seen }
export function mempoolPublisher({ rpc, relays, key, network, log = () => {}, every = 5000, maxPerTick = 50 }) {
  const seen = new Map(); // txid -> first seen (ms); pruned when the node drops the tx
  const sockets = new Map(); let closed = false;
  const connect = (url, backoff = 1000) => {
    if (closed) return;
    let ws; try { ws = new WebSocket(url); } catch (e) { return setTimeout(() => connect(url, Math.min(backoff * 2, 60000)), backoff); }
    sockets.set(url, { ws, open: false });
    ws.onopen = () => { sockets.get(url).open = true; backoff = 1000; };
    ws.onmessage = () => {}; ws.onerror = () => {};
    ws.onclose = () => { sockets.delete(url); if (!closed) setTimeout(() => connect(url, Math.min(backoff * 2, 60000)), backoff); };
  };
  for (const url of relays) connect(url);
  const send = (ev) => { let n = 0; const msg = JSON.stringify(['EVENT', ev]); for (const { ws, open } of sockets.values()) { if (!open) continue; try { ws.send(msg); n++; } catch {} } return n; };
  let ticking = false, published = 0;
  async function tick() {
    if (ticking || closed) return; ticking = true;
    try {
      const ids = await rpc('getrawmempool'); const now = Date.now(); const live = new Set(ids);
      for (const id of seen.keys()) if (!live.has(id)) seen.delete(id);
      let n = 0;
      for (const id of ids) {
        if (seen.has(id)) continue; if (n >= maxPerTick) break;
        let hex; try { hex = await rpc('getrawtransaction', id); } catch { continue; } // gone between the two calls
        const ev = signEvent(key, { kind: MEMPOOL_KIND, tags: [['chain', network]], content: hex });
        const reached = send(ev); if (reached === 0) { log(`mempool: no relay open; ${id.slice(0, 12)}… will be tried again`); break; } // not seen: retried next tick
        seen.set(id, now); n++; published++;
      }
      if (n) log(`mempool: published ${n} transaction(s) to the relays (${ids.length} in the node's mempool)`);
    } catch (e) { log(`mempool: ${e.message}`); } finally { ticking = false; }
  }
  const timer = setInterval(tick, every); tick();
  return { tick, seen, get published() { return published; }, close() { closed = true; clearInterval(timer); for (const { ws } of sockets.values()) { try { ws.close(); } catch {} } } };
}
