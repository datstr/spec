// The browser miner's arithmetic, shared by the page's workers and the Node test client.
// A job in the Sia dialect gives coinb1 (three zero bytes and H2), the hidden previous block
// and an 8-byte ntime field; the miner adds the 16-byte extranonce and rolls the nonce over
//   [hidden prev 32][nonce field 8][ntime field 8][work root 32]
// where work root = blake2b(0x00 ‖ coinb1 ‖ extranonce), then blake2b over those 80 bytes.
export const hexToBytes = (h) => { const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
export const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const hexLE32 = (n) => bytesToHex(new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]));

export function targetForDifficulty(d) { // 2^224 / d, big-endian; ratum's convention
  const t = new Uint8Array(32);
  if (!(d > 0)) return t.fill(0xff);
  let q = (1n << 224n) / BigInt(Math.round(d * 1e6)) * 1000000n; if (q < 1n) q = 1n;
  for (let i = 31; i >= 0 && q > 0n; i--) { t[i] = Number(q & 0xffn); q >>= 8n; }
  return t;
}
export function meets(hash, target) { for (let i = 0; i < 32; i++) { if (hash[i] < target[i]) return true; if (hash[i] > target[i]) return false; } return true; }

export function workHeader(blake2b, job, extranonceHex) {
  const leaf = new Uint8Array(52); leaf.set(hexToBytes(job.coinb1), 1); leaf.set(hexToBytes(extranonceHex), 36);
  const root = blake2b(leaf, 32);
  const h = new Uint8Array(80); h.set(hexToBytes(job.prevHidden), 0); h.set(hexToBytes(job.ntime), 40); h.set(root, 48);
  return h;
}
// Try `count` nonces from `start` stepping by `step`; returns the first that meets the target.
export function mine(blake2b, header, target, start, step, count) {
  const h = header.slice(); let n = start >>> 0;
  for (let i = 0; i < count; i++) {
    h[32] = n & 255; h[33] = (n >>> 8) & 255; h[34] = (n >>> 16) & 255; h[35] = (n >>> 24) & 255;
    if (meets(blake2b(h, 32), target)) return { nonce: n, hashes: i + 1 };
    n = (n + step) >>> 0;
  }
  return { nonce: null, hashes: count };
}
export const nonceField = (nonce) => hexLE32(nonce) + '00000000';
export function parseNotify(params) { return { id: params[0], prevHidden: params[1], coinb1: params[2], bits: params[6], ntime: params[7], clean: !!params[8] }; }
