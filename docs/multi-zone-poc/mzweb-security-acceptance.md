# mzweb v6.1.2 安全強化真機驗收紀錄（.70，2026-07-23）

> 對應計畫 `docs/superpowers/plans/2026-07-23-mzweb-security-hardening.md` S-T12。
> 承接 P7 mzweb（明文版已於 .70 部署）；本階段升級為 HTTPS 版（S-T1–S-T11）。
> 驗收機：`192.168.0.70`（Goke GK7205V200 / OHLinux，root SSH :9521）。

## 一、部署

- HTTPS 版 mzweb arm 二進位：ELF ARM static，**392KB**（含精簡靜態 mbedTLS），md5 `99d3a57a…`。
- 備份鏈：`/etc/sipweb/sipweb.orig`＝rogue hbi_web（P7 備份）；`/etc/sipweb/sipweb.p7`＝P7 明文 mzweb（本次 rollback 目標）；`/etc/sipweb/sipweb`＝HTTPS mzweb。
- 首開 keygen（RSA-2048 自簽，單核 Goke A7）：`:443` 就緒約 **~12–15s**（一次性首開/改 IP 事件；<30s，可接受、不需背景化）。憑證 `/etc/sipweb/mz.crt`(0644)＋`/etc/sipweb/mz.key`(**0600** 私鑰限權)。

## 二、驗收結果

| 項 | 驗證 | 結果 |
|---|---|---|
| **SEC-03** HTTPS | `openssl s_client :443` 憑證 **SAN=IP Address:192.168.0.70** | ✅ |
| **SEC-03** 強制轉址 | `http://.70/get/device/status` → `301 Moved Permanently`、`Location: https://192.168.0.70/get/device/status` | ✅ |
| **SEC-03** 安全標頭 | 301 回應含 `X-Frame-Options: SAMEORIGIN`、`X-Content-Type-Options: nosniff` | ✅ |
| https login | `https://.70/auth/login` → 200＋token（GBK「登入成功」） | ✅ |
| **SEC-01** GET 加 token | `/get/sip/config` 無 token → **A003** | ✅ |
| **SEC-02** 密碼遮蔽 | `/get/sip/config` 帶 token → `primary_line.password == "********"` | ✅ |
| **SEC-04** 密碼雜湊 | `/etc/ifcfg-sip` 的 `WEB_PASSWORD` = `sha256$…`（首登從明文 123456 就地遷移）；遷移後仍能用原密碼登入 | ✅ |
| **SEC-06** 改密複雜度 | 改密 `<8` → **E001**；無數字 → **E001**（拒絕、不改密） | ✅ |
| **FW-01/02** JSON | `/get/device/status` `json.loads` 成功、`device_info`/`network_info` 在 root 同層、`broadcast_volume` key 在 | ✅ |
| 功能 zones over https | `/get/sip/multicast/zones` 帶 token → 16 區（轉呼 mzrelay3 loopback 不受 TLS 影響） | ✅ |
| 功能 GET / 內嵌頁 | `https://.70/` → 200、22923 bytes（gzip device-web 頁） | ✅ |
| **SEC-05** 登入鎖定 | 連 5 次錯密碼 → 第 6 次 **A005**；鎖定期內即使正確密碼也 A005 | ✅ |
| reboot 恢復 | 見 §三 | ✅ |

## 三、reboot 恢復

reboot（uptime 63s 確認真重開）後 init 自啟：`sipweb.sh` 監督 → mzweb（**:80＋:443 皆聽**）＋mzrelay3 loopback。**憑證持久**（mz.crt/mz.key 存活、次開不重 keygen、~12s 恢復 vs 首開 ~15s）。https login → `status:success`；`:80` → 301；憑證 **SAN 仍 = IP Address:192.168.0.70**。全鏈自動恢復。✅

## 四、SEC-05 登入鎖定

連 5 次錯密碼 → 第 6 次回 **A005**；鎖定期內（LOCK_MS=300000ms=5 分）即使正確密碼也回 A005。到期後 S-T9 的重置邏輯給全新 5 次機會。✅
⚠ 本測試後 admin 鎖定約 5 分鐘、自動解鎖——若隨後要以 CMS 實連，請等待或已過鎖定窗口。

## 五、CMS 應用層

CMS（sip-cms Electron app）已 https-first（`deviceApi.ts` baseURL `https://`）＋token-on-all。API 契約已於本次真機逐路由驗證（https login/GET/zones 全過）。**待使用者以 CMS app 對 .70 實連確認**（登入/狀態/SIP/組播/網路頁走 HTTPS），為最終應用層簽收——CMS 首次連自簽憑證會有一次「憑證非公開 CA」警告，點繼續即過（Grandstream 業界標準行為）。

## 六、回退

- `/etc/sipweb/sipweb.p7`（P7 明文 mzweb）→ 還原＋重啟即回 P7 明文版；`/etc/sipweb/sipweb.orig`（rogue hbi_web）→ 回部署前狀態。

## 七、生產化追蹤（非阻擋）

- 首開/改 IP keygen 同步阻塞 ~12–15s（單核 ARM）；可接受，若現場首開等待不可接受可改背景 keygen。
- fail-open：TLS 憑證 bootstrap 失敗時降級明文 :80 並經 syslog(LOG_ERR) 大聲告警（不靜默、不磚化）——設計決策。
- 改 IP 重簽：`mzcert_invalidate` 邏輯容器/碼驗證；真機改 IP 會中斷連線故未實地觸發，靠下次重啟以新 IP 重簽。
