# docs/multi-zone-poc/src/mzweb/Makefile — 一律在 mzweb/ 目錄下執行
DOCKER   = docker run --rm --platform linux/amd64 -v "$(CURDIR)":/src -w /src --entrypoint gcc
CC_ARM   = $(DOCKER) muslcc/x86_64:arm-linux-musleabi -march=armv7-a
CC_X86   = $(DOCKER) muslcc/x86_64:x86_64-linux-musl
CFLAGS   = -static -no-pie -fno-pie -O2 -I.
COMPAT   = socketbase.c hostsid.c keyvaluefile.c event.c webapi.c cjson_vendor.c readtemp.c mzcert.c mzhash.c

# --- T1: vendor mbedTLS 靜態編入 mzweb 目標 ---
MBEDTLS_SRC = $(wildcard mbedtls/library/*.c)
# 用不撞名的 config 檔名：vendor 樹裡有同名的官方 mbedtls_config.h，GCC 對 build_info.h
# 內 quoted #include MBEDTLS_CONFIG_FILE 會優先搜 build_info.h 同目錄 → 官方全量 config 會
# shadow 掉我方精簡版。改名 mzweb_mbedtls_config.h（vendor 無此檔）→ 落到 -I. 讀到精簡版。
MBEDTLS_INC = -Imbedtls/include -DMBEDTLS_CONFIG_FILE='"mzweb_mbedtls_config.h"'
COMPAT  += $(MBEDTLS_SRC)
CFLAGS  += $(MBEDTLS_INC)
APPSRC   = build/websetsip.c build/main.c mzweb_zones.c serve_index.c mzweb_txio.c mzsdk.c
COMPAT_TEST_keyvaluefile = keyvaluefile.c
COMPAT_TEST_cjson = cjson_vendor.c
COMPAT_TEST_event = event.c
# webapi.c 現在含 :443 TLS 終結（引用 mbedTLS＋mzcert），連 :80-only 測試也須連進這些單元。
COMPAT_TEST_webapi = event.c webapi.c socketbase.c mzcert.c $(MBEDTLS_SRC)
COMPAT_TEST_readtemp = readtemp.c
COMPAT_TEST_txio = mzweb_txio.c mzsdk.c cjson_vendor.c keyvaluefile.c
COMPAT_TEST_mbedtls_smoke = $(MBEDTLS_SRC)
COMPAT_TEST_mzcert = mzcert.c $(MBEDTLS_SRC)
# mzhash 需要 mbedtls_ctr_drbg 產 salt，其熵源 mbedtls_hardware_poll() 由 mzcert.c 提供
# （精簡 config 開 MBEDTLS_ENTROPY_HARDWARE_ALT，故連 mzhash 單元測試也需連進這顆符號）。
COMPAT_TEST_mzhash = mzhash.c mzcert.c $(MBEDTLS_SRC)
COMPAT_TEST_webapi_tls = event.c webapi.c socketbase.c mzcert.c $(MBEDTLS_SRC)
# test_webapi 用縮短的 idle timeout/清掃週期，讓 http_test.py 的 slow-loris 斷言免等 30s。
# 僅作用於此測試二進位；production arm/x86 目標編 webapi.c 不帶此旗標，維持預設 30000ms。
TESTDEF_webapi = -DIDLE_MS=1000 -DSWEEP_MS=250
# test_webapi_tls：縮短寫出硬上限（OUT_TIMEOUT_MS）讓 https_test.py 的寫出面 slow-loris
# 回收斷言免等 30s。關鍵設計——IDLE_MS 刻意「大於」OUT_TIMEOUT_MS：測試窗內只有 out_deadline
# 會觸發回收（idle 不會），使新回收 case 具鑑別力（未修版無 out_deadline → idle 於窗內不觸發 →
# slot 被占住 → 斷言失敗）；同時兩者皆遠高於既有大回應/慢讀 case 3（~2s 活動）→ 不誤殺、不截斷。
# OUT_MAX 覆蓋為 3MiB：test_webapi_tls 的 /big 刻意回 2MiB（遠大於 socket 送出緩衝 → 逼出
# WANT_WRITE）＋標頭 > 2MiB production 預設，故此測試二進位放寬護欄；production 維持 2MiB。
TESTDEF_webapi_tls = -DIDLE_MS=10000 -DOUT_TIMEOUT_MS=4000 -DHS_TIMEOUT_MS=10000 -DOUT_MAX=3145728 -DSWEEP_MS=250
# --- SEC-05 測試專用：縮短 LOCK_MS，讓 test_sec05.py 能在測試視窗內驗證「鎖定到期後
# 重置失敗計數，給全新 5 次機會」（見 websetsip-p7.patch 內 SEC-05-fix 註解），免等
# production 預設的 5 分鐘。僅作用於此測試二進位（build/mzweb-x86-sec05）；production
# x86-mzweb/arm-mzweb 仍用 patch 內建 LOCK_MS=300000 預設，不受影響。
TESTDEF_sec05 = -DLOCK_MS=1500

build/websetsip.c: ../../../firmware-reference/websetsip.c websetsip-p7.patch
	mkdir -p build
	cp ../../../firmware-reference/websetsip.c build/websetsip.c
	cp ../../../firmware-reference/main.c build/main.c
	cp ../../../firmware-reference/websetsip.h build/websetsip.h
	patch build/websetsip.c < websetsip-p7.patch
	python3 txio_inject.py build/websetsip.c

arm-mzweb: build/websetsip.c
	$(CC_ARM) $(CFLAGS) -o build/mzweb-arm $(APPSRC) $(COMPAT)

x86-mzweb: build/websetsip.c
	$(CC_X86) $(CFLAGS) -o build/mzweb-x86 $(APPSRC) $(COMPAT)

# x86-mzweb-sec05：同 x86-mzweb，但 -DLOCK_MS 覆蓋為短值，供 tests/test_sec05.py 驗證
# 「鎖定到期後重置」語意用。與 x86-mzweb 共用同一份 build/websetsip.c（同一 patch 產物），
# 差異只在編譯時的 LOCK_MS 巨集覆蓋，不影響 production 目標。
x86-mzweb-sec05: build/websetsip.c
	$(CC_X86) $(CFLAGS) $(TESTDEF_sec05) -o build/mzweb-x86-sec05 $(APPSRC) $(COMPAT)

# x86-orig：未修改原廠 websetsip.c（GBK 原始碼，非 patch/zones/serve_index 版）＋相容層。
# 相容層正確性的整合閘門——只有把 T1–T5 一起連進 3022 行真實原廠碼才知道夠不夠用。
# 用 GBK 原始檔（非 utf8 轉檔版）保住字節級相容；build/ 已 gitignore，原廠碼不進版控。
x86-orig:
	mkdir -p build
	cp ../../../firmware-reference/websetsip.c build/websetsip-orig.c
	cp ../../../firmware-reference/main.c build/main.c
	cp ../../../firmware-reference/websetsip.h build/websetsip.h
	$(CC_X86) $(CFLAGS) -o build/mzweb-x86-orig build/websetsip-orig.c build/main.c $(COMPAT)

host-%: tests/test_%.c
	mkdir -p build
	$(CC_X86) $(CFLAGS) $(TESTDEF_$*) -o build/test_$* $< $(COMPAT_TEST_$*)

clean:
	rm -rf build
