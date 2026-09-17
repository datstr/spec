#!/usr/bin/env node
// A simulator for the coordinator's vardiff, on a virtual clock.
//
// We cannot fake a 5 TH/s miner over the wire: the gateway verifies real proof of work. But
// the retarget only ever sees share arrival times and the assignment they named, so the whole
// algorithm can be driven synthetically at any scale, deterministically, in milliseconds.
//
// It borrows the real Coordinator.retargetAssignments and feeds it a stub with exactly the
// fields that method touches, so it tests the shipped code rather than a copy of it.
//
//   node plugin/test/vardiff-sim.mjs            all scenarios
//   node plugin/test/vardiff-sim.mjs cold       one scenario
import { difficultyOf } from '../../gateway/lib/split.mjs';
import { targetForDifficulty } from '../../gateway/lib/target.mjs';

// --- the method under test, borrowed from the real class -------------------------------
import { Coordinator } from '../coordinator.mjs';

const MASTER = 'm'.repeat(64);
const hash = { bytesToHex: (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('') };

// --- virtual clock ---------------------------------------------------------------------
let NOW = 1_700_000_000_000; // ms
const realNow = Date.now;
Date.now = () => NOW;
const advance = (seconds) => { NOW += seconds * 1000; };

// --- a stub with only what retargetAssignments touches ----------------------------------
function makeStub({ params = {}, startDifficulty = 1000, netDifficulty = 8.5e8 } = {}) {
  const s = {
    params: {
      vardiffSeconds: 10, minDifficulty: 0.001, maxDifficulty: 1e8,
      ...(process.env.VARDIFF_PARAMS ? JSON.parse(process.env.VARDIFF_PARAMS) : {}), // sweep window/cadence from the shell
      ...params,
    },
    clients: new Set([{ identities: new Set([MASTER]) }]),
    assignments: new Map(), assignmentsByMaster: new Map(),
    shares: [], recentReceipts: [], lastRetarget: 0,
    tip: { target: hash.bytesToHex(targetForDifficulty(netDifficulty)) },
    hash,
    changes: [],
    log: () => {},
    currentAssignment(master) { return this.assignmentsByMaster.get(master)?.at(-1) ?? null; },
    addAssignment(rec) {
      this.assignments.set(rec.id, rec);
      const l = this.assignmentsByMaster.get(rec.master) ?? []; l.push(rec); this.assignmentsByMaster.set(rec.master, l);
    },
    async issueAssignment(master, difficulty, why) {
      const target = hash.bytesToHex(targetForDifficulty(difficulty));
      const rec = { id: 'a' + (this.changes.length + 1), master, target, from: 0, at: Math.floor(NOW / 1000) };
      this.addAssignment(rec);
      this.changes.push({ t: Math.floor(NOW / 1000), difficulty: difficultyOf(target), why });
      return rec;
    },
  };
  // the first assignment, as register() would make it
  s.issueAssignment(MASTER, startDifficulty, 'first assignment');
  s.changes.length = 0; // don't count the initial one
  return s;
}

// --- a seeded random source, so a jittered run is still reproducible ---------------------
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function poisson(rng, lambda) {
  if (lambda <= 0) return 0;
  if (lambda > 30) { const u = 1 - rng(), v = rng(); const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z)); }
  const L = Math.exp(-lambda); let k = 0, p = 1; do { k++; p *= rng(); } while (p > L); return k - 1;
}

// --- the simulated miner ---------------------------------------------------------------
// A miner of `hashrate` H/s at difficulty D produces shares as a Poisson process of rate
// H / (D * 2^32). The default emits at the mean rate, which isolates the algorithm's response
// to a true rate change. `jitter` draws real Poisson counts instead: the production retarget
// turned out to react to the count noise itself (it alternates 8 -> 21 -> 8 shares a window at
// a constant hashrate), and only a jittered run can show that, or show it fixed.
// `cap` models a proxy that will not forward more than N shares a second (MRR does ~100).
function emitShares(stub, { hashrate, seconds, cap = Infinity, jitter = false }) {
  const cur = stub.currentAssignment(MASTER); if (!cur) return 0;
  const d = difficultyOf(cur.target);
  const rate = Math.min(hashrate / (d * 2 ** 32), cap);
  let n;
  if (jitter) n = poisson(stub.rng, rate * seconds);
  else {
    // Carry the fraction across steps. Rounding each step independently cannot represent a rate
    // below 1/(2*step) -- at 10 kdiff a 5 TH rig earns 0.42 shares per 5 s step and would round to
    // zero forever, manufacturing exactly the silent windows this file exists to test.
    stub.carry = (stub.carry ?? 0) + rate * seconds;
    n = Math.floor(stub.carry); stub.carry -= n;
  }
  const at = Math.floor(NOW / 1000);
  for (let i = 0; i < n; i++) stub.shares.push({ master: MASTER, at, assignment: cur.id, weight: d });
  if (stub.shares.length > 200000) stub.shares.splice(0, 100000);
  return n;
}

// --- run a scenario ----------------------------------------------------------------------
async function run(stub, retarget, { minutes, hashrate, cap, gapMinutes = 0, jitter = false, seed = 1, label }) {
  const step = 5; // the coordinator evaluates on its poll; 5 s is the finest either uses
  stub.rng = mulberry32(seed);
  const start = difficultyOf(stub.currentAssignment(MASTER).target); // the step INTO the first change counts too
  let emitted = 0;
  for (let t = 0; t < minutes * 60; t += step) {
    const inGap = gapMinutes > 0 && t >= 60 && t < 60 + gapMinutes * 60; // one minute in, go quiet for gapMinutes
    if (!inGap) emitted += emitShares(stub, { hashrate, seconds: step, cap, jitter });
    advance(step);
    await retarget.call(stub);
  }
  const cur = stub.currentAssignment(MASTER);
  const final = difficultyOf(cur.target);
  const ideal = hashrate * (stub.params.vardiffSeconds ?? 10) / 2 ** 32;
  const steps = stub.changes.map((c, i, a) => c.difficulty / (i ? a[i - 1].difficulty : start));
  return {
    label, changes: stub.changes.length, trail: stub.changes, final, ideal,
    ratio: final / ideal,
    maxUp: steps.length ? Math.max(...steps) : 1,
    maxDown: steps.length ? Math.min(...steps) : 1,
    emitted,
  };
}

const fmt = (n) => n >= 1000 ? n.toPrecision(4) : n.toPrecision(3);
// `known` names an open defect the scenario documents: it is expected to fail, is reported as
// XFAIL, and does not fail the suite. If it starts passing it is reported as XPASS so the note
// gets removed. This keeps the acceptance test for a planned fix in the file before the fix.
function report(r, expect, known = null) {
  const ok = expect(r);
  const pass = known ? true : ok;
  const tag = known ? (ok ? 'XPASS' : 'XFAIL') : (ok ? 'PASS' : 'FAIL');
  console.log(`${tag}  ${r.label}${known ? `  [known: ${known}${ok ? ' -- now passes, drop the note' : ''}]` : ''}`);
  if (process.env.DEBUG_CHANGES) console.log('      trail:', r.trail.map((c) => c.difficulty.toPrecision(3) + ' [' + c.why + ']').join('  ->  '));
  console.log(`      changes ${r.changes}  final ${fmt(r.final)}  ideal ${fmt(r.ideal)}  off by ${r.ratio.toFixed(2)}x  max step up ${r.maxUp.toFixed(1)}x down ${r.maxDown.toFixed(3)}x`);
  return pass;
}

const TH = 1e12, MH = 1e6;
const scenarios = {
  // today's F1: a 5 TH rig connects cold onto a low assignment
  cold: async (retarget) => report(await run(makeStub({ startDifficulty: 1000 }), retarget,
    { minutes: 10, hashrate: 5 * TH, cap: 100, label: 'cold connect, 5 TH, start 1000' }),
    (r) => r.ratio > 0.5 && r.ratio < 2 && r.changes < 15),
  // the 238-changes-in-30-minutes problem: a steady miner should barely move
  steady: async (retarget) => report(await run(makeStub({ startDifficulty: 11600 }), retarget,
    { minutes: 30, hashrate: 5 * TH, cap: 100, label: 'steady 5 TH for 30 min, already at the right difficulty' }),
    (r) => r.changes <= 10 && r.ratio > 0.5 && r.ratio < 2),
  // today's F4: a poisoned assignment must come back quickly
  poisoned: async (retarget) => report(await run(makeStub({ startDifficulty: 1.56e6 }), retarget,
    { minutes: 10, hashrate: 5 * TH, cap: 100, label: 'poisoned 1.56M assignment, 5 TH' }),
    (r) => r.ratio > 0.5 && r.ratio < 2),
  // a phone: must be able to descend all the way
  phone: async (retarget) => report(await run(makeStub({ startDifficulty: 1000 }), retarget,
    { minutes: 30, hashrate: 2 * MH, cap: 100, label: 'phone, 2 MH/s, start 1000' }),
    (r) => r.ratio > 0.3 && r.ratio < 3),
  // the 17 Sep production failure: a live rig goes quiet for one window and is cut 64x
  gap: async (retarget) => report(await run(makeStub({ startDifficulty: 4820 }), retarget,
    { minutes: 25, hashrate: 4 * TH, cap: 100, gapMinutes: 4, label: '4 TH, one 4 min silence spanning a whole window' }),
    (r) => r.maxDown >= 0.2 && r.ratio > 0.5 && r.ratio < 2),
  // the 17 Sep production oscillation: at a constant hashrate and the right difficulty, real
  // Poisson counts made the gain-1 retarget on a 120 s window alternate 17 -> 8 -> 17 shares
  // indefinitely. A steady rig should see a handful of changes in half an hour, not one every
  // cycle. Fixed by the 300 s window plus half-gain; at (120 s, gain 1) this fails with 5-6.
  jitter: async (retarget) => report(await run(makeStub({ startDifficulty: 11600 }), retarget,
    { minutes: 30, hashrate: 5 * TH, cap: 100, jitter: true, seed: 1, label: 'steady 5 TH for 30 min with Poisson arrivals' }),
    (r) => r.changes <= 3 && r.ratio > 0.5 && r.ratio < 2),
  // a rig legitimately at maxDifficulty and still producing shares is fast, not poisoned. The
  // runaway branch proposes 1000, but the n > 0 cap that follows floors any move at d0/4, so a
  // producing rig steps down gently; only a rig at maxD with no shares at all takes the full reset.
  // (A review once read this as a 50x trap; this scenario is what showed the cap catches it.)
  cap: async (retarget) => report(await run(makeStub({ startDifficulty: 50000, params: { maxDifficulty: 50000 } }), retarget,
    { minutes: 15, hashrate: 6 * TH, cap: 100, label: '6 TH rig sitting at maxDifficulty 50000 while producing shares' }),
    (r) => r.maxDown >= 0.2 && r.ratio > 0.5 && r.ratio < 2),
};

const which = process.argv[2];
const retarget = Coordinator.prototype.retargetAssignments;
let all = true;
for (const [name, fn] of Object.entries(scenarios)) {
  if (which && which !== name) continue;
  all = (await fn(retarget)) && all;
}
Date.now = realNow;
console.log(all ? '\nall scenarios passed' : '\nsome scenarios failed');
process.exit(all ? 0 : 1);
