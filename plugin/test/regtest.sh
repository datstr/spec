#!/usr/bin/env bash
# SPEC.md section 13 on a throwaway regtest: one coordinator, two gateways with their own worker
# keys and payout addresses, two CPU miners. Passes when a block's coinbase pays both masters
# per the coordinator's split, an independent replay of the snapshot matches byte for byte,
# and the gateways keep mining solo while the coordinator is down and rejoin when it returns.
#
#   plugin/test/regtest.sh [--keep]
#   BITCOIND, BITCOIN_CLI, SIA_TEST_MINER, TIMEOUT (default 400), BLOCKS (pooled blocks, default 6)
set -euo pipefail
BITCOIND=${BITCOIND:-$HOME/bitcoin-knots/src/build/bin/bitcoind}
BITCOIN_CLI=${BITCOIN_CLI:-$HOME/bitcoin-knots/src/build/bin/bitcoin-cli}
SIA_TEST_MINER=${SIA_TEST_MINER:-$HOME/remote/github.com/iohzrd/ratum/target/release/sia-test-miner}
TIMEOUT=${TIMEOUT:-400}; BLOCKS=${BLOCKS:-6}; KEEP=0; [ "${1:-}" = "--keep" ] && KEEP=1
ACTIVATION=20; HEADLINE="datstr e2e headline"
PAY_A=bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080; PAY_B=bcrt1qzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3lgth6c
KEY_A=1111111111111111111111111111111111111111111111111111111111111111; KEY_B=2222222222222222222222222222222222222222222222222222222222222222
HERE=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/datstr-pool-XXXXXX"); PIDS=()
step() { printf '\n=== %s\n' "$*"; }
fail() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }
cli() { "$BITCOIN_CLI" -datadir="$WORK/node" "$@"; }
cleanup() { s=$?; for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; cli stop >/dev/null 2>&1 || true; sleep 1; if [ $KEEP = 1 ]; then echo "logs kept in $WORK"; else rm -rf "$WORK"; fi; exit $s; }
trap cleanup EXIT
port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
RPC_PORT=$(port); CO_PORT=$(port); ST_A=$(port); ST_B=$(port); API_A=$(port); API_B=$(port)
waitfor() { local f=$1 pat=$2 n=${3:-60}; for _ in $(seq $n); do grep -q "$pat" "$f" 2>/dev/null && return 0; sleep 0.5; done; return 1; }

step "regtest node, BLAKE2b at height $ACTIVATION"
mkdir -p "$WORK/node"
printf 'regtest=1\nserver=1\nlisten=0\nrpcuser=datstr\nrpcpassword=datstrtest\ndatadir=%s\n[regtest]\nrpcbind=127.0.0.1\nrpcport=%s\ntestactivationheight=blake2b@%s\nblake2b_headline=%s\n' "$WORK/node" "$RPC_PORT" "$ACTIVATION" "$HEADLINE" > "$WORK/node/bitcoin.conf"
"$BITCOIND" -datadir="$WORK/node" > "$WORK/bitcoind.log" 2>&1 & PIDS+=($!)
for _ in $(seq 60); do cli getblockchaininfo >/dev/null 2>&1 && break; sleep 0.5; done
cli generatetoaddress "$ACTIVATION" "$PAY_A" >/dev/null
COMMON=(--conf "$WORK/node/bitcoin.conf" --network btc:regtest-blake2b --activation $ACTIVATION --headline "$HEADLINE")

step "coordinator on port $CO_PORT (window at least 4 shares)"
start_co() { node "$HERE/plugin/standalone.mjs" "${COMMON[@]}" --data "$WORK/co" --port "$CO_PORT" --window-min-weight 4 >> "$WORK/co.log" 2>&1 & CO_PID=$!; PIDS+=($CO_PID); }
start_co
waitfor "$WORK/co.log" 'coordinator: ws' || { cat "$WORK/co.log"; fail "coordinator did not start"; }

step "a master key for B, delegating to B's worker key (made off the gateway)"
node "$HERE/gateway/delegate.mjs" --new-master --out "$WORK/master-b" | sed 's/^/  /'
WORKER_B=$(node -e "import('$HERE/gateway/lib/nostr.mjs').then(m => console.log(m.pubkeyOf('$KEY_B')))")
node "$HERE/gateway/delegate.mjs" --master-key-file "$WORK/master-b/master.key" --worker "$WORKER_B" --chain btc:regtest-blake2b --activation $ACTIVATION --pay $PAY_B --out "$WORK/master-b" | sed 's/^/  /'
MASTER_B=$(python3 -c "import json; print(json.load(open('$WORK/master-b/descriptor.json'))['pubkey'])")

step "two gateways (B delegated), two miners"
node "$HERE/gateway/serve.mjs" "${COMMON[@]}" --pay $PAY_A --key $KEY_A --port $ST_A --api $API_A --diff 1 --poll 1 --pool "ws://127.0.0.1:$CO_PORT/ws" > "$WORK/gw-a.log" 2>&1 & PIDS+=($!)
node "$HERE/gateway/serve.mjs" "${COMMON[@]}" --pay $PAY_B --key $KEY_B --port $ST_B --api $API_B --diff 1 --poll 1 --pool "ws://127.0.0.1:$CO_PORT/ws" --descriptor "$WORK/master-b/descriptor.json" --delegation "$WORK/master-b/delegation-${WORKER_B:0:16}.json" > "$WORK/gw-b.log" 2>&1 & PIDS+=($!)
waitfor "$WORK/gw-a.log" 'pool: welcome' && waitfor "$WORK/gw-b.log" 'pool: welcome' || { tail -5 "$WORK/gw-a.log" "$WORK/gw-b.log" "$WORK/co.log"; fail "gateways did not join the coordinator"; }
"$SIA_TEST_MINER" 127.0.0.1:$ST_A "$PAY_A.a" > "$WORK/miner-a.log" 2>&1 & PIDS+=($!)
"$SIA_TEST_MINER" 127.0.0.1:$ST_B "$PAY_B.b" > "$WORK/miner-b.log" 2>&1 & PIDS+=($!)

TARGET=$((ACTIVATION + BLOCKS))
step "mining until height $TARGET (up to ${TIMEOUT}s)"
deadline=$((SECONDS + TIMEOUT)); h=0
while [ $SECONDS -lt $deadline ]; do h=$(cli getblockcount 2>/dev/null || echo 0); [ "$h" -ge "$TARGET" ] && break; sleep 1; done
[ "$h" -ge "$TARGET" ] || { tail -8 "$WORK/co.log" "$WORK/gw-a.log"; fail "no block at $TARGET within ${TIMEOUT}s"; }

step "the last pooled block pays the window"
H=$TARGET; HASH=$(cli getblockhash $H)
OUTS=$(cli getblock "$HASH" 2 | python3 -c 'import json,sys
b=json.load(sys.stdin)
for o in b["tx"][0]["vout"]: print(o["scriptPubKey"]["hex"], round(o["value"]*1e8))')
echo "$OUTS" | sed 's/^/  /'
N_PAY=$(echo "$OUTS" | grep -v -c '^6a')
[ "$N_PAY" -ge 2 ] || fail "block $H pays $N_PAY output(s), expected both masters"
python3 - "$WORK/co/snapshots/$H.json" "$OUTS" <<'PY'
import json,sys
snap=json.load(open(sys.argv[1])); outs=[l.split() for l in sys.argv[2].splitlines() if not l.startswith('6a')]
want=[[s,int(v)] for s,v in snap['outputs']]; got=[[s,int(v)] for s,v in outs]
print('  snapshot outputs:', want); print('  coinbase outputs:', got)
assert want==got, 'coinbase does not follow the snapshot'
print('  coinbase follows snapshot', snap['split'][:12], 'window', snap['window']['weight'], 'of', snap['need'])
PY

step "B's shares are credited to its master, not its worker"
python3 - "$WORK/co/shares.jsonl" "$MASTER_B" "$WORKER_B" <<'PY'
import json,sys
shares=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
byB=[s for s in shares if s.get('worker')==sys.argv[3]]
assert byB, 'no share signed by worker B'
assert all(s['master']==sys.argv[2] for s in byB), 'a share by worker B was not credited to master B'
assert not any(s['master']==sys.argv[3] for s in shares), 'a share was credited to the worker key itself'
print(f'  {len(byB)} shares signed by worker B, all credited to master B')
PY

step "independent replay of snapshot $H"
node "$HERE/audit/replay.mjs" --data "$WORK/co" --height $H | sed 's/^/  /'

step "coordinator down: gateways go solo"
kill $CO_PID; sleep 2
waitfor "$WORK/gw-a.log" 'solo work until' 20 || fail "gateway A did not notice the coordinator leaving"
SOLO_FROM=$(cli getblockcount); deadline=$((SECONDS + 120))
while [ $SECONDS -lt $deadline ]; do [ "$(cli getblockcount)" -gt "$SOLO_FROM" ] && break; sleep 1; done
[ "$(cli getblockcount)" -gt "$SOLO_FROM" ] || fail "no solo block while the coordinator was down"
SH=$(cli getblockcount); SOLO_OUTS=$(cli getblock "$(cli getblockhash $SH)" 2 | python3 -c 'import json,sys; b=json.load(sys.stdin); print(sum(1 for o in b["tx"][0]["vout"] if not o["scriptPubKey"]["hex"].startswith("6a")))')
[ "$SOLO_OUTS" = 1 ] || fail "solo block $SH pays $SOLO_OUTS outputs, expected 1"
echo "  block $SH mined solo, one payout output"

step "coordinator back: window intact, gateways rejoin"
BEFORE=$(wc -l < "$WORK/co/shares.jsonl")
start_co; waitfor "$WORK/co.log" "$BEFORE shares" || { tail -3 "$WORK/co.log"; fail "coordinator did not reload $BEFORE shares"; }
waitfor "$WORK/gw-a.log" 'pool: welcome.*\n.*pool: welcome' 1 || true
for _ in $(seq 60); do [ "$(grep -c 'pool: welcome' "$WORK/gw-a.log")" -ge 2 ] && [ "$(grep -c 'pool: welcome' "$WORK/gw-b.log")" -ge 2 ] && break; sleep 0.5; done
[ "$(grep -c 'pool: welcome' "$WORK/gw-a.log")" -ge 2 ] || fail "gateway A did not rejoin"
echo "  reloaded $BEFORE shares; both gateways rejoined"

step "passed: two gateways paid by one coinbase, replay matches, solo fallback and rejoin work"
grep -c 'share #' "$WORK/co.log" | sed 's/^/shares credited: /'; grep -c 'BLOCK h' "$WORK/co.log" | sed 's/^/blocks recorded: /'
