#!/bin/sh
# P4.1: 16-zone scale test — rotation coverage + preemption under load + resource metrics
killall mzrelay2 mztone 2>/dev/null
sleep 1
ZARGS=""
p=5001; pr=1
while [ $pr -le 16 ]; do ZARGS="$ZARGS $p $pr"; p=$((p+1)); pr=$((pr+1)); done
/tmp/mzrelay2 239.192.1.1 2000 16 192.168.0.70 500 $ZARGS 2>/tmp/mzrelay.p4.log &
RPID=$!
sleep 1
echo "=== baseline (pid $RPID) ==="
grep -E "VmRSS|VmSize" /proc/$RPID/status
echo "fd_count: $(ls /proc/$RPID/fd | wc -l)"
J1=$(awk '{print $14+$15}' /proc/$RPID/stat)
T1=$(cut -d. -f1 /proc/uptime)
echo "=== rotation: zone16(prio16) -> zone1(prio1), 2s each ==="
p=5016
while [ $p -ge 5001 ]; do
  /tmp/mztone /tmp/z2low.g722 127.0.0.1 $p 0 2 >/dev/null 2>&1
  sleep 1
  p=$((p-1))
done
echo "=== after rotation ==="
grep VmRSS /proc/$RPID/status
echo "=== preemption under load: zone16 loop, zone1 bursts in ==="
/tmp/mztone /tmp/z2low.g722 127.0.0.1 5016 1 0 >/dev/null 2>&1 &
LOWPID=$!
sleep 3
/tmp/mztone /tmp/emerg.g722 127.0.0.1 5001 0 3 >/dev/null 2>&1
sleep 2
kill $LOWPID 2>/dev/null
sleep 1
echo "=== final metrics ==="
grep -E "VmRSS|VmSize|Threads" /proc/$RPID/status
echo "fd_count: $(ls /proc/$RPID/fd | wc -l)"
J2=$(awk '{print $14+$15}' /proc/$RPID/stat)
T2=$(cut -d. -f1 /proc/uptime)
echo "cpu_jiffies_used: $((J2-J1)) over $((T2-T1))s (HZ=100 -> pct = jiffies/elapsed)"
free
echo "=== relay log ==="
cat /tmp/mzrelay.p4.log
killall mztone 2>/dev/null
kill $RPID 2>/dev/null
echo "P4SCALE-COMPLETE"
