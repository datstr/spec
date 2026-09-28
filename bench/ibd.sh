#!/bin/bash
# One initial-sync benchmark of the BLAKE2b testnet4 node: a fresh data directory, blocks from a local peer only.
#   bench/ibd.sh <name> full|snapshot [bitcoind args...]
# Samples every 10 s into bench/results/<name>.csv and writes bench/results/<name>.json at the end.
# snapshot mode: headers first, then loadtxoutset of $SNAPSHOT, then until the background validation retires it.
set -u
NAME=$1; MODE=$2; shift 2; EXTRA=("$@")
BIN=${BIN:-$HOME/knots-testnet4/src-assumeutxo/build/bin}; PEER=${PEER:-127.0.0.1:48343}; SNAPSHOT=${SNAPSHOT:-$HOME/knots-testnet4/snapshots/utxo-knots-150307.dat}
D=$HOME/knots-testnet4/bench/$NAME; OUT=$(dirname "$0")/results; RPC=48410; P2P=48411
cli() { "$BIN/bitcoin-cli" -testnet4 -datadir="$D" -rpcport=$RPC "$@"; }
j() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const v=JSON.parse(d);console.log(eval(process.argv[1]))}catch{console.log("")}})' "$1"; }
rm -rf "$D"; mkdir -p "$D" "$OUT"
TARGET=$(curl -s -u "$(cat $HOME/knots-testnet4/data/testnet4/.cookie)" --data-binary '{"jsonrpc":"1.0","id":"x","method":"getblockcount","params":[]}' http://127.0.0.1:48342/ | j 'v.result')
echo "t,blocks,headers,progress,chainstates,snapshot_blocks,rss_mb,cpu_s,disk_mb,phase" > "$OUT/$NAME.csv"
T0=$(date +%s); "$BIN/bitcoind" -testnet4 -datadir="$D" -connect=$PEER -listen=0 -dnsseed=0 -disablewallet -txindex=0 -daemon=0 -printtoconsole=0 -rpcport=$RPC -port=$P2P "${EXTRA[@]}" & PID=$!
for i in $(seq 1 60); do cli getblockcount >/dev/null 2>&1 && break; sleep 1; done
PHASE=sync; LOADED=""; T_HEADERS=""; T_LOAD=""; T_USABLE=""; T_DONE=""
while kill -0 $PID 2>/dev/null; do
  BC=$(cli getblockchaininfo 2>/dev/null); CS=$(cli getchainstates 2>/dev/null)
  BLOCKS=$(echo "$BC" | j 'v.blocks'); HEADERS=$(echo "$BC" | j 'v.headers'); PROG=$(echo "$BC" | j 'Number(v.verificationprogress).toFixed(4)')
  NCS=$(echo "$CS" | j 'v.chainstates.length'); SB=$(echo "$CS" | j 'v.chainstates.length>1?v.chainstates[1].blocks:(v.chainstates[0].snapshot_blockhash?v.chainstates[0].blocks:"")')
  RSS=$(awk '/VmRSS/{printf "%d", $2/1024}' /proc/$PID/status 2>/dev/null); CPU=$(awk '{printf "%d", ($14+$15)/100}' /proc/$PID/stat 2>/dev/null); DISK=$(du -sm "$D" 2>/dev/null | cut -f1)
  T=$(( $(date +%s) - T0 )); echo "$T,$BLOCKS,$HEADERS,$PROG,$NCS,$SB,$RSS,$CPU,$DISK,$PHASE" >> "$OUT/$NAME.csv"
  if [ "$MODE" = snapshot ] && [ -z "$LOADED" ] && [ "${HEADERS:-0}" -ge 150307 ]; then
    T_HEADERS=$T; PHASE=loading; TL=$(date +%s); cli loadtxoutset "$SNAPSHOT" > "$OUT/$NAME.load.json" 2>&1; T_LOAD=$(( $(date +%s) - TL )); LOADED=1; PHASE=snapshot; echo "loadtxoutset took ${T_LOAD}s" >> "$OUT/$NAME.load.json"
  fi
  if [ "$MODE" = snapshot ] && [ -n "$LOADED" ] && [ -z "$T_USABLE" ] && [ "${BLOCKS:-0}" -ge "$TARGET" ]; then T_USABLE=$T; PHASE=background; fi
  if [ "$MODE" = snapshot ] && [ -n "$T_USABLE" ] && [ "${NCS:-2}" = 1 ] && [ "${BLOCKS:-0}" -ge "$TARGET" ]; then T_DONE=$T; break; fi
  if [ "$MODE" = full ] && [ "${BLOCKS:-0}" -ge "$TARGET" ]; then T_DONE=$T; break; fi
  sleep 10
done
PEAK=$(awk -F, 'NR>1 && $7>m{m=$7} END{print m+0}' "$OUT/$NAME.csv"); CPUS=$(awk -F, 'NR>1{c=$8} END{print c+0}' "$OUT/$NAME.csv"); DISKM=$(du -sm "$D" | cut -f1)
cli stop >/dev/null 2>&1; wait $PID 2>/dev/null
node -e 'const [n,m,t,th,tl,tu,td,peak,cpu,disk,extra]=process.argv.slice(1);require("fs").writeFileSync(process.argv[12],JSON.stringify({name:n,mode:m,target_height:Number(t),headers_s:th?Number(th):null,loadtxoutset_s:tl?Number(tl):null,usable_s:tu?Number(tu):null,done_s:td?Number(td):null,peak_rss_mb:Number(peak),cpu_s:Number(cpu),disk_mb:Number(disk),args:extra,machine:require("os").cpus().length+" cores, "+Math.round(require("os").totalmem()/1e9)+" GB",date:new Date().toISOString()},null,1)+"\n")' "$NAME" "$MODE" "$TARGET" "$T_HEADERS" "$T_LOAD" "$T_USABLE" "$T_DONE" "$PEAK" "$CPUS" "$DISKM" "${EXTRA[*]}" "$OUT/$NAME.json"
cat "$OUT/$NAME.json"
