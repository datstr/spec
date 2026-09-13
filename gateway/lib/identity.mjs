// Who a stratum client mines as (SPEC.md sections 4 and 7).
//   gateway   the gateway's own worker and master: any client whose username is not an address
//   address   a client whose username is a payable address: a worker key derived from the gateway
//             key and the address, its own master, paid at that address (the "public gateway")
//   delegated a client that brought a miner descriptor and a delegation from its Nostr master to
//             the worker key the gateway derives for that master (xlogin on the miner page)
// Derived keys are never stored: taggedHash("datstr/worker", gatewayKey ‖ label), so a restart
// derives the same worker for the same address or master.
import { signEvent, verifyEvent, pubkeyOf, content as contentOf } from './nostr.mjs';

export function deriveWorker(hash, gatewayKeyHex, label) {
  const key = hash.bytesToHex(hash.taggedHash('datstr/worker', new Uint8Array([...hash.hexToBytes(gatewayKeyHex), ...new TextEncoder().encode(label)])));
  return { key, pubkey: pubkeyOf(key) };
}

export function addressIdentity({ hash, gatewayKey, chain, address, payout }) {
  const w = deriveWorker(hash, gatewayKey, `addr:${chain}:${address}`);
  const descriptor = signEvent(w.key, { kind: 33401, tags: [['d', w.pubkey], ['chain', chain]], content: { chain, payout: { [chain]: payout } } });
  return { mode: 'address', key: w.key, pubkey: w.pubkey, master: w.pubkey, payout, address, descriptor, delegation: null };
}

// The worker a master would delegate to on this gateway: what the miner page asks for before signing.
export function workerForMaster({ hash, gatewayKey, chain, master }) { return deriveWorker(hash, gatewayKey, `master:${chain}:${master}`); }

export function delegatedIdentity({ hash, gatewayKey, chain, descriptor, delegation }) {
  if (!descriptor || descriptor.kind !== 33401 || !verifyEvent(descriptor)) throw new Error('descriptor must be a signed kind 33401 event');
  if (!delegation || delegation.kind !== 33402 || !verifyEvent(delegation)) throw new Error('delegation must be a signed kind 33402 event');
  if (delegation.pubkey !== descriptor.pubkey) throw new Error('descriptor and delegation must be signed by the same master');
  const master = descriptor.pubkey;
  const payout = (contentOf(descriptor)?.payout?.[chain] ?? '').toLowerCase();
  if (!/^[0-9a-f]{4,}$/.test(payout)) throw new Error(`descriptor has no payout script for ${chain}`);
  const w = workerForMaster({ hash, gatewayKey, chain, master });
  const dc = contentOf(delegation);
  if ((dc?.worker ?? '').toLowerCase() !== w.pubkey) throw new Error(`delegation names worker ${(dc?.worker ?? '').slice(0, 16)}…, this gateway derives ${w.pubkey.slice(0, 16)}… for that master`);
  if (!dc?.chains?.[chain]) throw new Error(`delegation does not cover ${chain}`);
  return { mode: 'delegated', key: w.key, pubkey: w.pubkey, master, payout, address: null, descriptor, delegation, expires: dc.chains[chain].expires ?? null };
}
