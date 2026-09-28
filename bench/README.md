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

The fourth run, the browser node from the same snapshot, is measured in a tab and recorded below when done.
