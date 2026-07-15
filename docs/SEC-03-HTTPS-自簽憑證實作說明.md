# GT-SIP-GW 设备 HTTPS（自签证书）实作说明

> 配套需求：**SEC-03**（提供 HTTPS 管理通道）。
> 本文为**独立实作说明，不并入需求单**；可直接转交固件 / 产线工程师。
> 配套文件：`gen-self-signed-cert.sh`（产线 PC 用 openssl 预生成）、`wolfssl-https-example.c`（设备端 wolfSSL 参考实作）。
> 设备实况：rootfs **自带 wolfSSL、无 openssl 命令行**。日期：2026-06-30

---

## 0. 一句话

每台设备拥有**唯一自签证书**，web 服务据此走 **HTTPS**，`:80` 强制 `301` 跳 `:443`。首次访问浏览器会有**一次**"证书颁发机构无效"警告，点"继续"即过——这正是 Grandstream / 海康 / Axis 等同级 SIP / 网络设备的出货标准做法。

---

## 1. 先厘清一个常见误解（关于"证书非法、不安全"）

浏览器那个警告，针对的是**"证书是否由公开 CA 签发"的身份认证**，**不是说连接没加密、不安全**。

- 自签 HTTPS 一样**全程 TLS 加密**，能挡住 SEC-03 要防的"同网段窃听账号密码 / token / SIP 明文密码"，安全性**严格高于**现在的纯 HTTP（纯 HTTP 是零加密）。点一次"继续"即可，之后正常使用。
- "提供一张公开 CA 信任的证书"对**用私有 IP（192.168.x.x）在局域网访问**的设备**技术上不可行**：公开 CA 自 2015 年起依 CA/Browser Forum 规则**禁止为私有 IP / 内网名签发受信任证书**；Let's Encrypt 也要求公开域名验证，局域网设备两者都没有。
- 而且**全部设备烧同一张证书 = 共用同一把私钥**，从任一台挖出私钥即所有设备 TLS 一起沦陷——这本身是更大的漏洞。

**结论：正确做法是每台设备拥有唯一自签证书。**

---

## 2. 关于"没有 openssl"：命令行 ≠ TLS 库（两件事别混）

| | openssl **命令行工具** | **TLS 库**（libssl/libcrypto 或 mbedTLS / **wolfSSL**） |
|---|---|---|
| 作用 | 只在"生成证书"这一步用到 | "设备能不能跑 HTTPS"的关键 |

"没有 openssl"通常指没有**命令行**。但本设备 rootfs **自带 wolfSSL**——它**同时**能产生自签证书（含 IP SAN）**和**跑 HTTPS，一个库全包，**完全不需要 openssl 命令行**。

下面分两个轴：**产生证书（路 A / B）** 与 **跑 HTTPS（路 1 / 2）**，最后是强制跳转与硬退路（路 C）。

> ⚠ 因为没有 openssl，**stunnel（依赖 openssl）不可用**——跑 HTTPS 只能靠 `init_web_listen` 的 TLS 参数或用 wolfSSL 自行 wrap socket（见路 1 / 2）。

---

## 3. 产生证书：路 A / 路 B

先确认 wolfSSL 编译时开了哪些选项（决定能不能在设备端自签）：

```sh
grep -E 'WOLFSSL_KEY_GEN|WOLFSSL_CERT_GEN|WOLFSSL_CERT_EXT|WOLFSSL_ALT_NAMES' \
     /usr/include/wolfssl/options.h
```

### 路 A（首选）：设备端用 wolfSSL 自签

四个宏都有 → 在**首次开机**及**改 IP 后重启**时，用 wolfCrypt 自签（SAN=IP），证书 / 私钥写入持久分区。完整范例见 **`wolfssl-https-example.c`** 的 `gen_self_signed()`，核心：

```c
wc_MakeRsaKey(&key, 2048, 65537, &rng);          /* WOLFSSL_KEY_GEN */
wc_InitCert(&cert); /* subject=GT-SIP-GW / Guangtian Information / TW */
cert.sigType = CTC_SHA256wRSA; cert.daysValid = 3650; cert.isCA = 0;
/* SAN=IP：手刻 GeneralNames DER「30 06 87 04 a b c d」最稳，跨版本可用 */
memcpy(cert.altNames, san, 8); cert.altNamesSz = 8;   /* WOLFSSL_ALT_NAMES */
wc_MakeSelfCert(&cert, derCert, sizeof derCert, &key, &rng);  /* WOLFSSL_CERT_GEN */
```

**优点**：设备端零外部依赖；改 IP **自动重签**（删旧 crt/key → 重启首开用新 IP 重生成）。产物为 **DER** → 载入用 `WOLFSSL_FILETYPE_ASN1`。

**三个关键点（漏一个就失败）：**
1. **SAN（IP）必须有**：现代 Chrome / Edge / Firefox 忽略 CN、只认 SAN。没有 SAN 会报更严重的 `ERR_CERT_COMMON_NAME_INVALID`，部分策略下连"继续"都被挡。
2. **私钥每台唯一、`chmod 600`、存持久分区**（掉电不丢）。
3. **改 IP 自动重签**：在现有"改 IP→重启"流程里删掉旧 crt/key 即可，无需额外改动。

> ⚠ 嵌入式注意：RSA-2048 在弱 CPU + 低熵下首开可能耗时几秒甚至阻塞（等 `/dev/random`）。建议**后台生成、不阻塞主服务启动**；有硬件 RNG 就喂 `/dev/urandom`。

### 路 B：wolfSSL 没开 certgen / keygen 时（两个子选项）

上面四个宏缺了 → 设备端当下无法用 wolfSSL 签。二选一：

- **B-1　重编 wolfSSL 加旗标（之后即走路 A）**
  ```sh
  ./configure <保留现有 SIP-TLS 选项> --enable-keygen --enable-certgen --enable-certext
  make && make install
  ```
  代价：库体积略增。好处：设备端自签 + 改 IP 自动重签全保留。

- **B-2　产线预生成（设备端零依赖）**
  产线 PC（有 openssl）用 **`gen-self-signed-cert.sh`** 为**每台**设备生成唯一证书（SAN=该机出厂 IP），刷机时烧入持久分区：
  ```sh
  # 产线 PC，每台设备跑一次（IP 换成该机）
  CERT=out/devXXX.crt KEY=out/devXXX.key sh gen-self-signed-cert.sh 192.168.0.147
  # 再把这两档烧进该设备的 /etc/ifcfg-web.crt /.key
  ```
  设备端 wolfSSL 只负责**载入**，不需任何 gen 能力。
  - ⚠ 此脚本产 **PEM** → 载入要用 `WOLFSSL_FILETYPE_PEM`（不是路 A 的 ASN1）。
  - 代价：用户之后**改 IP** → SAN 不符 → 浏览器报 `ERR_CERT_COMMON_NAME_INVALID`（仍可"继续"）。SEC-03 基线本就接受一次警告，可接受；若要消除，加"上传证书"功能或改 IP 后重新 provision。

---

## 4. 跑 HTTPS：路 1 / 路 2

证书就绪后，让 web 服务走 TLS。

### 路 1（首选，改动最小）：用 `init_web_listen` 的 TLS 参数

当前监听（`websetsip.c`）：

```c
init_web_listen(web_port, http_callback, get_main_event_loop(),
    NULL, 0,   // ← 这三组 NULL,0 用途未公开，疑为 cert / key / CA 预留缓冲槽
    NULL, 0,
    NULL, 0,
    request_url, 19, care_key_name, 1, 0);
```

**既然 SDK 本身就带 wolfSSL，那三组 `NULL,0` 很可能正是 wolfSSL 的 cert / key / CA 槽。** 请查 SDK 头文件 / 文档确认 `init_web_listen` 完整签名——若是，启用 HTTPS 可能只需：把证书 / 私钥读进 buffer 塞入对应槽 + 端口改 443，**完全不动 `http_callback`、也不用自己 wrap socket**。这是最省力的一条。

### 路 2（SDK 不支持时）：用 wolfSSL 自行 wrap socket

在服务的 accept() 循环里，每条连线包一层 wolfSSL。完整范例见 **`wolfssl-https-example.c`** 的 `https_ctx_setup()` / `handle_one_conn()`，核心：

```c
wolfSSL_Init();
WOLFSSL_CTX* ctx = wolfSSL_CTX_new(wolfTLS_server_method());      /* TLS1.2/1.3 */
wolfSSL_CTX_use_certificate_file(ctx, WEB_CRT, WOLFSSL_FILETYPE_ASN1);  /* PEM→改 ASN1 为 PEM */
wolfSSL_CTX_use_PrivateKey_file (ctx, WEB_KEY, WOLFSSL_FILETYPE_ASN1);
/* 每条 accept() 的 client_fd： */
WOLFSSL* ssl = wolfSSL_new(ctx);
wolfSSL_set_fd(ssl, client_fd);
if (wolfSSL_accept(ssl) == WOLFSSL_SUCCESS) {
    /* 把 recv()/send() 换成 wolfSSL_read()/wolfSSL_write() */
}
```

---

## 5. 强制 HTTPS（`:80` → `:443`）

`http_callback` 开头判断：非 TLS（从 `:80` 进入）一律回 301，不再吐明文页面：

```
HTTP/1.1 301 Moved Permanently
Location: https://<取自 Host 头>/
```

（Grandstream 等同级设备即此做法：`:80` 一律 301 到 https。）

---

## 6. 硬退路（路 C）：评估后完全不做 TLS

理论上设备有 wolfSSL 不该走到这；但若硬件 / 工期 / footprint 评估都不允许跑 HTTPS：

- **做法**：回到 SEC-03 已写的最低要求——web `:80` **绑定管理网段 / VLAN**，只允许管理子网访问，缩小明文暴露面。
- **残余风险**：仍是明文 HTTP，管理网段内可被窃听；须在交付文档**明确载明这是降级方案、未满足 SEC-03 的加密要求，仅缩小暴露面**（不可当作"已修 SEC-03"）。
- **验收**：从非管理网段访问 `:80` 应被拒；仅管理网段可登录。

---

## 7. 优先序建议

先查 wolfSSL 那四个编译宏：
1. 都有 → **路 A**（设备端自签，最理想）；
2. 没有但能重编 → **路 B-1**（换回路 A 的好处）；
3. 不能动库 → **路 B-2**（产线 PC openssl 预生成）；
4. 全都不行才退 → **路 C**（网段绑定，文档须标明未真正满足 SEC-03）。

跑 HTTPS 优先 **路 1**（init_web_listen TLS 槽），不支持再 **路 2**（wolfSSL wrap socket）。

---

## 8. 验收标准

- 可用 `https://<设备IP>/` 登录并操作；首访一次 `ERR_CERT_AUTHORITY_INVALID` 警告、点"继续"即过，**属正常、即验收通过**。
- `http://<设备IP>/` 自动 `301` 跳转到 https。
- 每台设备证书指纹不同（在有 openssl 的机器上验证）：
  `openssl s_client -connect <IP>:443 </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256`
- 走路 A：改 IP 并重启后，新 IP 下 https 仍可访问（证书已按新 IP 重签）。

---

## 9. 选配：连"首次警告"也消除（非上线必需）

- 提供"**下载设备证书 / 显示 SHA-256 指纹**"，管理员一次性导入系统 / 浏览器信任库 → 该机器不再警告；
- 或支持"**上传客户自有证书 + 私钥**"，企业内网有自己 CA 时签发设备主机名证书 → 零警告。

两者皆为增强项，**不是 SEC-03 上线的必要条件**。
