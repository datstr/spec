// The merkle path of the coinbase (index 0) and the root rebuilt from it, Bitcoin style:
// double SHA-256 over internal-order hashes, odd levels duplicate their last node.
import { SCHEMA } from './engine.mjs';
const { dsha256, hexToBytes, bytesToHex } = await import(`${SCHEMA}/codec/hash.js`);
const rev = (hex) => bytesToHex(hexToBytes(hex).reverse());
const pair = (a, b) => rev(bytesToHex(dsha256(new Uint8Array([...hexToBytes(rev(a)), ...hexToBytes(rev(b))]))));
export function coinbaseBranches(txids) { // display-order txids, coinbase first
  const branches = []; let level = txids.slice();
  while (level.length > 1) {
    if (level.length % 2) level.push(level[level.length - 1]);
    branches.push(level[1]);
    const next = []; for (let i = 0; i < level.length; i += 2) next.push(pair(level[i], level[i + 1]));
    level = next;
  }
  return branches;
}
export function rootFromBranches(cbTxid, branches) { let h = cbTxid; for (const b of branches) h = pair(h, b); return h; }
