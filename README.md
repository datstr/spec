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
gateway/    the datstr gateway: getblocktemplate → datstr coinbase → stratum v1 (Sia dialect) → blocks
  serve.mjs        run it against your node; no coordinator yet, the split is the addresses you give
  build-block.mjs  build one block and ask the node in proposal mode whether it is valid
  stratum.mjs      the stratum server BLAKE2b hardware and ratum's sia-test-miner speak to
  lib/             rpc, engine loading, block building, targets
  test/regtest.sh  mine blocks through the whole thing on a throwaway regtest
plugin/     the coordinator as a JSS plugin: WebSocket for gateways, documents, audit page   (not yet)
audit/      browser page that replays shares through the kernel and checks the ledger      (not yet)
```

The gateway needs Node 22 or later, a checkout of
[bitcoin-desktop/schema](https://github.com/bitcoin-desktop/schema) for the engine
(`SCHEMA=...`, default `~/bitcoin-desktop/schema`), and a Bitcoin Knots build with the
BLAKE2b change. The regtest test also needs ratum's `sia-test-miner`
(`cargo build --release` in [iohzrd/ratum](https://github.com/iohzrd/ratum)).

```sh
node gateway/serve.mjs --conf ~/knots-testnet4/bitcoin.conf --pay <addr>[,<addr>...] --port 3333
node gateway/build-block.mjs --conf ~/knots-testnet4/bitcoin.conf --pay <addr>
gateway/test/regtest.sh            # a 164-byte block mined by sia-test-miner through the gateway
```

First target: `btc:testnet4-blake2b` with two gateways and one coordinator, per
section 13 of the spec.
