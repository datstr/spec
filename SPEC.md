# datstr — a decentralized mining share network

Version: 0.0.1, draft, 13 September 2026, revised the same evening from the first
implementation: a gateway, a coordinator and two miners agreeing on a ledger on regtest, and a
gateway mining blocks on testnet4. Nothing here is final. Field names, kinds and document
shapes are provisional.

datstr is a protocol, not a pool. Miners build their own block templates from their
own nodes, prove their work with signed shares, and are paid directly in the coinbase
of every block the network finds. There is no custody, no mandatory fee, and no
verification logic that does not also run in a browser tab.

The name is DATUM plus Nostr, and reads as Decentralized Alternative Templates and Shares
Transmitted by Relays: the template never leaves the miner, and a share is a signed event a
relay can carry unchanged. The semantics are DATUM's, on purpose: DATUM showed
that a miner's own node can build the block while the pool only coordinates the
reward, and datstr wants its gateways, its operators and its miners to feel at home.
The wire north of the gateway is signed JSON, and a whole pool, mining included, runs
in a browser.

## 1. Principles

1. Pools pool rewards, not blocks. The miner's node selects transactions.
2. A block is valid when the miner's own node accepts it, policy included. A datstr
   verifier checks what it can see, the header, the coinbase and the proof of work,
   and every check it makes is a [bitcoin-kernel](https://bitcoin-kernel.com/) rule.
3. Nostr and [did:nostr](https://did-nostr.com/) provide identity, discovery, delegation and commitments.
   Relays are never the source of truth. Anything a relay could drop, reorder or duplicate
   must be reconstructible from signed shares alone.
4. A share is proof of work bound to a worker key. Its signed event is a receipt.
5. Accounting is a deterministic function of a share set. Two verifiers holding the
   same shares compute the same payout outputs, byte for byte.
6. Settlement is the coinbase. No block reward is ever held by anyone but the
   miners it is paid to.
7. Existing hardware works unchanged. Stratum v1 stays on the gateway's south side.
8. Infrastructure is disposable. If every coordinator disappears, a gateway falls
   back to solo work against its own node and keeps its receipts.
9. Standardness is the default, not a filter the network imposes. A gateway builds
   from its own node's mempool, so the node's policy shapes every template: Knots'
   on the BLAKE2b chains, which is stricter than Core's and aimed at a monetary
   Bitcoin. A cohort may hold its members to a declared policy on the blocks they
   find. Fork-choice policy is out of scope, and a verifier never refuses a share for
   what its parent contained.
10. If the coordinator cannot run on an old Android phone, the protocol is
    over-engineered.
11. Friendly to DATUM. The model is DATUM's, the terms are DATUM's where they fit,
    a DATUM gateway is one adapter away from a datstr coordinator, and nothing here
    competes with a DATUM pool for a miner's hashrate that would rather stay there.
12. The browser is a full participant. It can audit the ledger, and it can mine: the
    kernel's miner plus a WebSocket to a coordinator is a miner in a tab, and a
    coordinator is a page with a socket.

## 2. Layers

| layer | provides | this spec |
|---|---|---|
| Bitcoin (btc, xbt, and their testnet4s) | validity, settlement | referenced |
| share network | proof-of-work accounting | sections 6 to 10 |
| Nostr / [did:nostr](https://did-nostr.com/) | identity, delegation, discovery, documents | sections 4, 11 |
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
- **browser miner**: a page that builds jobs from a template source, hashes with the
  kernel's miner, and sends shares over the same WebSocket a gateway uses. Slow, and
  the fastest way to see the whole loop work.

## 4. Identity

Identity is a Nostr keypair, expressed as [`did:nostr:<hex pubkey>`](https://did-nostr.com/).

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
chain: tags `["d", worker]`, `["chain", id]`, `["p", master]`, content
`{ master, worker, chains: { <chain id>: { expires: <height or null> } } }`. A share signed
by a worker after its delegation expired is refused with `delegation-expired`. The gateway
presents the descriptor and the delegation at hello (section 11.1) and holds only the
worker key; `gateway/delegate.mjs` produces both where the master key lives.

Delegation is the only trust relationship in the protocol, and it is one-way: a
worker cannot change where its master is paid.

## 5. Chains

| id | alias | NIP-333 code | header | proof of work | kernel |
|---|---|---|---|---|---|
| `btc:mainnet` | btc | `btc` | 80 bytes | SHA256d | base schema |
| `btc:testnet4` | tbtc4 | `tbtc4` | 80 bytes | SHA256d | base schema |
| `btc:mainnet-blake2b` | xbt | `btcb2` | 164 bytes | tagged SHA-256 tree, BLAKE2b-256, XOR mask | `knots-blake2b` overlay |
| `btc:testnet4-blake2b` | xbt4 | `tbtc4b2` | 164 bytes | as above | `knots-blake2b` overlay |

A share names its chain by `id`. The alias is the short form for configuration,
URLs and stratum usernames: `btc`, `tbtc4`, `xbt`, `xbt4`, and the same pattern for
any chain added later. A verifier that does not load the chain's kernel schema
refuses the share with `chain-unknown` rather than guessing.

The 164-byte header, its `flags` byte and the time-offset rule are documented in
[play-grounds/knots docs/header-v2.md](https://github.com/play-grounds/knots/blob/gh-pages/docs/header-v2.md)
and implemented in the kernel's `codec/pow/knots-header-v2.js`, checked against
Knots' own vectors. This spec does not restate them.

## 6. Work

The gateway polls its own node's `getblocktemplate` and builds one job per template.
No message in this protocol carries a template, a transaction list or a merkle
branch from north to south. The coordinator learns what the gateway mined only from
the share.

The template is the node's, and the node's policy is the miner's policy. A
transaction the node would not relay does not reach the template, so a datstr
network of Knots nodes mines to Knots standardness without any rule in this spec
saying so. During RDTS on the BLAKE2b chains part of that policy is a block rule,
the 800,000 weight limit and the 34-byte output script limit, and the kernel
applies it as one. A miner who wants something else changes their node, and
section 14 is where a cohort says what it expects of its members.

### 6.1 Coinbase

The coinbase is the gateway's, built to these rules so a verifier can check it:

1. Height in the scriptSig per BIP34, then a 4-byte push the gateway may use as extra nonce
   space (zero on the BLAKE2b chains, where the header carries the extranonce).
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
- BLAKE2b chains: the Siacoin dialect the CONVOY and ratum gateways serve. Subscribe answers
  an 8-byte extranonce1 and extranonce2 size 8, which together fill the header's 16-byte
  extranonce. A notify carries the 35-byte `coinb1` (three zero bytes and H2), an empty
  `coinb2`, no merkle branches, the hidden previous block and an 8-byte ntime field. A
  submit carries extranonce2, the ntime field and an 8-byte nonce field. The two 8-byte
  fields are pairs of little-endian u32: nonce is (nonce, nonce2), ntime is (timeOffset,
  nonce3).

The stratum username is a lookup, not an identity. A gateway maps it to a worker key it
holds. The conventional `<payout address>.<rig>` form still works: a gateway run by someone
for miners who bring only an address (a public gateway) creates a worker per address and
delegates nothing, so that miner is paid at that address and the gateway's own key never
appears in their shares. The worker key is derived, `taggedHash("datstr/worker", gatewayKey ‖
"addr:" ‖ chain ‖ ":" ‖ address)`, so a restart derives the same one, and the descriptor it
signs for itself carries the address's script. A username that is not an address mines as
the gateway's own identity.

A client with a Nostr key of its own (a browser tab logged in with xlogin, say) can be its
own master over stratum with two extra methods. `mining.datstr_worker` `[master, address]`
answers `{ worker, chain, payout }`: the worker pubkey the gateway derives for that master,
`taggedHash("datstr/worker", gatewayKey ‖ "master:" ‖ chain ‖ ":" ‖ master)`, and the
address's script. The client signs a miner descriptor (kind 33401) with that payout and a
delegation (kind 33402) to that worker, and sends both with `mining.datstr_identity`
`[descriptor, delegation]`. From then on its shares are signed by the derived worker and
credited to its master, its coinbase commits to that worker, and the coinbase pays its
address. The gateway registers every such identity with the coordinator over the same
socket (`register`, section 11.1).

Because the commitment output names the worker, a gateway builds one coinbase per identity
from the same template, and a client's job changes when its identity does.

**Difficulty is per connection.** Difficulty 1 means a share is expected every 2^32 hashes,
ratum's convention, and a difficulty's target is 2^224 divided by it, compared big-endian
against the display-order bytes of the proof-of-work hash. Every miner starts at the
gateway's default, then vardiff moves it so a share arrives about every `vardiffTarget`
seconds (10 by default) within `[vardiffMin, vardiffMax]`, by at most a factor of four per
step. A miner pins its own with `d=<n>` in the password or after a comma in the username, or
with `mining.suggest_difficulty`. A change is delivered as `mining.set_difficulty` followed
by the current job re-sent under a new job id, so a job id names one difficulty and a share
is judged at the difficulty its job was sent at. The clock behind vardiff stops while the
gateway serves no work.

A gateway may serve no work while it waits: above a configured `stopHeight`, or briefly for
a coordinator's split (section 9.3). Miners stay connected and receive the next job when
work resumes. A gateway does not hold work outside a chain's minimum-difficulty window:
miners never idle, so a hold only makes their shares stale, whereas work on the current tip
at its real difficulty is proof of work the coordinator credits like any other.

## 8. Share

A share is a Nostr event of kind 23400, signed by the worker key. Its content is JSON with
these fields:

| field | type | meaning |
|---|---|---|
| `chain` | string | chain id, section 5 |
| `height` | integer | the height the share mines |
| `header` | hex | full header bytes, 80 or 164 |
| `coinbase` | hex | full coinbase transaction, witness included |
| `branches` | hex[] | merkle branches from the coinbase to the root, display-order txids |
| `target` | hex | the share target the gateway judged it at, 32 bytes big-endian |
| `split` | string | event id of the split message the coinbase follows, or `solo` |
| `parents` | string[] | DAG parents, empty at level 1 |
| `job` | string | gateway-local job id, informational |
| `block` | hex | the full block, present only when the header also meets the network target |

The event's tags carry `["chain", id]`, `["h", height]` and `["split", id]` so relays and
coordinators can filter without decoding content.

### 8.1 Verification

A verifier accepts a share when every step passes, in this order, and refuses it with the
named code otherwise:

1. `sig`: NIP-01 id and BIP-340 signature verify. `content`: the content parses.
2. `delegation-missing`, `delegation-expired`: the worker has a miner descriptor (a worker
   with none is its own master) or a live delegation for the chain.
3. `chain-unknown`: the chain's kernel schema is loaded.
4. `header-decode`: the header decodes under the chain's schema and commits to `height`.
5. `stale`: `height` is at most the verifier's next height and within `staleDepth` of it,
   and the header's previous block is the block the verifier knows at `height - 1`.
6. `coinbase-decode`, `coinbase-height`: the coinbase decodes and its BIP34 height is `height`.
7. `merkle`: the coinbase txid and `branches` reproduce the header's merkle root. On the
   BLAKE2b chains this also fixes H2 and so the `coinb1` the machine hashed.
8. `commitment`: the last output is the datstr commitment for this worker and `parents`.
9. `split`: the outputs before it, less a witness commitment if present, are exactly the
   named split's outputs scaled to their sum (section 9.3), for a split the verifier issued
   for this height and still holds; or the share names `solo` and the single output pays the
   worker's master.
10. `pow`: the proof-of-work hash, before the XOR mask, is at or below `target`.
11. `difficulty-floor`: `2^224 / target` is at least the pool's `minDifficulty`.
12. `duplicate`: the block hash has not been credited before.

A share whose masked hash also meets the network target is a **block**. The gateway has
already submitted it to its own node before signing the share, and the share carries the
full block so the verifier submits it to its own node as well, then records a block document
(section 11). A block at a height whose split the verifier holds applies that split's owed
balances (section 9.2).

### 8.2 Weight

A credited share weighs `difficulty(target)`, the same function the chain uses for
chainwork, so weights across vardiff levels are comparable and the window is a sum.

### 8.3 Acknowledgement

A coordinator answers each share with an ack event, kind 23401, signed by its key, tagged
`["e", <share id>]`, whose content is `{ share, result: "ok" | <code>, detail, weight, seq }`.
`seq` is the share's position in the coordinator's credit order, which the ledger snapshots
refer to. The gateway keeps every ack. A share the coordinator acked `ok` and later left out
of a ledger snapshot is provable with the share event and the ack alone.

## 9. Split

The split is the coordinator's only instruction to the gateway, and it is the same
thing DATUM's coinbaser sends: the list of outputs a coinbase must pay.

### 9.1 Window

The window is the most recent credited shares, in credit order, whose weights sum to at
least `need = max(windowMultiple × D, windowMinWeight)`, oldest dropped first, where `D` is
the network difficulty of the coordinator's current template in the same units as share
weight. When fewer shares exist than `need`, the window is every share. A share leaves the
window by weight, not by time, so a miner's expected reward does not depend on when the
block lands.

On a chain whose template difficulty swings between a floor and the real value, such as
testnet4 with its twenty-minute minimum-difficulty rule, `windowMultiple × D` is
meaningless and the descriptor sets `windowMultiple` to 0 and sizes the window with
`windowMinWeight` alone.

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

Owed balances change only when a block uses a split: the split's "owed after" becomes the
pool's owed state when a block at that height is credited, not when the split is issued, so
a split that no block used leaves nothing behind.

Two verifiers with the same window and descriptor produce the same output list. That is the
test in section 13, and `gateway/lib/split.mjs` is the function both sides call.

### 9.3 Message

A split is an event of kind 23403 from the coordinator, tagged `["chain", id]` and
`["h", height]`, with content
`{ chain, height, outputs: [[scriptPubKey hex, sats]...], window: { from, to, weight, need },
owed: [[master, sats]...] }`, where `from` and `to` are the `seq` of the first and last share
in the window. The coordinator issues one for the next height `splitDelay` seconds (0.5 by
default) after it sees a new tip, so the share that found the block is credited first, and
sends it to every connected gateway and to any gateway that connects later.

A gateway checks a split before following it, since the split is the one instruction it
takes from outside: if the gateway's own shares fall inside the split's window (by `seq`)
and the outputs pay its master nothing, or if any output pays a script no master has
registered (the coordinator's `/masters.jsonl`), the gateway refuses the split and mines
solo for that height. A coordinator that lies about the split therefore loses the hashrate,
not the miner's block.

A gateway includes the split in its next job and names its id in every share. A gateway
that has just seen a new tip but no split for it yet waits up to `splitWait` seconds (3 by
default) before it publishes solo work, and rebuilds its job as soon as the split arrives.

A split is per height, not per template: a gateway whose template value `V` differs from
the value the outputs sum to scales every output to `floor(value × V / sum)`, keeping order,
and adds the rounding remainder to the first output. The verifier recomputes the same list
from the split and the coinbase's own sum and compares byte for byte. This is what lets
every gateway keep its own transaction selection.

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

Everything a coordinator knows is a document anyone can fetch. Today they are plain JSON
served by the coordinator, each signed Nostr event carried whole; the JSON-LD context and
the pod layout come in a later revision, and the JSON below is what the context will
describe. Kinds 33404 and 33405 are reserved for the snapshot and block record as events.

| path | document | holds |
|---|---|---|
| `/pool.json` | pool descriptor, kind 33400, signed by the coordinator | every parameter in section 9 and the endpoints |
| `/masters.jsonl` | one line per master | pubkey, payout script, the miner descriptor event |
| `/shares.jsonl` | one line per credited share, in credit order | `seq`, event id, master, weight, height, block hash, split id, time |
| `/shares/<id>.json` | the share event itself | section 8 |
| `/snapshots/<height>.json` | ledger snapshot | the split's id and outputs, `sharesUpTo` (the `seq` the window was computed from), the window's shares and weight and `need`, weight per master, the template value, owed before and after |
| `/blocks/<hash>.json` | block record | height, hash, share id, master, coinbase txid, split id, the node's relay answer, whether it is on the chain |
| `/stats.json` | live state | for the coordinator's page |

A snapshot is written whenever a split is issued, which is at every new tip. Its
`sharesUpTo` makes it reproducible: the first that many lines of `/shares.jsonl`, the
descriptor and the masters file are enough to recompute the window and the split, which is
what `audit/replay.mjs` and the audit page do.

A miner descriptor, kind 33401, is tagged `["d", <master pubkey>]` and `["chain", id]` and its
content is `{ chain, payout: { <chain id>: <scriptPubKey hex> } }`.

### 11.1 Transport

A gateway talks to a coordinator over one WebSocket carrying JSON messages, each with a
`type`:

| from | type | fields |
|---|---|---|
| gateway | `hello` | `descriptor`: the miner descriptor event; `delegation`: the delegation event when the signer is a worker; `agent`: software and version |
| coordinator | `welcome` | `pool`: the pool descriptor event; `split`: the current split event or null |
| coordinator | `split` | `event`: a split (section 9.3) |
| gateway | `register` | `descriptor` and optional `delegation` for another identity the gateway mines for (section 7); answered with `registered` |
| gateway | `share` | `event`: a share (section 8) |
| coordinator | `ack` | `event`: an ack (section 8.3) |
| either | `error` | `error`: text |

A gateway that loses the socket goes solo at once, keeps its receipts, reconnects with
backoff, and sends `hello` again. Nothing else is stateful on the wire.

A coordinator's mount is a [JSS](https://jss.live/) plugin: `activate(api)` registers the
WebSocket route for gateways, the document routes and the pages, and the plugin directory
holds the files above. The same core runs standalone on a plain HTTP server.

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

The protocol exists when this passes. It passes on regtest (`plugin/test/regtest.sh`, 13
September 2026); on `btc:testnet4-blake2b` a coordinator and two gateways are live and the
first pooled block is awaited:

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
  Informational in this draft.
- **cohort**, kind 33411: a voluntary payout group sharing a pool descriptor and a
  declared policy, held to it on the blocks its members find. The check and the
  penalty are not yet specified; the verifier cannot see undisclosed templates, so
  whatever they become they apply to found blocks, never to shares.
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
- **Bad templates**: a gateway's node validates them and applies its policy. A
  coordinator refuses a share whose coinbase does not decode, and cannot see the
  rest of the block, which is the point.

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
  coinbase, owed blocks. datstr keeps the model, borrows the terms, and speaks
  signed JSON north of the gateway. With thanks.
- P2Pool and Braidpool: share chains and DAGs. Level 3.
- Stratum v2 job declaration: the same goal on a different wire.
- [bitcoin-kernel](https://bitcoin-kernel.com/): every rule a verifier applies.
- [JSS](https://jss.live/): the coordinator's host.
- [NIP-333](https://nip-333.github.io/): headers over Nostr.
