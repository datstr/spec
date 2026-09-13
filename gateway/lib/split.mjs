// SPEC.md section 9: the deterministic split. Pure functions, so a coordinator and an auditor
// compute the same bytes from the same shares.
export function difficultyOf(targetHex) { // ratum's convention: 2^224 / target, as a float
  let n = 0n; for (const b of Buffer.from(targetHex, 'hex')) n = (n << 8n) | BigInt(b);
  return n === 0n ? Infinity : Number((1n << 224n) * 1000000n / n) / 1e6;
}

// The window (9.1): the newest shares whose weights sum to at least `need`, oldest dropped first.
// `shares` are in credit order; returns the slice that is the window.
export function windowOf(shares, need) {
  let w = 0, i = shares.length;
  while (i > 0 && w < need) { i--; w += shares[i].weight; }
  return { shares: shares.slice(i), weight: w, from: i };
}

// The outputs (9.2) for a template value V, from a window and the pool descriptor.
export function computeSplit(window, V, p, owedIn = {}) {
  const byMaster = new Map();
  for (const s of window) byMaster.set(s.master, (byMaster.get(s.master) ?? 0) + s.weight);
  const W = [...byMaster.values()].reduce((a, b) => a + b, 0);
  const fee = Math.floor(V * (p.feeBps ?? 0) / 10000);
  let R = V - fee;
  const outputs = []; const owed = { ...owedIn };
  // owed balances first (9.2 step 5), oldest masters first by key order
  for (const m of Object.keys(owed).sort()) {
    if (R <= 0) break;
    const pay = Math.min(owed[m], R); if (pay < (p.minPayout ?? 546)) continue;
    outputs.push({ master: m, value: pay, owedPaid: true }); R -= pay; owed[m] -= pay; if (owed[m] === 0) delete owed[m];
  }
  let pays = [...byMaster].map(([m, w]) => ({ master: m, value: W > 0 ? Math.floor(R * w / W) : 0, w }));
  // step 4: drop under minPayout, redistribute their sum once over the rest, by weight
  const min = p.minPayout ?? 546;
  const kept = pays.filter((x) => x.value >= min), dropped = pays.filter((x) => x.value < min);
  const extra = dropped.reduce((a, x) => a + x.value, 0), keptW = kept.reduce((a, x) => a + x.w, 0);
  for (const x of kept) x.value += keptW > 0 ? Math.floor(extra * x.w / keptW) : 0;
  // step 5: order by value desc then master asc, cap at maxOutputs, the rest owed
  kept.sort((a, b) => b.value - a.value || (a.master < b.master ? -1 : 1));
  const cap = Math.max(0, (p.maxOutputs ?? 512) - outputs.length);
  for (const x of kept.slice(cap)) owed[x.master] = (owed[x.master] ?? 0) + x.value;
  const paid = kept.slice(0, cap);
  // step 6: rounding dust to the first output
  const dust = R - paid.reduce((a, x) => a + x.value, 0) - kept.slice(cap).reduce((a, x) => a + x.value, 0);
  if (paid.length) paid[0].value += dust; else if (outputs.length) outputs[0].value += dust;
  const all = [...outputs, ...paid.map((x) => ({ master: x.master, value: x.value }))];
  if (fee > 0 && p.feeScript) all.push({ master: null, script: p.feeScript, value: fee });
  return { outputs: all, W, fee, owed };
}

// 9.3: a gateway whose template value differs scales the outputs proportionally, keeping
// order, dust on the first output. Outputs are [script, sats] pairs.
export function scaleSplit(outputs, V) {
  const S = outputs.reduce((a, [, v]) => a + v, 0);
  if (S === V || S === 0) return outputs.map(([s, v]) => [s, v]);
  const scaled = outputs.map(([s, v]) => [s, Math.floor(v * V / S)]);
  scaled[0][1] += V - scaled.reduce((a, [, v]) => a + v, 0);
  return scaled;
}
