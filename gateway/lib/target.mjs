// Share and network targets as 32 big-endian bytes, compared the way the chain compares a
// display-order hash: byte by byte from the front. Difficulty d is the pool convention
// ratum uses: target = 2^224 / d, so difficulty 1 expects 2^32 hashes.
export function targetForDifficulty(d) {
  const t = new Uint8Array(32);
  if (!(d > 0)) return t.fill(0xff);
  let q = (1n << 224n) / BigInt(Math.round(d * 1e6)) * 1000000n; // 2^224 / d with six decimals of d
  if (q < 1n) q = 1n;
  for (let i = 31; i >= 0 && q > 0n; i--) { t[i] = Number(q & 0xffn); q >>= 8n; }
  return t;
}
export function difficultyOfTarget(t) { // informational: 2^224 / target
  let n = 0n; for (const b of t) n = (n << 8n) | BigInt(b);
  return n === 0n ? Infinity : Number((1n << 224n) * 1000000n / n) / 1e6;
}
export function meets(hashBytes, target) {
  for (let i = 0; i < 32; i++) { if (hashBytes[i] < target[i]) return true; if (hashBytes[i] > target[i]) return false; }
  return true;
}
