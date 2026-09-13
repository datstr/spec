#!/usr/bin/env bash
# SPEC 7 identities on a throwaway regtest with a coordinator: a client whose username is an
# address is credited and paid at that address; a client that signs a descriptor and a
# delegation with its own Nostr master (the xlogin flow) is credited to that master.
set -euo pipefail
BITCOIND=${BITCOIND:-$HOME/bitcoin-knots/src/build/bin/bitcoind}; BITCOIN_CLI=${BITCOIN_CLI:-$HOME/bitcoin-knots/src/build/bin/bitcoin-cli}
ACTIVATION=20; PAY_GW=bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080; PAY_ADDR=bcrt1qzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3lgth6c; PAY_M=bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080
MASTER_KEY=3333333333333333333333333333333333333333333333333333333333333333
HERE=$(cd "$(dirname "$0")/../.." && pwd); WORK=$(mktemp -d "${TMPDIR:-/tmp}/datstr-id-XXXXXX"); PIDS=()
cli() { "$BITCOIN_CLI" -datadir="$WORK/node" "$@"; }
cleanup() { s=$?; for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; cli stop >/dev/null 2>&1 || true; sleep 1; [ "${KEEP:-0}" = 1 ] && echo "kept $WORK" || rm -rf "$WORK"; exit $s; }
trap cleanup EXIT
port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
RPC_PORT=$(port); CO=$(port); ST=$(port); API=$(port)
mkdir -p "$WORK/node"; printf 'regtest=1\nserver=1\nlisten=0\nrpcuser=datstr\nrpcpassword=datstrtest\ndatadir=%s\n[regtest]\nrpcbind=127.0.0.1\nrpcport=%s\ntestactivationheight=blake2b@%s\nblake2b_headline=h\n' "$WORK/node" "$RPC_PORT" "$ACTIVATION" > "$WORK/node/bitcoin.conf"
"$BITCOIND" -datadir="$WORK/node" > "$WORK/bitcoind.log" 2>&1 & PIDS+=($!)
for _ in $(seq 60); do cli getblockchaininfo >/dev/null 2>&1 && break; sleep 0.5; done
cli generatetoaddress $ACTIVATION $PAY_GW >/dev/null
COMMON=(--conf "$WORK/node/bitcoin.conf" --network btc:regtest-blake2b --activation $ACTIVATION --headline h)
node "$HERE/plugin/standalone.mjs" "${COMMON[@]}" --data "$WORK/co" --port $CO --window-min-weight 100 --min-difficulty 0.00001 > "$WORK/co.log" 2>&1 & PIDS+=($!)
for _ in $(seq 60); do curl -sf "http://127.0.0.1:$CO/pool.json" >/dev/null 2>&1 && break; sleep 0.5; done
node "$HERE/gateway/serve.mjs" "${COMMON[@]}" --pay $PAY_GW --key 1111111111111111111111111111111111111111111111111111111111111111 --port $ST --api $API --diff 1 --vardiff-min 0.00001 --poll 1 --pool "ws://127.0.0.1:$CO/ws" > "$WORK/gw.log" 2>&1 & PIDS+=($!)
for _ in $(seq 60); do curl -sf "http://127.0.0.1:$API/stats.json" >/dev/null 2>&1 && break; sleep 0.5; done
echo "=== client 1: username is an address ($PAY_ADDR)"
node "$HERE/gateway/test/ws-miner.mjs" "ws://127.0.0.1:$API/stratum" "$PAY_ADDR.tab" 0.0001 2 | sed 's/^/  /'
echo "=== client 2: a Nostr master signs a descriptor and a delegation (the xlogin flow)"
node "$HERE/gateway/test/ws-miner.mjs" --master $MASTER_KEY --pay $PAY_M "ws://127.0.0.1:$API/stratum" "rig.m" 0.0001 2 | sed 's/^/  /'
sleep 2
echo "=== what the coordinator credited"
MASTER_PUB=$(node -e "import('$HERE/gateway/lib/nostr.mjs').then(m => console.log(m.pubkeyOf('$MASTER_KEY')))")
python3 - "$WORK/co" "$MASTER_PUB" <<'PY'
import json,sys,subprocess
D=sys.argv[1]
M=sys.argv[2]
masters={json.loads(l)['pubkey']: json.loads(l) for l in open(f'{D}/masters.jsonl') if l.strip()}
shares=[json.loads(l) for l in open(f'{D}/shares.jsonl') if l.strip()]
addr_script='0014'+'1111'*10  # bcrt1qzyg3… is P2WPKH of 20 bytes of 0x11
by={}
for s in shares: by[s['master']]=by.get(s['master'],0)+1
print('  masters:', [(k[:8], v['payout'][:12]) for k,v in masters.items()])
print('  shares per master:', {k[:8]: v for k,v in by.items()})
addr_masters=[k for k,v in masters.items() if v['payout']==addr_script]
assert addr_masters and by.get(addr_masters[0],0)>=2, 'the address client was not credited to a master paid at its address'
assert M in masters and by.get(M,0)>=2, 'the delegated client was not credited to its Nostr master'
assert all(m!='' for m in by)
print('  ok: address client paid at its address; delegated client credited to its master')
PY
echo "=== passed: both identity modes credited and paid as SPEC 7 says"
