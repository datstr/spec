#!/usr/bin/env bash
# Mine a block through the datstr gateway on a throwaway regtest, with ratum's sia-test-miner
# as the stratum client. Exits 0 only if the node accepted a block whose coinbase ends in the
# datstr commitment output.
#
#   gateway/test/regtest.sh [--keep]
#
#   BITCOIND, BITCOIN_CLI   a Bitcoin Knots build with the BLAKE2b change
#   SIA_TEST_MINER          ratum's CPU miner (default ~/remote/github.com/iohzrd/ratum/target/release/sia-test-miner)
#   TIMEOUT                 seconds to wait for the block (default 300)
#   BLOCKS                  pooled blocks to mine past the activation (default 1)
set -euo pipefail
BITCOIND=${BITCOIND:-$HOME/bitcoin-knots/src/build/bin/bitcoind}
BITCOIN_CLI=${BITCOIN_CLI:-$HOME/bitcoin-knots/src/build/bin/bitcoin-cli}
SIA_TEST_MINER=${SIA_TEST_MINER:-$HOME/remote/github.com/iohzrd/ratum/target/release/sia-test-miner}
TIMEOUT=${TIMEOUT:-300}; BLOCKS=${BLOCKS:-1}; KEEP=0; [ "${1:-}" = "--keep" ] && KEEP=1
ACTIVATION=20
PAY=bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080
WORKER=cf82dd709e4a1b71328b1420138d69e513a211844728bdaf95273ce79a947bcf
HERE=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/datstr-e2e-XXXXXX")
PIDS=()
step() { printf '\n=== %s\n' "$*"; }
fail() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }
cli() { "$BITCOIN_CLI" -datadir="$WORK/node" "$@"; }
cleanup() { s=$?; for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; cli stop >/dev/null 2>&1 || true; sleep 1; if [ $KEEP = 1 ]; then echo "logs kept in $WORK"; else rm -rf "$WORK"; fi; exit $s; }
trap cleanup EXIT
port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
RPC_PORT=$(port); STRATUM_PORT=$(port); API_PORT=$(port)

step "regtest node with BLAKE2b active at height $ACTIVATION"
mkdir -p "$WORK/node"
cat > "$WORK/node/bitcoin.conf" <<CONF
regtest=1
server=1
listen=0
rpcuser=datstr
rpcpassword=datstrtest
datadir=$WORK/node
[regtest]
rpcbind=127.0.0.1
rpcport=$RPC_PORT
testactivationheight=blake2b@$ACTIVATION
blake2b_headline=datstr e2e headline
CONF
"$BITCOIND" -datadir="$WORK/node" > "$WORK/bitcoind.log" 2>&1 & PIDS+=($!)
for _ in $(seq 60); do cli getblockchaininfo >/dev/null 2>&1 && break; sleep 0.5; done
cli getblockchaininfo >/dev/null || fail "node did not start"
cli generatetoaddress "$ACTIVATION" "$PAY" >/dev/null
[ "$(cli getblockcount)" = "$ACTIVATION" ] || fail "activation height not reached"
TARGET=$((ACTIVATION + BLOCKS))

step "datstr gateway on stratum port $STRATUM_PORT"
node "$HERE/serve.mjs" --conf "$WORK/node/bitcoin.conf" --network btc:regtest-blake2b --activation $ACTIVATION --headline "datstr e2e headline" \
  --pay "$PAY" --worker "$WORKER" --port "$STRATUM_PORT" --api "$API_PORT" --diff 1 --poll 1 > "$WORK/gateway.log" 2>&1 & PIDS+=($!)
for _ in $(seq 60); do grep -q '^..:..:.. job ' "$WORK/gateway.log" 2>/dev/null && break; sleep 0.5; done
grep -q ' job ' "$WORK/gateway.log" || { cat "$WORK/gateway.log"; fail "the gateway published no job"; }

step "sia-test-miner until height $TARGET (up to ${TIMEOUT}s)"
"$SIA_TEST_MINER" "127.0.0.1:$STRATUM_PORT" "$PAY${MINER_USER_SUFFIX:-.rig1}" > "$WORK/miner.log" 2>&1 & PIDS+=($!)
deadline=$((SECONDS + TIMEOUT)); h=0
while [ $SECONDS -lt $deadline ]; do h=$(cli getblockcount 2>/dev/null || echo 0); [ "$h" -ge "$TARGET" ] && break; sleep 1; done
[ "$h" -ge "$TARGET" ] || { tail -20 "$WORK/gateway.log" "$WORK/miner.log"; fail "no block at $TARGET within ${TIMEOUT}s"; }

step "status page"
curl -sf "http://127.0.0.1:$API_PORT/" | grep -qi '<title>datstr gateway' || fail "status page not served"
curl -sf "http://127.0.0.1:$API_PORT/stats.json" | python3 -c "import json,sys; s=json.load(sys.stdin); print('  stats.json: blocks', s['blocks_found'], 'shares', s['shares_accepted']['count'], 'clients', len(s['clients']), 'hashrate %.0f MH/s' % (s['stratum']['hashrate']/1e6))"

if [ -n "${SCREENSHOT:-}" ]; then
  sleep 6; timeout 60 chromium-browser --headless=new --disable-gpu --hide-scrollbars --no-sandbox --window-size=1200,1250 --screenshot="$SCREENSHOT" "http://127.0.0.1:$API_PORT/" >/dev/null 2>&1 && echo "  screenshot $SCREENSHOT"
fi

step "checking block $TARGET"
HASH=$(cli getblockhash "$TARGET")
HDR=$(cli getblockheader "$HASH" false); [ ${#HDR} = 328 ] || fail "header is ${#HDR} hex chars, not 328"
grep -q "BLOCK $HASH" "$WORK/gateway.log" || fail "the gateway did not submit $HASH"
CB=$(cli getblock "$HASH" 2 | python3 -c 'import json,sys; b=json.load(sys.stdin); cb=b["tx"][0]; print(" ".join(o["scriptPubKey"]["hex"] for o in cb["vout"]))')
LAST=${CB##* }
[ "${LAST:0:4}" = "6a20" ] || fail "last coinbase output is not a 34-byte OP_RETURN: $LAST"
COMMIT=$(grep -o 'commitment [0-9a-f]*' "$WORK/gateway.log" | head -1 | cut -d' ' -f2)
[ "${LAST:4:16}" = "$COMMIT" ] || fail "commitment in the block (${LAST:4:16}) is not the gateway's ($COMMIT)"
step "passed: height $TARGET is $HASH, mined by sia-test-miner through the datstr gateway"
echo "coinbase outputs: $CB"
grep -c ' share ' "$WORK/gateway.log" | sed 's/^/shares accepted: /'
