# docs/multi-zone-poc/src/mzweb/Makefile — 一律在 mzweb/ 目錄下執行
DOCKER   = docker run --rm --platform linux/amd64 -v "$(CURDIR)":/src -w /src --entrypoint gcc
CC_ARM   = $(DOCKER) muslcc/x86_64:arm-linux-musleabi -march=armv7-a
CC_X86   = $(DOCKER) muslcc/x86_64:x86_64-linux-musl
CFLAGS   = -static -no-pie -fno-pie -O2 -I.
COMPAT   = socketbase.c hostsid.c keyvaluefile.c event.c webapi.c cjson_vendor.c readtemp.c

# --- T1: vendor mbedTLS 靜態編入 mzweb 目標 ---
MBEDTLS_SRC = $(wildcard mbedtls/library/*.c)
MBEDTLS_INC = -Imbedtls/include -I. -DMBEDTLS_CONFIG_FILE='"mbedtls_config.h"'
COMPAT  += $(MBEDTLS_SRC)
CFLAGS  += $(MBEDTLS_INC)
APPSRC   = build/websetsip.c build/main.c mzweb_zones.c serve_index.c
COMPAT_TEST_keyvaluefile = keyvaluefile.c
COMPAT_TEST_cjson = cjson_vendor.c
COMPAT_TEST_event = event.c
COMPAT_TEST_webapi = event.c webapi.c socketbase.c
COMPAT_TEST_readtemp = readtemp.c
COMPAT_TEST_mbedtls_smoke = $(MBEDTLS_SRC)
# test_webapi 用縮短的 idle timeout/清掃週期，讓 http_test.py 的 slow-loris 斷言免等 30s。
# 僅作用於此測試二進位；production arm/x86 目標編 webapi.c 不帶此旗標，維持預設 30000ms。
TESTDEF_webapi = -DIDLE_MS=1000 -DSWEEP_MS=250

build/websetsip.c: ../../../firmware-reference/websetsip.c websetsip-p7.patch
	mkdir -p build
	cp ../../../firmware-reference/websetsip.c build/websetsip.c
	cp ../../../firmware-reference/main.c build/main.c
	cp ../../../firmware-reference/websetsip.h build/websetsip.h
	patch build/websetsip.c < websetsip-p7.patch

arm-mzweb: build/websetsip.c
	$(CC_ARM) $(CFLAGS) -o build/mzweb-arm $(APPSRC) $(COMPAT)

x86-mzweb: build/websetsip.c
	$(CC_X86) $(CFLAGS) -o build/mzweb-x86 $(APPSRC) $(COMPAT)

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
