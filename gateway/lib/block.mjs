// Build a block the datstr way from a getblocktemplate result: SPEC.md section 6.
export function buildBlock({ k, hash, template: t, payScripts, worker = '00'.repeat(32), parentsRoot = '00'.repeat(32), split }) {
  const { taggedHash, hexToBytes, bytesToHex } = hash;
  const txs = t.transactions.map((x) => k.codec.decode('Transaction', x.data));
  const txids = t.transactions.map((x) => x.txid);
  // the split: what a coordinator dictates (SPEC 9); without one, the template value shared
  // equally across the payout scripts, rounding dust on the first output
  let outputs;
  if (split) outputs = split.map(([scriptPubKey, value]) => ({ value, scriptPubKey }));
  else {
    const each = Math.floor(t.coinbasevalue / payScripts.length);
    outputs = payScripts.map((scriptPubKey, i) => ({ value: i === 0 ? t.coinbasevalue - each * (payScripts.length - 1) : each, scriptPubKey }));
  }
  const nSplit = outputs.length;
  if (t.default_witness_commitment) outputs.push({ value: 0, scriptPubKey: t.default_witness_commitment });
  const commitment = bytesToHex(taggedHash('datstr/share', hexToBytes(worker + parentsRoot)));
  outputs.push({ value: 0, scriptPubKey: '6a20' + commitment }); // OP_RETURN <32 bytes>, last
  const heightPush = (h) => { const out = []; let n = h; while (n > 0) { out.push(n & 0xff); n >>>= 8; } if (out.length && out[out.length - 1] & 0x80) out.push(0); return bytesToHex(Uint8Array.from([out.length, ...out])); };
  const scriptSig = heightPush(t.height) + '0400000000'; // BIP34 height, then a 4-byte push of zeros
  const coinbase = {
    version: 2,
    inputs: [{ prevout: { txid: '00'.repeat(32), vout: 0xffffffff }, scriptSig, sequence: 0xffffffff }],
    outputs,
    witness: t.default_witness_commitment ? [['00'.repeat(32)]] : undefined,
    lockTime: 0,
  };
  const cbTxid = k.codec.txid(coinbase);
  const header = {
    version: t.version, prevBlockHash: t.previousblockhash, merkleRoot: k.codec.merkleRoot([cbTxid, ...txids]),
    timeOnWire: t.curtime, bits: parseInt(t.bits, 16), nonce: 0, nonce2: 0, nonce3: 0, extranonce: '00'.repeat(16),
    timeOffset: 0, txCount: txs.length + 1, flags: 0, xorKeyMaskClearBits: 0, xorKey: '00'.repeat(16), height: t.height, mmRhs: '00'.repeat(32),
  };
  return { header, coinbase, cbTxid, transactions: [coinbase, ...txs], commitment, nSplit };
}
