// SPEC 9.1: the window by weight, and its maximum age.   node gateway/test/window-test.mjs
import { windowOf } from '../lib/split.mjs';
const t = (name, ok) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) process.exitCode = 1; };
const rig = (at) => ({ master: 'rig', weight: 7870, at }), cpu = (at, w = 0.001) => ({ master: 'cpu', weight: w, at });
const now = 100000; const shares = [rig(now - 20000), rig(now - 19000), ...Array.from({ length: 48000 }, (_, i) => cpu(now - 3600 + Math.floor(i / 14)))]; // a rig that left 5 h ago, then an hour of CPU shares (48 weight)
const a = windowOf(shares, 100);
t('no maxAge: the window reaches back to the rig share that completes it (rig 99.4%)', a.shares[0].master === 'rig' && a.weight > 7870);
const b = windowOf(shares, 100, { maxAge: 6 * 3600, now });
t('maxAge 6 h: the 5-hour-old rig share is still in (it is within the age)', b.shares[0].master === 'rig');
const c = windowOf(shares, 100, { maxAge: 3 * 3600, now });
t('maxAge 3 h: the rig share is out; the window is the hour of CPU shares alone, under need', c.shares.every((s) => s.master === 'cpu') && c.shares.length === 48000 && Math.abs(c.weight - 48) < 1e-6);
const d = windowOf(shares, 10, { maxAge: 3 * 3600, now });
t('maxAge with enough recent weight: the window fills by weight as before', d.weight >= 10 && d.shares.length < 48000 && d.shares.every((s) => s.master === 'cpu'));
const e = windowOf([{ master: 'x', weight: 5 }, ...shares.slice(2)], 100, { maxAge: 3600, now });
t('a share with no `at` never ages out', e.shares[0].master === 'x');
t('maxAge 0 means no bound', JSON.stringify(windowOf(shares, 100, { maxAge: 0, now })) === JSON.stringify(a));
t('maxAge without `now` means no bound', JSON.stringify(windowOf(shares, 100, { maxAge: 3600 })) === JSON.stringify(a));
process.exit();
