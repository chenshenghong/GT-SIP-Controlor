# docs/multi-zone-poc/src/mzweb/Makefile — 一律在 mzweb/ 目錄下執行
DOCKER   = docker run --rm --platform linux/amd64 -v "$(CURDIR)":/src -w /src --entrypoint gcc
CC_ARM   = $(DOCKER) muslcc/x86_64:arm-linux-musleabi -march=armv7-a
CC_X86   = $(DOCKER) muslcc/x86_64:x86_64-linux-musl
CFLAGS   = -static -no-pie -fno-pie -O2 -I.
COMPAT   = socketbase.c hostsid.c keyvaluefile.c event.c webapi.c cJSON.c
APPSRC   = build/websetsip.c build/main.c mzweb_zones.c serve_index.c
COMPAT_TEST_keyvaluefile = keyvaluefile.c

build/websetsip.c: ../../firmware-reference/websetsip.c websetsip-p7.patch
	mkdir -p build
	cp ../../firmware-reference/websetsip.c build/websetsip.c
	cp ../../firmware-reference/main.c build/main.c
	patch build/websetsip.c < websetsip-p7.patch

arm-mzweb: build/websetsip.c
	$(CC_ARM) $(CFLAGS) -o build/mzweb-arm $(APPSRC) $(COMPAT)

x86-mzweb: build/websetsip.c
	$(CC_X86) $(CFLAGS) -o build/mzweb-x86 $(APPSRC) $(COMPAT)

host-%: tests/test_%.c
	$(CC_X86) $(CFLAGS) -o build/test_$* $< $(COMPAT_TEST_$*)

clean:
	rm -rf build
