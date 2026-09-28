# Benchmarks

Initial sync of the BLAKE2b testnet4 node, on the machine that runs the estate (32 cores, 59 GB, NVMe), blocks served by the live node over loopback so the network drops out of the measurement. Binary: Knots 29.4.2 built from `src-assumeutxo` (the live tree plus one testnet4 assumeUTXO entry for block 150,307). Harness: `ibd.sh`, driver `run-all.sh`, raw samples and summaries in `results/`.

## 28 September 2026, chain at 151,926 blocks, 13.0 GB

| run | time to a usable tip | time to fully validated | peak memory | CPU | disk |
|---|---|---|---|---|---|
| full sync, default db cache | 142 s | 142 s | 2.3 GB | 610 s | 13.0 GB |
| full sync, `-dbcache=8000` | 143 s | 143 s | 2.3 GB | 609 s | 13.0 GB |
| assumeUTXO from the 150,307 snapshot (870 MB, 14.2 M coins) | **28 s** (headers 1 s, load 17 s, 1,619 blocks on top 10 s) | 213 s (background validation from genesis, retired the snapshot) | 5.1 GB (two chainstates) | 730 s | 15.8 GB |

What it says:

- On this hardware the whole chain validates in under two and a half minutes; the db cache does not matter at this size. The sync is CPU-bound on validation, not I/O.
- The snapshot brings a usable, fully synced tip in 28 seconds, five times sooner. The full validation still happens, in the background, and costs about a third more CPU than a plain sync because the node serves the snapshot chainstate while it validates.
- Over the internet the ratio is the download: 13 GB of blocks against 870 MB of snapshot plus 6 MB of blocks since the fork. At 100 Mbit that is about 17 minutes against about 70 seconds, before validation.

## The browser node, same snapshot, Chromium on the same machine

The blaketestnode page (`browser/index.html`): the snapshot is fetched into the tab's private file system, hashed, parsed with `hash_serialized_3` recomputed and a 217 MiB txid index built, then the BLAKE2b blocks since the fork are synced from the mirror and validated, all in a worker.

| phase | time | note |
|---|---|---|
| fetch 830 MiB | 0.5 s from a local server (file cache); over the internet it is the download, about 70 s at 100 Mbit | Range requests, resumable |
| sha256 of the file | 9 s | pinned in the snapshot's metadata |
| parse, recompute `hash_serialized_3`, build the index | 23 s | 14,230,182 coins in 9,356,185 txids; the hash matched the pinned value |
| fetch the 1,620 blocks since the fork from the mirror, over the internet | 0.55 s | 4.57 MB |
| validate them to the tip, 151,927 | 29.8 s | every block: headers, structure, signature-free BLAKE2b proof of work, scripts, against the snapshot's coins |

**Total: about 63 seconds from a snapshot on disk to a validated tip in a tab**, against 28 s for Knots to a usable tip on the same snapshot and 142 s for Knots from genesis. Over the internet, add the snapshot download, about 70 s at 100 Mbit. The tab is a full validator of the BLAKE2b chain from that point on; what it trusts is the snapshot's pinned hash, which is the paper's trust path, step zero.
