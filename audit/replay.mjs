#!/usr/bin/env node
// Replay a coordinator's ledger snapshot from its shares (SPEC 13 step 3): read the pool
// descriptor, the masters, the credited shares up to the snapshot's sequence, recompute the
// window and the split with the same pure functions, and compare byte for byte. Also checks
// the signature of every share in the window.
//
//   node audit/replay.mjs --data <coordinator data dir> --height <h>
//   node audit/replay.mjs --url http://127.0.0.1:3400 --height <h>
import { readFile } from 'node:fs/promises';
import { computeSplit, windowOf, difficultyOf } from '../gateway/lib/split.mjs';
import { verifyEvent, content as contentOf } from '../gateway/lib/nostr.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] === undefined || all[i + 1].startsWith('--') ? true : all[i + 1]] : []).filter(Boolean));
const get = async (p) => args.url ? (await fetch(`${args.url.replace(/\/$/, '')}/${p}`)).text() : readFile(`${args.data}/${p}`, 'utf8');
const lines = (t) => t.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const H = Number(args.height);
const pool = JSON.parse(await get('pool.json')); const params = JSON.parse(pool.content);
const masters = new Map(lines(await get('masters.jsonl')).map((m) => [m.pubkey, m]));
let delegations = new Map(); try { delegations = new Map(lines(await get('delegations.jsonl')).map((d) => [d.worker, d])); } catch {}
const signerOk = (ev, s) => ev.pubkey === s.master || delegations.get(ev.pubkey)?.master === s.master;
// SPEC 8.4: a share's weight is the difficulty of the assignment it names, valid for its master at its height
let assignments = new Map(), byMaster = new Map();
try { for (const a of lines(await get('assignments.jsonl'))) { assignments.set(a.id, a); const l = byMaster.get(a.master) ?? []; l.push(a); byMaster.set(a.master, l); } } catch {}
for (const l of byMaster.values()) l.sort((a, b) => a.from - b.from || a.at - b.at);
const grace = params.assignmentGrace ?? 120;
const assignmentOk = (ev, c, s) => {
  const a = assignments.get(c.assignment ?? ''); if (!a || a.master !== s.master || a.from > s.height) return false;
  const all = (byMaster.get(s.master) ?? []).filter((x) => x.from <= s.height), t = ev.created_at; // 8.4, as of the share's signing time
  const before = all.filter((x) => x.at <= t), latest = before.at(-1), prev = before.at(-2), next = all.find((x) => x.at > t && x.at <= t + grace);
  const valid = a === latest || (!!latest && a === prev && t <= latest.at + grace) || (!!next && a === next);
  return valid && (c.target ?? '').toLowerCase() === a.target && Math.abs(difficultyOf(a.target) - s.weight) < 1e-9;
};
const shares = lines(await get('shares.jsonl'));
const snap = JSON.parse(await get(`snapshots/${H}.json`));
const upTo = shares.slice(0, snap.sharesUpTo);
const win = windowOf(upTo, snap.need);
const r = computeSplit(win.shares, snap.tipValue, params, snap.owedBefore ?? {});
const outputs = r.outputs.map((o) => [o.script ?? masters.get(o.master)?.payout, o.value]).filter(([s]) => s);
const same = JSON.stringify(outputs) === JSON.stringify(snap.outputs) && win.weight === snap.window.weight && JSON.stringify(win.shares.map((s) => s.id)) === JSON.stringify(snap.window.shares);
let sigs = 0, bad = 0, assigned = 0, unassigned = 0;
for (const s of win.shares) { try { const ev = JSON.parse(await get(`shares/${s.id}.json`)); const c = contentOf(ev); if (verifyEvent(ev) && signerOk(ev, s) && c?.height === s.height) sigs++; else bad++; if (c && assignmentOk(ev, c, s)) assigned++; else unassigned++; } catch { bad++; unassigned++; } }
console.log(`snapshot h${H} from ${pool.pubkey.slice(0, 16)}…: ${snap.sharesUpTo} shares credited, window ${win.shares.length} shares weight ${win.weight} (need ${snap.need})`);
console.log(`  replayed outputs: ${outputs.map(([s, v]) => s.slice(0, 12) + '… ' + v).join(', ')}`);
console.log(`  snapshot outputs: ${snap.outputs.map(([s, v]) => s.slice(0, 12) + '… ' + v).join(', ')}`);
console.log(`  share signatures: ${sigs} good, ${bad} bad`);
console.log(`  weights from assignments: ${assigned} good, ${unassigned} bad`);
console.log(same && bad === 0 && unassigned === 0 ? 'MATCH: the replay reproduces the snapshot byte for byte' : 'DIFFER');
process.exitCode = same && bad === 0 && unassigned === 0 ? 0 : 1;
