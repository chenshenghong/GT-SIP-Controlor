#!/bin/sh
# mzdeploy.sh — multi-zone side-car 佈署自動化（P6/P7，mac 端執行，經 mzctl.py root SSH）
#
#   ./mzdeploy.sh deploy         佈署 mzrelay3+conf+S21 到設備（既有 binary 先備份為 .prev 供回退）
#   ./mzdeploy.sh status         健康檢查：程序、REST /get zones、IGMP、開機自啟檔案完整性；mzweb 程序/md5/備份狀態
#   ./mzdeploy.sh rollback       還原 .prev 前版 binary 並重啟 daemon
#   ./mzdeploy.sh redeploy       災難重佈（韌體整包升級抹除 /opt 後）：deploy + 提示 zones 需重配或還原備份
#   ./mzdeploy.sh mzweb-install  佈署 mzweb（重建版 sipweb）到 /etc/sipweb/sipweb（首次自動備份 .orig）
#   ./mzdeploy.sh mzweb-rollback 還原 /etc/sipweb/sipweb.orig（原廠 sipweb）並重開機
#
# 環境變數：MZHOST（預設 192.168.0.70，傳遞給 mzctl.py）、MZREST（預設 8090）
# 本地 mzweb binary 路徑：mzweb/build/mzweb-arm（此腳本在 src/ 內執行，相對路徑以 src/ 為基準）
set -e
cd "$(dirname "$0")"
CTL="python3 mzctl.py"
HOST="${MZHOST:-192.168.0.70}"
REST="${MZREST:-8090}"
TOK="Authorization: Bearer mzpoc-token"
MZWEB_BIN="mzweb/build/mzweb-arm"

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
	echo "-- mzweb（sipweb）:"
	$CTL sh 'ps | grep sipweb | grep -v grep | head -1; ls -la /etc/sipweb/sipweb /etc/sipweb/sipweb.orig 2>&1'
	if $CTL sh 'test -f /etc/sipweb/sipweb.orig && echo ORIG_YES || echo ORIG_NO' | grep -q ORIG_YES; then
		echo "  備份 /etc/sipweb/sipweb.orig：存在"
	else
		echo "  備份 /etc/sipweb/sipweb.orig：不存在（尚未跑過 mzweb-install）"
	fi
	if [ -f "$MZWEB_BIN" ]; then
		LOCAL_MD5=$(md5sum "$MZWEB_BIN" | awk '{print $1}')
		REMOTE_MD5=$($CTL sh 'md5sum /etc/sipweb/sipweb 2>/dev/null' | awk '/^[0-9a-f]{32} /{print $1}')
		if [ -n "$REMOTE_MD5" ] && [ "$LOCAL_MD5" = "$REMOTE_MD5" ]; then
			echo "  md5 一致（設備已是本地 $MZWEB_BIN）：$LOCAL_MD5"
		else
			echo "  md5 不一致或無法比對：local=$LOCAL_MD5 remote=${REMOTE_MD5:-無回應}"
		fi
	else
		echo "  (本地無 $MZWEB_BIN，略過 md5 比對)"
	fi
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
mzweb-install)
	[ -f "$MZWEB_BIN" ] || { echo "缺 $MZWEB_BIN binary，先在 mzweb/ 交叉編譯（見 mzweb/Makefile）"; exit 1; }
	echo "⚠ 即將覆蓋設備系統常駐 web 服務執行檔 /etc/sipweb/sipweb =="
	echo "== 首次備份原廠 sipweb -> /etc/sipweb/sipweb.orig（若已存在則跳過，不覆蓋既有備份）=="
	$CTL sh '[ -f /etc/sipweb/sipweb.orig ] || cp /etc/sipweb/sipweb /etc/sipweb/sipweb.orig; test -f /etc/sipweb/sipweb.orig && echo ORIG_YES || echo ORIG_NO'
	echo "== 上傳 mzweb binary =="
	$CTL put "$MZWEB_BIN" /etc/sipweb/sipweb.new
	echo "== 原子替換 /etc/sipweb/sipweb =="
	$CTL sh 'chmod +x /etc/sipweb/sipweb.new; mv /etc/sipweb/sipweb.new /etc/sipweb/sipweb'
	echo "⚠ 正在重啟 web 服務（killall sipweb，假設原廠有 respawn 機制自動拉回）=="
	# TODO(T11)：現場確認原廠 sipweb 的拉起機制（inittab respawn？rcS？某 init.d 腳本？）後，
	# 若無 respawn，改成對應的重啟命令（例如背景直接啟動 '/etc/sipweb/sipweb &' 或呼叫該 init 腳本）。
	$CTL sh 'killall sipweb 2>/dev/null; sleep 2'
	echo "== 驗證 web 服務是否已起（本機 loopback）=="
	$CTL sh 'wget -qO- http://127.0.0.1:80/get/device/status | head -c 64; echo'
	;;
mzweb-rollback)
	echo "⚠ 即將還原原廠 sipweb 並重開機設備 =="
	if $CTL sh 'test -f /etc/sipweb/sipweb.orig && echo ORIG_YES || echo ORIG_NO' | grep -q ORIG_NO; then
		echo "無 /etc/sipweb/sipweb.orig 可回退（需先成功跑過一次 mzweb-install 才有備份）"; exit 1
	fi
	$CTL sh 'cp /etc/sipweb/sipweb.orig /etc/sipweb/sipweb; reboot'
	echo "已還原 /etc/sipweb/sipweb.orig 並觸發 reboot，設備重開機後套用原廠 sipweb"
	;;
*)
	echo "usage: $0 {deploy|status|rollback|redeploy|mzweb-install|mzweb-rollback}"; exit 2
	;;
esac
