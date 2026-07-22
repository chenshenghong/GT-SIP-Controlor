#!/bin/sh
# P4.3: codec boundary — G.722 / G.711U(PCMU) mix through boot-started mzrelay2.
# mztone args: <file> <ip> <port> [loop] [dur] [pt]
TPID0=$(ps | grep "/opt/termapp$" | grep -v grep | awk '{print $1}' | head -1)
echo "termapp pid before: $TPID0"
echo "=== 1. baseline: pure G.722 zone3 (5003 prio3) 5s ==="
/tmp/mztone /tmp/z2low.g722 127.0.0.1 5003 0 5 9 2>&1 | tail -1
sleep 3
echo "=== 2. pure G.711U zone1 (5001 prio1) 5s ==="
/tmp/mztone /tmp/z3u.ulaw 127.0.0.1 5001 0 5 0 2>&1 | tail -1
sleep 3
echo "=== 3. mixed: G.722 loop on zone3, G.711U preempts on zone1 ==="
/tmp/mztone /tmp/z2low.g722 127.0.0.1 5003 1 0 9 >/dev/null 2>&1 &
G722PID=$!
sleep 3
/tmp/mztone /tmp/z3u.ulaw 127.0.0.1 5001 0 4 0 2>&1 | tail -1
sleep 4
kill $G722PID 2>/dev/null
sleep 1
TPID1=$(ps | grep "/opt/termapp$" | grep -v grep | awk '{print $1}' | head -1)
echo "termapp pid after: $TPID1 (unchanged = no crash/restart)"
echo "=== relay boot log (SWITCH events) ==="
grep -E "SWITCH|SILENT" /tmp/mzrelay.boot.log | tail -12
echo "P4CODEC-COMPLETE"
