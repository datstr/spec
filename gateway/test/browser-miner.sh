#!/usr/bin/env bash
# The browser miner path on a throwaway regtest: gateway with its API server, a Node client
# speaking the page's protocol over /stratum at a pinned low difficulty, two accepted shares.
set -euo pipefail
BITCOIND=${BITCOIND:-$HOME/bitcoin-knots/src/build/bin/bitcoind}; BITCOIN_CLI=${BITCOIN_CLI:-$HOME/bitcoin-knots/src/build/bin/bitcoin-cli}
ACTIVATION=20; PAY=bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080; HERE=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/datstr-bm-XXXXXX"); PIDS=()
cli() { "$BITCOIN_CLI" -datadir="$WORK/node" "$@"; }
cleanup() { s=$?; for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; cli stop >/dev/null 2>&1 || true; sleep 1; rm -rf "$WORK"; exit $s; }
trap cleanup EXIT
port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
RPC_PORT=$(port); ST=$(port); API=$(port)
mkdir -p "$WORK/node"; printf 'regtest=1\nserver=1\nlisten=0\nrpcuser=datstr\nrpcpassword=datstrtest\ndatadir=%s\n[regtest]\nrpcbind=127.0.0.1\nrpcport=%s\ntestactivationheight=blake2b@%s\nblake2b_headline=datstr e2e headline\n' "$WORK/node" "$RPC_PORT" "$ACTIVATION" > "$WORK/node/bitcoin.conf"
"$BITCOIND" -datadir="$WORK/node" > "$WORK/bitcoind.log" 2>&1 & PIDS+=($!)
for _ in $(seq 60); do cli getblockchaininfo >/dev/null 2>&1 && break; sleep 0.5; done
cli generatetoaddress $ACTIVATION $PAY >/dev/null
node "$HERE/serve.mjs" --conf "$WORK/node/bitcoin.conf" --network btc:regtest-blake2b --activation $ACTIVATION --headline "datstr e2e headline" --pay $PAY --port $ST --api $API --diff 1 --vardiff-min 0.00001 --poll 1 > "$WORK/gateway.log" 2>&1 & PIDS+=($!)
for _ in $(seq 60); do curl -sf "http://127.0.0.1:$API/miner" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "http://127.0.0.1:$API/miner" | grep -q '<title>datstr Miner' || { cat "$WORK/gateway.log"; echo "FAILED: miner page not served"; exit 1; }
curl -sf "http://127.0.0.1:$API/miner-core.mjs" | grep -q 'export function mine' || { echo "FAILED: miner-core.mjs not served"; exit 1; }
echo "=== node client over ws://127.0.0.1:$API/stratum at difficulty 0.0001"
node "$HERE/test/ws-miner.mjs" "ws://127.0.0.1:$API/stratum" "$PAY.tab" 0.0001 2 | sed 's/^/  /'
grep -c ' share ' "$WORK/gateway.log" | sed 's/^/shares the gateway accepted: /'
echo "=== passed: the browser miner's protocol works end to end over the gateway's WebSocket"
