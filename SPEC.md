# datstr — a decentralized mining share network

Status: draft 0, 13 September 2026. Nothing here is final. Field names, kinds and
document shapes are provisional until the first two gateways agree on a ledger.

datstr is a protocol, not a pool. Miners build their own block templates from their
own nodes, prove their work with signed shares, and are paid directly in the coinbase
of every block the network finds. There is no custody, no mandatory fee, and no
verification logic that does not also run in a browser tab.

The name is DATUM plus Nostr. The semantics are DATUM's. The wire is signed JSON.

## 1. Principles

1. Pools pool rewards, not blocks. The miner's node selects transactions.
2. Bitcoin consensus is the only hard validity boundary. Every check a datstr
   verifier makes is a [bitcoin-kernel](https://bitcoin-kernel.com/) rule.
3. Nostr and did:nostr provide identity, discovery, delegation and commitments.
   Relays are never consensus. Anything a relay could drop, reorder or duplicate
   must be reconstructible from signed shares alone.
4. A share is proof of work bound to a worker key. Its signed event is a receipt.
5. Accounting is a deterministic function of a share set. Two verifiers holding the
   same shares compute the same payout outputs, byte for byte.
6. Settlement is the coinbase. No block reward is ever held by anyone but the
   miners it is paid to.
7. Existing hardware works unchanged. Stratum v1 stays on the gateway's south side.
8. Infrastructure is disposable. If every coordinator disappears, a gateway falls
   back to solo work against its own node and keeps its receipts.
9. Inclusion policy is local. Fork-choice policy is out of scope, and a datstr
   verifier never refuses a share for building on a valid parent.
10. If the coordinator cannot run on an old Android phone, the protocol is
    over-engineered.

## 2. Layers

| layer | provides | this spec |
|---|---|---|
| Bitcoin (btc, xbt, and their testnet4s) | consensus, settlement | referenced |
| share network | proof-of-work accounting | sections 6 to 10 |
| Nostr / did:nostr | identity, delegation, discovery, documents | sections 4, 11 |
| market | variance transfer, claim trading | reserved, section 14 |

## 3. Roles

- **miner hardware**: ASIC or CPU miner. Speaks stratum v1 to a gateway. Unchanged.
- **gateway**: runs beside the miner's node. Polls `getblocktemplate`, builds the
  coinbase, serves stratum, checks shares locally, signs them with a worker key,
  sends them north, submits found blocks to its own node.
- **coordinator**: the north side at level 1. Verifies shares with the kernel, keeps
  the window, computes the split, tells gateways where the coinbase pays. A JSS
  plugin. At level 2 there are several and they replicate. At level 3 there are
  none. See section 12.
- **auditor**: anyone with a browser. Fetches the documents, replays the shares
  through the kernel, checks the coinbase of every block against the ledger.

## 4. Identity

Identity is a Nostr keypair, expressed as `did:nostr:<hex pubkey>`.

- **master**: the identity a miner is paid under. Signs the miner descriptor and
  delegations. Never installed on a gateway.
- **worker**: the key a gateway signs shares with. A master delegates to any number
  of workers with a signed delegation event. A worker with no delegation is its own
  master, which is fine for a hobby miner and for tests.

A **miner descriptor** (kind 33401, addressable, signed by the master) carries one
payout script per chain the miner participates in, and nothing else that affects
accounting. A verifier pays a worker's shares to the payout script of the master
that delegated it, as of the block being paid.

A **delegation** (kind 33402, addressable by the worker pubkey, signed by the
master) names the worker, the chains it may mine, and an optional expiry height per
chain. A share signed by a worker after its delegation expired is refused with
`delegation-expired`.

Delegation is the only trust relationship in the protocol, and it is one-way: a
worker cannot change where its master is paid.

## 5. Chains

| id | alias | NIP-333 code | header | proof of work | kernel |
|---|---|---|---|---|---|
| `btc:mainnet` | btc | `btc` | 80 bytes | SHA256d | base schema |
| `btc:testnet4` | tbtc | `tbtc4` | 80 bytes | SHA256d | base schema |
| `btc:mainnet-blake2b` | xbt | `btcb2` | 164 bytes | tagged SHA-256 tree, BLAKE2b-256, XOR mask | `knots-blake2b` overlay |
| `btc:testnet4-blake2b` | txbt | `tbtc4b2` | 164 bytes | as above | `knots-blake2b` overlay |

A share names its chain by `id`. A verifier that does not load the chain's kernel
schema refuses the share with `chain-unknown` rather than guessing.

The 164-byte header, its `flags` byte and the time-offset rule are documented in
[play-grounds/knots docs/header-v2.md](https://github.com/play-grounds/knots/blob/gh-pages/docs/header-v2.md)
and implemented in the kernel's `codec/pow/knots-header-v2.js`, checked against
Knots' own vectors. This spec does not restate them.

## 6. Work

The gateway polls its own node's `getblocktemplate` and builds one job per template.
No message in this protocol carries a template, a transaction list or a merkle
branch from north to south. The coordinator learns what the gateway mined only from
the share.

### 6.1 Coinbase

The coinbase is the gateway's, built to these rules so a verifier can check it:

1. Height in the scriptSig per BIP34.
2. Outputs in this order: the **split** outputs the current split message dictates
   (section 9), then the segwit commitment where the template requires one, then
   exactly one **datstr commitment** output, last.
3. The datstr commitment is a zero-value output whose script is
   `OP_RETURN <32 bytes>`, 34 bytes in all, so it fits the RDTS output-script limit
   on the BLAKE2b chains. The 32 bytes are
   `taggedHash("datstr/share", worker_pubkey || parents_root)`, where
   `parents_root` is 32 zero bytes at level 1 and the DAG parents root at level 3.
   This binds the proof of work to the worker key: a share cannot be re-signed by
   another key, and a stolen block cannot be re-credited.
4. No other output. A gateway that wants a donation adds it to its own payout
   script, not to the coinbase.

The split outputs pay the value the template makes available: subsidy plus fees. A
gateway that mines a lower-fee template than its peers pays out less in the block it
finds, and section 9.4 says how the window accounts for that.

### 6.2 Header

SHA256d chains: the classic 80-byte header. The gateway serves `coinb1`, `coinb2`
and merkle branches over stratum as every pool does.

BLAKE2b chains: the 164-byte header. The ASIC never sees the coinbase. It receives
the fixed 35-byte `coinb1` (three zero bytes and H2, the commitment to the header's
first stage) and rolls the 16-byte extranonce, the nonces and the time offset. The
gateway's job commits to the coinbase through the merkle root and H2, and the share
carries enough for a verifier to rebuild both.

## 7. Stratum

The gateway's south side is stratum v1, unchanged:

- SHA256d chains: `mining.subscribe`, `mining.authorize`, `mining.notify`,
  `mining.set_difficulty`, `mining.submit`, `mining.configure` for version rolling.
- BLAKE2b chains: the Siacoin dialect the CONVOY and ratum gateways serve, with
  8-byte `ntime` and `nonce` fields whose halves map onto the v2 header's time
  offset and nonce fields.

The stratum username is a lookup, not an identity. A gateway maps it to a worker
key it holds. The conventional `<payout address>.<rig>` form still works: a gateway
run by someone for miners who bring only an address (a public gateway) creates a
worker per address and delegates nothing, so that miner is paid at that address and
the gateway's own key never appears in their shares.

Vardiff, duplicate detection and the share target are the gateway's. The coordinator
sets a floor (section 11, `minDifficulty`) below which it credits nothing.

## 8. Share

A share is a Nostr event of kind 23400, signed by the worker key. Its content is
canonical JSON with these fields:

| field | type | meaning |
|---|---|---|
| `chain` | string | chain id, section 5 |
| `height` | integer | the height the share mines |
| `header` | hex | full header bytes, 80 or 164 |
| `coinbase` | hex | full coinbase transaction |
| `branches` | hex[] | merkle branches from the coinbase to the root, as the stratum job carried them |
| `target` | hex | the share target the gateway checked against, 32 bytes |
| `split` | string | event id of the split message the coinbase follows, or `solo` |
| `parents` | string[] | DAG parents, empty at level 1 |
| `job` | string | gateway-local job id, informational |

The event's tags carry `["chain", id]`, `["h", height]` and `["split", id]` so
relays and coordinators can filter without decoding content.

### 8.1 Verification

A verifier accepts a share when every step passes, in this order, and refuses it
with the named code otherwise:

1. `sig`: NIP-01 id and BIP-340 signature verify (`verifyNostrEvent`).
2. `delegation-expired`, `delegation-missing`: the worker has a live delegation for
   the chain, or is its own master with a miner descriptor.
3. `chain-unknown`: the chain's kernel schema is loaded.
4. `header-decode`: the header decodes under the chain's schema.
5. `stale`: `height` and the header's `prevBlockHash` match a block the verifier
   knows within the stale window (section 11, `staleDepth`).
6. `coinbase-decode`, `coinbase-height`: the coinbase decodes and commits to
   `height`.
7. `merkle`: the coinbase and `branches` reproduce the header's merkle root. On the
   BLAKE2b chains this also reproduces H2 and the `coinb1` the ASIC hashed.
8. `commitment`: the last output is the datstr commitment for this worker and
   `parents`.
9. `split`: the outputs before it are exactly the split message's outputs, or the
   share names `solo` and the coinbase pays only the worker's master, or the split
   is stale by more than `splitGrace` seconds and the previous split matches.
10. `pow`: the kernel's proof-of-work rule at `target` instead of the network
    target. This is the one kernel variant this spec needs.
11. `difficulty-floor`: `target` is at or below the coordinator's `minDifficulty`.
12. `duplicate`: the header hash has not been credited before.

A share whose header also meets the network target is a **block**. The gateway has
already submitted it to its own node before signing the share. The verifier relays
it to its own node as well, and records a block document (section 11).

### 8.2 Weight

A credited share weighs `difficulty(target)`, the same function the chain uses for
chainwork, so weights across vardiff levels are comparable and the window is a sum.

### 8.3 Acknowledgement

A coordinator answers each share with an ack event, kind 23401, signed by its key,
whose content is `{ share: <event id>, result: "ok" | <code>, weight: <n> }`. The
gateway keeps every ack. A share the coordinator acked `ok` and later left out of a
ledger snapshot is provable with the share event and the ack alone.

## 9. Split

The split is the coordinator's only instruction to the gateway, and it is the same
thing DATUM's coinbaser sends: the list of outputs a coinbase must pay.

### 9.1 Window

The window is the most recent credited shares on the chain whose weights sum to at
least `windowMultiple × networkDifficulty` at the current tip, oldest dropped first.
`windowMultiple` is in the pool descriptor. A share leaves the window by weight, not
by time, so a miner's expected reward does not depend on when the block lands.

### 9.2 Outputs

For a template of value `V` (subsidy plus fees, as the gateway's own template
reports it), the split is computed as:

1. Group the window's shares by the master key their worker was delegated to when
   each was credited. Sum weights per master, `w_i`, and the total `W`.
2. `fee = V × feeBps / 10000` to the pool descriptor's fee script. Zero by default.
   `R = V − fee`.
3. `pay_i = floor(R × w_i / W)`.
4. Drop every `pay_i` below `minPayout`. Redistribute their sum over the remaining
   masters in the same proportion, once. Their weight stays in the window.
5. Order by `pay_i` descending, then by master pubkey ascending. Keep the first
   `maxOutputs` (512, the DATUM coinbaser cap). Every master beyond that is
   **owed** `pay_i` and is paid first from the next block, before the window split,
   until cleared.
6. Rounding dust goes to the first output.

Two verifiers with the same window and descriptor produce the same output list.
That is the test in section 13.

### 9.3 Message

A split is an event of kind 23403 from the coordinator:
`{ chain, height, outputs: [[script hex, sats]...], window: { from, to, weight },
owed: [[master, sats]...] }`. The gateway includes it in its next job and names its
id in every share. A split is per height, not per template: a gateway whose template
value differs from the value the outputs sum to scales the outputs proportionally
before building the coinbase, keeping order, and the verifier checks the scaled
list. This is what lets every gateway keep its own transaction selection.

### 9.4 Template value

A share carries its coinbase, so a verifier knows the value of every template the
window mined. The default weight is proof of work alone. A pool descriptor may set
`valueWeighted: true`, in which case a share's weight is scaled by its template
value over the window's median template value. The gateway that mines a low-fee
template then bears the cost of that choice rather than the window. This is an
option, not a default, so a policy disagreement never becomes a refusal.

## 10. Anti-withholding

On the BLAKE2b chains the header carries a 16-byte `xorKey` and a
`xorKeyMaskClearBits` parameter. A coordinator may issue an **assignment** event,
kind 23402, that fixes the key material a gateway must use for a range of heights,
so the machine hashing cannot tell a share from a block. The gateway commits to the
assignment through the header itself, so no extra field is needed in the share.
This section does what DATUM v3's slots do, without the proofs, since the verifier
relays every block anyway.

On the SHA256d chains there is no equivalent and this spec offers none. Statistical
detection and reputation are out of scope.

## 11. Documents

Everything a coordinator knows is a document anyone can fetch. They are JSON-LD,
served from a Solid pod under the coordinator's mount prefix, and each is also a
signed addressable Nostr event so it can be replicated by relays. The `@context` is
this repository's `context.jsonld`.

| kind | document | signed by | keyed by | holds |
|---|---|---|---|---|
| 33400 | pool descriptor | coordinator | chain | fee script, `feeBps`, `windowMultiple`, `minDifficulty`, `minPayout`, `maxOutputs`, `staleDepth`, `splitGrace`, `valueWeighted`, endpoints |
| 33401 | miner descriptor | master | master | payout script per chain |
| 33402 | delegation | master | worker | chains, expiry heights |
| 33404 | ledger snapshot | coordinator | chain and height | the window at that height: share ids, weights, per-master sums, the split it produced, owed |
| 33405 | block record | coordinator | chain and hash | share id, header, coinbase txid, confirmation depth or `orphaned`, whether the split was honoured |

A ledger snapshot is written at every block found and every `snapshotInterval`
shares between blocks. The shares themselves are served under `/shares/<id>` for
as long as the window and `staleDepth` need them, and a gateway keeps its own.

A coordinator's mount is a [JSS](https://jss.live/) plugin: `activate(api)` registers
the WebSocket route for gateways, the document routes, and the audit page. The
private plugin directory holds the share store. Nothing else is stateful.

## 12. Levels

The share format does not change between levels. Only who verifies it does.

- **Level 1, coordinator.** One coordinator per pool. Gateways connect to it. It is
  the trust point for the ledger, and every document it writes is auditable. This
  is the testnet PoC and the first mainnet pool.
- **Level 2, federation.** Several coordinators share a pool descriptor and replay
  each other's acked shares over relays or a direct link. A gateway may switch
  coordinators with its receipts and lose nothing. If one coordinator vanishes the
  others hold the same window and pay the same split.
- **Level 3, share DAG.** No coordinator. `parents` names the tips a gateway saw,
  the commitment output binds the parents into the proof of work, and the window is
  computed over the heaviest DAG by every gateway itself. The split message becomes
  a deterministic function every gateway evaluates. This is P2Pool and Braidpool
  territory, reserved here so that nothing in levels 1 and 2 forecloses it.

## 13. Acceptance test

The protocol exists when this passes, on `btc:testnet4-blake2b` first:

1. Two nodes, two gateways, two worker keys delegated from two masters, one
   coordinator, one CPU miner each.
2. Both gateways mine their own templates. The templates differ.
3. The coordinator credits shares from both. A second, independent verifier, in a
   browser, replays the same shares and computes the same ledger snapshot, byte for
   byte.
4. A block is found by either gateway. Its coinbase matches the split the snapshot
   produced. The block confirms.
5. The coordinator is stopped. Both gateways continue solo against their own
   nodes. The coordinator restarts and the window is unchanged.

Then the same on `btc:testnet4`, then mainnet.

## 14. Reserved

Named so that the format leaves room, and otherwise not part of this spec:

- **policy manifest**, kind 33410: what a miner will include in its own templates.
  Informational. A verifier never reads it.
- **cohort**, kind 33411: a voluntary payout group sharing a pool descriptor.
- **claim**, kind 33412: a master's signed statement of its shares in a window,
  the thing a market could price. Nothing in this spec transfers one.
- **market bid and ask**: not specified.
- **ancestry penalty, fork-choice policy**: explicitly not this spec. A datstr
  verifier builds on the best valid chain its node reports and refuses no share on
  the grounds of what its parent contained.

## 15. Compatibility

- **Stratum**: fully. Anything that mines to a ratum or CONVOY gateway mines to a
  datstr gateway. The work an ASIC sees is fixed by the header, not by this spec.
- **DATUM**: same semantics, different wire. An adapter that speaks the DATUM
  session to a stock gateway and datstr to a coordinator is a lossless translation
  except for the encrypted session and the v3 withholding proofs, which it
  terminates itself. It holds a pool keypair the gateway operator pins, so it is a
  trusted component, offered by whoever wants to provide that on-ramp. Not part of
  the core.
- **NIP-333**: coordinators publish found blocks on the chain's header stream.
  Gateways may use the stream as a block notification source beside their node.

## 16. Threats

- **Block withholding**: mitigated on BLAKE2b chains by section 10. Open on SHA256d.
- **Share theft**: a share is bound to a worker key by the commitment output and
  signed by it. Replaying someone else's share credits nobody.
- **Sybil**: identities are free and worthless. Weight is proof of work.
- **Coordinator dishonesty**: every credit is an ack the gateway keeps, every split
  is in the block, every snapshot is replayable. A dishonest coordinator is
  provably so, and at level 2 replaceable.
- **Relay censorship**: relays carry documents, never the ledger's source of truth.
- **Double-selling claims**: out of scope with the market.
- **Bad templates**: a gateway's node validates them. A coordinator refuses a share
  whose coinbase does not decode, and cannot see the rest of the block, which is
  the point.

## Appendix A. Event kinds

Provisional. All in ranges NIP-01 reserves for ephemeral (2xxxx) and addressable
(3xxxx) events.

| kind | name | class |
|---|---|---|
| 23400 | share | ephemeral |
| 23401 | ack | ephemeral |
| 23402 | assignment | ephemeral |
| 23403 | split | ephemeral |
| 33400 | pool descriptor | addressable, `d` = chain |
| 33401 | miner descriptor | addressable, `d` = master |
| 33402 | delegation | addressable, `d` = worker |
| 33404 | ledger snapshot | addressable, `d` = chain:height |
| 33405 | block record | addressable, `d` = chain:hash |
| 33410 to 33412 | reserved, section 14 | addressable |

## Appendix B. Prior art

- [DATUM](https://github.com/CONVOYMining/datum_gateway) and
  [ratum](https://github.com/iohzrd/ratum): miner-built templates, pool-dictated
  coinbase, owed blocks. datstr keeps the model and drops the wire.
- P2Pool and Braidpool: share chains and DAGs. Level 3.
- Stratum v2 job declaration: the same goal on a different wire.
- [bitcoin-kernel](https://bitcoin-kernel.com/): every rule a verifier applies.
- [JSS](https://jss.live/): the coordinator's host.
- [NIP-333](https://nip-333.github.io/): headers over Nostr.
