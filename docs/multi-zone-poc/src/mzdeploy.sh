#!/bin/sh
# mzdeploy.sh — multi-zone side-car 佈署自動化（P6，mac 端執行，經 mzctl.py root SSH）
#
#   ./mzdeploy.sh deploy    佈署 mzrelay3+conf+S21 到設備（既有 binary 先備份為 .prev 供回退）
#   ./mzdeploy.sh status    健康檢查：程序、REST /get zones、IGMP、開機自啟檔案完整性
#   ./mzdeploy.sh rollback  還原 .prev 前版 binary 並重啟 daemon
#   ./mzdeploy.sh redeploy  災難重佈（韌體整包升級抹除 /opt 後）：deploy + 提示 zones 需重配或還原備份
#
# 環境變數：MZHOST（預設 192.168.0.70，傳遞給 mzctl.py）、MZREST（預設 8090）
set -e
cd "$(dirname "$0")"
CTL="python3 mzctl.py"
HOST="${MZHOST:-192.168.0.70}"
REST="${MZREST:-8090}"
TOK="Authorization: Bearer mzpoc-token"

case "${1:-}" in
deploy)
	[ -f mzrelay3 ] || { echo "缺 mzrelay3 binary，先交叉編譯（見 README）"; exit 1; }
	echo "== 備份既有 binary -> /opt/mzrelay3.prev（若存在）=="
	$CTL sh 'test -f /opt/mzrelay3 && cp /opt/mzrelay3 /opt/mzrelay3.prev || echo "(無既有版，跳過備份)"'
	echo "== 上傳 binary / conf / init =="
	$CTL put mzrelay3 /opt/mzrelay3
	# mzctl.py 退出碼不反映遠端結果，存在性判斷須抓輸出字串
	if $CTL sh 'test -f /opt/mzrelay.conf && echo CONF_YES || echo CONF_NO' | grep -q CONF_NO; then
		$CTL put mzrelay3.conf.example /opt/mzrelay.conf
	fi
	$CTL put S21mzrelay /etc/init.d/S21mzrelay
	echo "== 重啟 daemon（zones 設定 /opt/mzzones.json 不動）=="
	$CTL sh 'chmod +x /opt/mzrelay3 /etc/init.d/S21mzrelay; killall mzrelay3 2>/dev/null; sleep 1; /etc/init.d/S21mzrelay; sleep 2; ps | grep mzrelay3 | grep -v grep | head -1; sync'
	echo "== 健康檢查 =="
	"$0" status
	;;
status)
	echo "-- 程序:"
	$CTL sh 'ps | grep mzrelay3 | grep -v grep | head -1; ls -la /opt/mzrelay3 /opt/mzrelay.conf /opt/mzzones.json /etc/init.d/S21mzrelay 2>&1'
	echo "-- REST /get/sip/multicast/zones（啟用區摘要）:"
	curl -s -m 5 "http://$HOST:$REST/get/sip/multicast/zones" -H "$TOK" \
	  | python3 -c 'import json,sys; z=json.load(sys.stdin)["zones"]; en=[(r["zone_id"],r["multicast_address"],r["multicast_port"],r["priority"],r["audio_codec"]) for r in z if r["enabled"]]; print(f"  enabled {len(en)}/16:", en)' \
	  || { echo "  REST 無回應 — daemon 未啟或埠不通"; exit 1; }
	;;
rollback)
	echo "== 還原 /opt/mzrelay3.prev =="
	if $CTL sh 'test -f /opt/mzrelay3.prev && echo PREV_YES || echo PREV_NO' | grep -q PREV_NO; then
		echo "無 /opt/mzrelay3.prev 可回退"; exit 1
	fi
	$CTL sh 'cp /opt/mzrelay3.prev /opt/mzrelay3; chmod +x /opt/mzrelay3; killall mzrelay3 2>/dev/null; sleep 1; /etc/init.d/S21mzrelay; sleep 2; ps | grep mzrelay3 | grep -v grep | head -1; sync'
	"$0" status
	;;
redeploy)
	echo "== 災難重佈（整包 rom 升級後 /opt 可能被抹）=="
	"$0" deploy
	echo "⚠ zones 表若一併被抹（/opt/mzzones.json 不在），需經 device-web/REST 重新配置，"
	echo "  或事先用 'mzctl.py sh \"cat /opt/mzzones.json\"' 備份、此時 put 回去後 killall mzrelay3; /etc/init.d/S21mzrelay"
	;;
*)
	echo "usage: $0 {deploy|status|rollback|redeploy}"; exit 2
	;;
esac
