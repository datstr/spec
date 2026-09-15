# datstr coordinator

The level 1 coordinator from [SPEC.md](../SPEC.md) sections 8 to 11: it verifies signed shares
with the engine, keeps the difficulty-summed window, dictates the coinbase split, relays blocks,
and writes every document an auditor needs. It runs standalone or as a
[JSS](https://jss.live/) plugin; the core is the same file either way.

```
coordinator.mjs   the core: verification, window, split, delegations, documents, HTTP router
index.mjs         JSS plugin entry: activate(api) mounts the router and the gateway WebSocket
standalone.mjs    the same core on node:http plus the engine's own WebSocket server
status.html       the coordinator's page, served at the mount root
test/regtest.sh   SPEC section 13 on a throwaway regtest, standalone or under jss (HOST=jss)
```

## Requirements

- Node 22 or later.
- A Bitcoin Knots build with the BLAKE2b change, running, with RPC reachable and a
  `bitcoin.conf` the coordinator can read (cookie or `rpcuser`/`rpcpassword`).
- A checkout of [bitcoin-desktop/schema](https://github.com/bitcoin-desktop/schema), the
  engine, at `~/bitcoin-desktop/schema` or wherever `SCHEMA` points.
- For the JSS mount: JSS 0.0.219 or later (the `--plugin` flag). jspod bundles one.

## Standalone

```sh
node plugin/standalone.mjs --conf ~/knots-testnet4/bitcoin.conf --network btc:testnet4-blake2b \
  --data ~/datstr-coordinator --port 3400 --window-multiple 0 --window-min-weight 4 --min-difficulty 0.001
```

Gateways join `ws://host:3400/ws`; documents and pages are at `http://host:3400/`.

## As a JSS plugin

With the flag, config comes from the environment:

```sh
DATSTR_CONF=~/knots-testnet4/bitcoin.conf DATSTR_NETWORK=btc:testnet4-blake2b \
DATSTR_DATA=~/datstr-coordinator DATSTR_PARAMS='{"windowMultiple":0,"windowMinWeight":200,"minDifficulty":0.001}' \
jss start --plugin /path/to/datstr/spec/plugin/index.mjs@/datstr
```

Or in a JSS config file, which wins over the environment:

```js
plugins: [{ module: '/path/to/datstr/spec/plugin/index.mjs', prefix: '/datstr',
  config: { conf: '~/knots-testnet4/bitcoin.conf', network: 'btc:testnet4-blake2b',
            dataDir: '~/datstr-coordinator', params: { windowMultiple: 0, windowMinWeight: 4, minDifficulty: 0.001 } } }]
```

Gateways join `ws://host/datstr/ws`; everything else is under `/datstr/`. Without `dataDir` the
plugin uses JSS's private plugin directory. One mount serves one chain; a second chain is a
second mount with its own prefix and data directory.

Other keys: `key` or `DATSTR_KEY` (the coordinator's Nostr private key, else one is made and
kept in the data directory), `activation` and `headline` for a regtest chain.

## Parameters

All in the pool descriptor (`/pool.json`), signed by the coordinator's key.

| key | default | meaning |
|---|---|---|
| `feeBps`, `feeScript` | 0, none | pool fee in basis points and where it goes |
| `windowMultiple` | 2 | window weight as a multiple of the template's network difficulty |
| `windowMinWeight` | 0 | window weight floor; use it alone (`windowMultiple` 0) on chains whose template difficulty swings, like testnet4 |
| `startDifficulty` | 1 | a master's first assignment (SPEC 8.4): the difficulty its shares are judged and weighed at until the coordinator's vardiff moves it |
| `vardiffSeconds` | 10 | the coordinator aims at one credited share per this many seconds per master, adjusting assignments by up to 4× a minute, never below `minDifficulty` |
| `assignmentGrace` | 120 | seconds after a new assignment during which shares under the previous one are still credited |
| `minDifficulty` | 1 | smallest share difficulty credited (ratum's convention: 1 is 2^32 hashes) |
| `minPayout` | 546 | smallest coinbase output written |
| `maxOutputs` | 512 | coinbase outputs cap; the rest is owed |
| `staleDepth` | 3 | how many heights back a share is still credited |
| `splitDelayMs` | 500 | wait after a new tip before issuing the split, so the block's own share is credited first |
| `poll` | 1 | seconds between template polls |
| `maxConnections`, `maxPerAddress` | 256, 16 | gateway sockets in all and per remote address |
| `maxMessageBytes` | 4 MiB | largest message accepted (a share carrying a full block fits) |
| `maxMessagesPerSecond` | 200 | per connection, with a burst of twice that; over it the socket is dropped |
| `helloTimeoutMs` | 15000 | a socket that sends no hello in this time is dropped |

## What it serves

| path | what |
|---|---|
| `/` | the status page |
| `/audit` | the audit page, replaying a snapshot in the browser |
| `/stats.json` | live state for the pages |
| `/pool.json` | the pool descriptor event |
| `/masters.jsonl`, `/delegations.jsonl` | masters with payout scripts; workers delegated to them |
| `/shares.jsonl`, `/shares/<id>.json` | credited shares in order; each share event |
| `/snapshots/<height>.json` | the ledger snapshot behind each split |
| `/blocks/<hash>.json` | block records |
| `/ledgers/`, `/ledgers/{window,split,owed,paid}.json`, `/ledgers/split-<height>.json` | the balances as [Web Ledgers](https://webledgers.org/) (SPEC 11) |
| `/ws` | the gateway WebSocket (SPEC 11.1); the first message is a signed hello (kind 27235, NIP-98 shape) |

## State and restarts

Everything is in the data directory as append-only files plus `owed.json` and the key. A
restart reloads them and reissues the split; gateways reconnect on their own and mine solo in
between. Two coordinators must not share one data directory.

`audit/replay.mjs --url http://host/datstr --height <h>` recomputes any snapshot from those
files and must match byte for byte; the audit page does the same in a tab.

## Not yet

JSON-LD documents in a pod, multi-chain in one mount, and the engine as an npm dependency
rather than a checkout path. The message-size limit is enforced per message after receipt;
a frame-level cap belongs to the host (JSS's websocket plugin, or a proxy in front).
