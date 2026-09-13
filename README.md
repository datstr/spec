# datstr

A decentralized mining share network for Bitcoin and its BLAKE2b fork. Miners build
their own block templates, prove their work with Nostr-signed shares, and are paid
directly in the coinbase. No custody, no mandatory fee, and every rule a verifier
applies runs in a browser via [bitcoin-kernel](https://bitcoin-kernel.com/).

DATUM semantics, signed JSON wire, Solid documents, Nostr identity. Mining in the
browser: a coordinator is a page with a socket, and a miner can be a tab.

- [SPEC.md](SPEC.md): the protocol, draft version 0.0.1.

Layout:

```
gateway/    the datstr gateway: getblocktemplate → datstr coinbase → stratum v1 (Sia dialect) → signed shares → blocks
  serve.mjs        run it against your node; --pool joins a coordinator, otherwise solo
  build-block.mjs  build one block and ask the node in proposal mode whether it is valid
  stratum.mjs      the stratum server BLAKE2b hardware and ratum's sia-test-miner speak to
  status.html      the gateway's status page, in ratum's layout, on --api
  lib/             rpc, engine, block building, targets, nostr signing, merkle, the split
  test/regtest.sh  a block mined through the gateway on a throwaway regtest
plugin/     the coordinator (SPEC 8 to 11): verifies shares, keeps the window, dictates the split
  coordinator.mjs  the core, transport-agnostic
  standalone.mjs   node:http plus the engine's WebSocket server; documents at /, gateways at /ws
  index.mjs        the same as a JSS plugin: jss start --plugin plugin/index.mjs@/datstr
  test/regtest.sh  SPEC section 13: two gateways, one coordinator, replay, solo fallback, rejoin
audit/      replay.mjs recomputes a ledger snapshot from the shares and compares it byte for byte;
            index.html does the same in a browser, with every share verified by the engine
            (served by the coordinator at /audit, and at datstr.com/spec/audit/?api=<coordinator>)
```

Needs Node 22 or later, a checkout of [bitcoin-desktop/schema](https://github.com/bitcoin-desktop/schema)
for the engine (`SCHEMA=...`, default `~/bitcoin-desktop/schema`), and a Bitcoin Knots build
with the BLAKE2b change. The regtest tests also need ratum's `sia-test-miner`
(`cargo build --release` in [iohzrd/ratum](https://github.com/iohzrd/ratum)).

```sh
node plugin/standalone.mjs --conf ~/knots-testnet4/bitcoin.conf --data ~/datstr-coordinator --port 3400
node gateway/serve.mjs --conf ~/knots-testnet4/bitcoin.conf --pay <addr> --pool ws://127.0.0.1:3400/ws
node audit/replay.mjs --url http://127.0.0.1:3400 --height <h>
plugin/test/regtest.sh              # the acceptance test from SPEC section 13
gateway/test/regtest.sh             # the gateway alone
```

First target: `btc:testnet4-blake2b` with two gateways and one coordinator, per
section 13 of the spec.
