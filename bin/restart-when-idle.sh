#!/usr/bin/env bash
# Restart grok-deck only when no turns are running. Shows "Update pending" in the app meanwhile.
# Usage: bin/restart-when-idle.sh [max-wait-hours, default 12] [--allow-longrun]
# --allow-longrun: long-run turns do not block (the long-run watchdog resumes them after the restart).
set -u
cd "$(dirname "$0")/.."
FLAG=data/update-pending
PORT=${PORT:-8787}
MAX=$(( ${1:-12} * 3600 ))
FIELD=busy
[ "${2:-}" = "--allow-longrun" ] && FIELD=busyInteractive
date -Iseconds > "$FLAG"
busy() {
  local b
  b=$(curl -fsS -m 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get(sys.argv[1],""))' "$FIELD" 2>/dev/null)
  if [ -n "$b" ]; then echo "$b"; return; fi
  # Older server without the busy field: count unmatched turn start/end lines since it started.
  local since
  since=$(systemctl --user show grok-deck -p ActiveEnterTimestamp --value)
  journalctl --user -u grok-deck --since "$since" --no-pager -o cat 2>/dev/null | python3 -c '
import re,sys
live=set()
for l in sys.stdin:
    m=re.match(r"turn (\S+) (start|end)", l)
    if m: (live.add if m.group(2)=="start" else live.discard)(m.group(1))
print(len(live))'
}
waited=0; idle=0
while [ $waited -lt $MAX ]; do
  n=$(busy)
  if [ "$n" = "0" ]; then idle=$((idle+1)); else idle=0; fi
  if [ $idle -ge 2 ]; then
    echo "$(date '+%F %T') idle, restarting"
    systemctl --user restart grok-deck
    sleep 3
    curl -fsS -m 5 "http://127.0.0.1:$PORT/api/health"; echo
    exit 0
  fi
  [ $((waited % 300)) -eq 0 ] && echo "$(date '+%F %T') waiting: $n turn(s) running"
  sleep 20; waited=$((waited+20))
done
echo "gave up after $1h; update still pending"; exit 1
