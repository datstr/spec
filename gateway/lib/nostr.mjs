// Nostr events: BIP-340 signing on top of the engine's verify-only secp256k1 (it exports the
// public-key derivation, which is all a Schnorr signature needs besides hashing), NIP-01 ids,
// and verification through the engine.
import { SCHEMA } from './engine.mjs';
const { publicKeyFromPrivate, verifySchnorr, N } = await import(`${SCHEMA}/codec/secp256k1.js`);
const { sha256, taggedHash, hexToBytes, bytesToHex } = await import(`${SCHEMA}/codec/hash.js`);
const { verifyNostrEvent } = await import(`${SCHEMA}/codec/nostr.js`);

const big = (b) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
const bytes32 = (n) => { const out = new Uint8Array(32); for (let i = 31; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; } return out; };
const cat = (...a) => { const out = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { out.set(x, p); p += x.length; } return out; };

export function randomKey() { const k = new Uint8Array(32); crypto.getRandomValues(k); return bytesToHex(k); }
export function pubkeyOf(privHex) { return bytesToHex(publicKeyFromPrivate(hexToBytes(privHex)).slice(1)); }

// BIP-340: sig = R.x || (k + e·d) mod n, with d and k negated when their points have odd y.
export function schnorrSign(msg32, privHex, aux = crypto.getRandomValues(new Uint8Array(32))) {
  let d = big(hexToBytes(privHex));
  const P = publicKeyFromPrivate(bytes32(d)); if (!P) throw new Error('bad private key');
  if (P[0] === 0x03) d = N - d;
  const px = P.slice(1);
  const t = bytes32(d ^ big(taggedHash('BIP0340/aux', aux)));
  let k = big(taggedHash('BIP0340/nonce', cat(t, px, msg32))) % N; if (k === 0n) throw new Error('zero nonce');
  const R = publicKeyFromPrivate(bytes32(k)); if (R[0] === 0x03) k = N - k;
  const rx = R.slice(1);
  const e = big(taggedHash('BIP0340/challenge', cat(rx, px, msg32))) % N;
  return cat(rx, bytes32((k + e * d) % N));
}

export function eventId(ev) { return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content])))); }
export function signEvent(privHex, { kind, tags = [], content = '', created_at = Math.floor(Date.now() / 1000) }) {
  const ev = { pubkey: pubkeyOf(privHex), created_at, kind, tags, content: typeof content === 'string' ? content : JSON.stringify(content) };
  ev.id = eventId(ev);
  ev.sig = bytesToHex(schnorrSign(hexToBytes(ev.id), privHex));
  return ev;
}
export const verifyEvent = (ev) => { try { return verifyNostrEvent(ev); } catch { return false; } };
export const verifySig = (msg32, sigHex, pubkeyHex) => { try { return !!verifySchnorr(msg32, hexToBytes(sigHex), hexToBytes(pubkeyHex)); } catch { return false; } };

// SPEC 4: a worker's consent to a delegation, so nobody can name a worker they do not hold.
// The worker signs taggedHash("datstr/delegation", master ‖ worker); the master puts the
// signature in the delegation's content as `consent` before signing the event.
export const consentMessage = (master, worker) => taggedHash('datstr/delegation', hexToBytes(master + worker));
export const signConsent = (workerKey, master) => bytesToHex(schnorrSign(consentMessage(master, pubkeyOf(workerKey)), workerKey));
export const verifyConsent = (delegation) => {
  const c = content(delegation); const worker = (c?.worker ?? '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(worker) && /^[0-9a-f]{128}$/i.test(c?.consent ?? '') && verifySig(consentMessage(delegation.pubkey, worker), c.consent, worker);
};

// SPEC 11.1: a signed hello, shaped like NIP-98 (kind 27235, `u` the endpoint dialled, `method`
// "hello"), proves the socket holds the key it will sign shares with. Fresh within 60 s.
export const AUTH_KIND = 27235, AUTH_WINDOW = 60;
export const signAuth = (key, url, method = 'hello') => signEvent(key, { kind: AUTH_KIND, tags: [['u', url], ['method', method]], content: '' });
export function checkAuth(ev, { pubkey, path, seen, method = 'hello', now = Math.floor(Date.now() / 1000) }) {
  if (!ev || ev.kind !== AUTH_KIND || !verifyEvent(ev)) return 'auth: a signed kind 27235 event is needed';
  if (pubkey && ev.pubkey !== pubkey) return `auth: signed by ${ev.pubkey.slice(0, 16)}…, not the socket's worker ${pubkey.slice(0, 16)}…`;
  if (Math.abs(now - ev.created_at) > AUTH_WINDOW) return `auth: created_at ${ev.created_at} is outside the ${AUTH_WINDOW} s window`;
  const tag = (n) => ev.tags.find((t) => t[0] === n)?.[1];
  if (tag('method') !== method) return `auth: method must be ${method}`;
  let u; try { u = new URL(tag('u')); } catch { return 'auth: u must be the endpoint dialled'; }
  if (path && u.pathname !== path) return `auth: u names ${u.pathname}, this endpoint is ${path}`;
  if (seen) { for (const [id, t] of seen) if (now - t > AUTH_WINDOW * 2) seen.delete(id); if (seen.has(ev.id)) return 'auth: replayed'; seen.set(ev.id, now); }
  return null;
}
export const content = (ev) => { try { return JSON.parse(ev.content); } catch { return null; } };
