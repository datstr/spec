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
gateway/    getblocktemplate → coinbase → header; later stratum v1 (classic and Sia dialect) and signed shares
plugin/     the coordinator as a JSS plugin: WebSocket for gateways, documents, audit page   (not yet)
audit/      browser page that replays shares through the kernel and checks the ledger      (not yet)
```

`gateway/build-block.mjs` builds a block the datstr way against a local Knots node and
asks the node, in getblocktemplate proposal mode, whether it would accept it. It needs a
checkout of [bitcoin-desktop/schema](https://github.com/bitcoin-desktop/schema) for the
engine (`SCHEMA=...`), and Node 22 or later.

```sh
node gateway/build-block.mjs --conf ~/knots-testnet4/bitcoin.conf --pay <addr>[,<addr>...]
```

First target: `btc:testnet4-blake2b` with two gateways and one coordinator, per
section 13 of the spec.
