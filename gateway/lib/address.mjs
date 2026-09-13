// scriptPubKey → address for the segwit outputs a coinbase pays (bech32 for v0, bech32m for v1+).
// Anything else comes back null and the caller shows the script.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) { const top = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i]; }
  return chk >>> 0;
}
function hrpExpand(hrp) { const out = []; for (const c of hrp) out.push(c.charCodeAt(0) >>> 5); out.push(0); for (const c of hrp) out.push(c.charCodeAt(0) & 31); return out; }
function toWords(bytes) { const out = []; let acc = 0, bits = 0; for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out.push((acc >>> bits) & 31); } } if (bits) out.push((acc << (5 - bits)) & 31); return out; }
export function segwitAddress(hrp, version, program) {
  const words = [version, ...toWords(program)];
  const konst = version === 0 ? 1 : 0x2bc830a3;
  const pm = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ konst;
  const chk = []; for (let i = 0; i < 6; i++) chk.push((pm >>> (5 * (5 - i))) & 31);
  return hrp + '1' + [...words, ...chk].map((w) => CHARSET[w]).join('');
}
export function scriptToAddress(spkHex, hrp) {
  const m = /^(00|5[1-9a-f]|60)([0-9a-f]{2})([0-9a-f]+)$/i.exec(spkHex);
  if (!m) return null;
  const version = m[1] === '00' ? 0 : parseInt(m[1], 16) - 0x50;
  const len = parseInt(m[2], 16), program = m[3];
  if (program.length !== len * 2 || len < 2 || len > 40) return null;
  if (version === 0 && len !== 20 && len !== 32) return null;
  return segwitAddress(hrp, version, Buffer.from(program, 'hex'));
}
