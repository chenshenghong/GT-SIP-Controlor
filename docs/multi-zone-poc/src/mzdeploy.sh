#!/bin/sh
# mzdeploy.sh — multi-zone side-car 佈署自動化（P6/P7，mac 端執行，經 mzctl.py root SSH）
#
#   ./mzdeploy.sh deploy         佈署 mzrelay3+conf+S21 到設備（既有 binary 先備份為 .prev 供回退）
#   ./mzdeploy.sh status         健康檢查：程序、REST /get zones、IGMP、開機自啟檔案完整性；mzweb 程序/md5/備份狀態
#   ./mzdeploy.sh rollback       還原 .prev 前版 binary 並重啟 daemon
#   ./mzdeploy.sh redeploy       災難重佈（韌體整包升級抹除 /opt 後）：deploy + 提示 zones 需重配或還原備份
#   ./mzdeploy.sh mzweb-install  佈署 mzweb（重建版 sipweb）到 /etc/sipweb/sipweb（首次自動備份 .orig）
#   ./mzdeploy.sh mzweb-rollback 還原 /etc/sipweb/sipweb.orig（原廠 sipweb）並重開機
#   ./mzdeploy.sh mzio-install   佈署 mzio（IO 動作 side-car）到 /opt/mzio（既有 binary 先備份為 .prev）
#   ./mzdeploy.sh mzio-status    健康檢查：mzio 程序、狀態檔、開機自啟檔案完整性
#
# 環境變數：MZHOST（預設 192.168.0.70，傳遞給 mzctl.py）、MZREST（預設 8090）
# 本地 mzweb binary 路徑：mzweb/build/mzweb-arm（此腳本在 src/ 內執行，相對路徑以 src/ 為基準）
set -e
cd "$(dirname "$0")"
CTL="python3 mzctl.py"
# mzstate mark 用（fleet 統一 root 密碼；與 mzctl.py 內建常數同源，分裂時一起改）
export MZSCAN_SSH_PW="${MZSCAN_SSH_PW:-BcastTerm2}"
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
	echo "== 寫標（mzstate mark，驗 actual==manifest 後 all-or-nothing）=="
	python3 mzstate.py mark --probe "$HOST" --components mzrelay3,S21mzrelay || exit 1
	;;
status)
	echo "-- 程序:"
	$CTL sh 'ps | grep mzrelay3 | grep -v grep | head -1; ls -la /opt/mzrelay3 /opt/mzrelay.conf /opt/mzzones.json /etc/init.d/S21mzrelay 2>&1'
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
	# mzweb 檢查段刻意排在 REST 檢查（下方，失敗會 exit 1）之前，
	# 確保 mzrelay3 REST 掛掉時 mzweb 健康狀態仍能先印出來，不被蓋掉
	# spec D+E §八：P7 後 mzrelay3 REST 是 loopback-only bind，跳板機遠端 curl 必被拒
	# （既有 bug）——改設備端 nc 對 127.0.0.1:8090 探測（同 mzscan sidecar_rest_ok 手法）。
	echo "-- REST /get/sip/multicast/zones（設備端 loopback，:$REST 為 loopback-only bind）:"
	REST_OUT=$($CTL sh 'printf "GET /get/sip/multicast/zones HTTP/1.1\r\nHost:127.0.0.1\r\nConnection: close\r\n\r\n" | nc 127.0.0.1 '"$REST"' 2>/dev/null | head -c 8192; echo')
	if echo "$REST_OUT" | grep -q '"zones"'; then
		echo "  REST OK（zones JSON 回應）"
	else
		echo "  REST 無回應/非 zones JSON — daemon 未啟或 loopback 埠不通"; exit 1
	fi
	;;
rollback)
	echo "== 還原 /opt/mzrelay3.prev =="
	if $CTL sh 'test -f /opt/mzrelay3.prev && echo PREV_YES || echo PREV_NO' | grep -q PREV_NO; then
		echo "無 /opt/mzrelay3.prev 可回退"; exit 1
	fi
	# spec D+E §八：先刪標、後動 binary；刪標失敗即中止（防 rollback 後殘標→假 drift）
	echo "== 先刪標（mzstate mark --delete mzrelay3）=="
	python3 mzstate.py mark --probe "$HOST" --components "" --delete mzrelay3 || {
		echo "✗ 刪標失敗，中止 rollback（binary 未動）"; exit 1; }
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
	# mzctl.py 退出碼不反映遠端結果，備份是否成立須抓輸出字串判斷、gate 住後續 put/mv
	BACKUP_CHECK=$($CTL sh '[ -f /etc/sipweb/sipweb.orig ] || cp /etc/sipweb/sipweb /etc/sipweb/sipweb.orig; test -f /etc/sipweb/sipweb.orig && echo ORIG_YES || echo ORIG_NO')
	echo "$BACKUP_CHECK"
	if echo "$BACKUP_CHECK" | grep -q ORIG_NO; then
		echo "✗ 備份 /etc/sipweb/sipweb.orig 失敗（唯讀掛載/磁碟滿等），為避免無回退保護下覆蓋原廠檔，中止 =="
		exit 1
	fi
	echo "== 上傳 mzweb binary =="
	$CTL put "$MZWEB_BIN" /etc/sipweb/sipweb.new
	echo "== 原子替換 /etc/sipweb/sipweb =="
	$CTL sh 'chmod +x /etc/sipweb/sipweb.new; mv /etc/sipweb/sipweb.new /etc/sipweb/sipweb'
	echo "== 啟用開機自啟：取消註解 S20ipgaurd 的 sipweb.sh（首次備份 .orig）=="
	# T11 現場實證：sipweb 拉起機制＝/etc/sipweb/sipweb.sh（respawn 監督迴圈 while[1] sipweb;sleep2），
	# 開機自啟那行在 /etc/init.d/S20ipgaurd 預設被註解 → 需取消註解，mzweb（置於 /etc/sipweb/sipweb）
	# 才會經監督迴圈於開機自啟並在 crash 時自動拉回。
	$CTL sh '[ -f /etc/init.d/S20ipgaurd.orig ] || cp /etc/init.d/S20ipgaurd /etc/init.d/S20ipgaurd.orig; sed -i "s|^#/etc/sipweb/sipweb.sh|/etc/sipweb/sipweb.sh|" /etc/init.d/S20ipgaurd'
	echo "⚠ 正在重啟 web 服務（kill 舊 sipweb，監督迴圈未跑則手動起 sipweb.sh）=="
	# 先 kill 現行 sipweb；若 sipweb.sh 監督迴圈已在跑會於 2s 內自動拉回 mzweb，否則手動背景啟動監督迴圈
	$CTL sh 'killall sipweb 2>/dev/null; sleep 1; ps|grep -v grep|grep -q "sipweb.sh" || setsid /etc/sipweb/sipweb.sh start >/dev/null 2>&1 & sleep 3'
	echo "== 驗證 web 服務是否已起（本機 loopback，busybox 無 wget 改 nc）=="
	$CTL sh 'printf "GET /get/device/status HTTP/1.1\r\nHost:127.0.0.1\r\nConnection: close\r\n\r\n" | nc 127.0.0.1 80 2>/dev/null | head -c 96; echo'
	echo "== 寫標（mzstate mark）=="
	python3 mzstate.py mark --probe "$HOST" --components mzweb || exit 1
	;;
mzio-install)
	[ -f mzweb/build/mzio-arm ] || { echo "缺 mzio-arm，先 make arm-mzio"; exit 1; }
	$CTL sh 'test -f /opt/mzio && cp /opt/mzio /opt/mzio.prev || true'
	$CTL put mzweb/build/mzio-arm /opt/mzio
	$CTL put S21mzio /etc/init.d/S21mzio
	$CTL sh 'chmod +x /opt/mzio /etc/init.d/S21mzio; killall mzio 2>/dev/null; sleep 1; /etc/init.d/S21mzio; sleep 1; ps | grep mzio | grep -v grep | head -2; sync'
	echo "== 寫標（mzstate mark）=="
	python3 mzstate.py mark --probe "$HOST" --components mzio,S21mzio || exit 1
	;;
mzio-status)
	$CTL sh 'ps | grep mzio | grep -v grep; cat /tmp/mzio_state 2>/dev/null; ls -la /opt/mzio /opt/mzio.json /etc/init.d/S21mzio 2>&1; tail -5 /tmp/mzio.boot.log 2>/dev/null'
	;;
mzweb-rollback)
	echo "⚠ 即將還原原廠 sipweb 並重開機設備 =="
	if $CTL sh 'test -f /etc/sipweb/sipweb.orig && echo ORIG_YES || echo ORIG_NO' | grep -q ORIG_NO; then
		echo "無 /etc/sipweb/sipweb.orig 可回退（需先成功跑過一次 mzweb-install 才有備份）"; exit 1
	fi
	# spec D+E §八：先刪標、後還原+reboot；刪標失敗即中止不 reboot（防殘標→假 drift）
	echo "== 先刪標（mzstate mark --delete mzweb）=="
	python3 mzstate.py mark --probe "$HOST" --components "" --delete mzweb || {
		echo "✗ 刪標失敗，中止 mzweb-rollback（未還原、未 reboot）"; exit 1; }
	# 一併還原 S20ipgaurd（回 found-state：開機自啟仍註解＝web off；避免 rogue hbi_web 被自啟續發 403）
	$CTL sh '[ -f /etc/init.d/S20ipgaurd.orig ] && cp /etc/init.d/S20ipgaurd.orig /etc/init.d/S20ipgaurd; cp /etc/sipweb/sipweb.orig /etc/sipweb/sipweb; sync; reboot'
	echo "已還原 /etc/sipweb/sipweb.orig（rogue hbi_web）＋S20ipgaurd 並觸發 reboot；回到部署前狀態（:80 web off）"
	;;
*)
	echo "usage: $0 {deploy|status|rollback|redeploy|mzweb-install|mzweb-rollback|mzio-install|mzio-status}"; exit 2
	;;
esac
