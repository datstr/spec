# datstr

A decentralized mining share network for Bitcoin and its BLAKE2b fork. Miners build
their own block templates, prove their work with Nostr-signed shares, and are paid
directly in the coinbase. No custody, no mandatory fee, and every rule a verifier
applies runs in a browser via [bitcoin-kernel](https://bitcoin-kernel.com/).

DATUM semantics, signed JSON wire, Solid documents, Nostr identity. Mining in the
browser: a coordinator is a page with a socket, and a miner can be a tab.

- [SPEC.md](SPEC.md): the protocol, draft version 0.0.1.

Planned layout, none of it written yet:

```
gateway/    getblocktemplate → coinbase → stratum v1 (classic and Sia dialect) → signed shares
plugin/     the coordinator as a JSS plugin: WebSocket for gateways, documents, audit page
audit/      browser page that replays shares through the kernel and checks the ledger
miner/      a CPU miner for the loop, so the whole thing runs without hardware
```

First target: `btc:testnet4-blake2b` with two gateways and one coordinator, per
section 13 of the spec.
