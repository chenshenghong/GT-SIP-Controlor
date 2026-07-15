#!/bin/sh
# gen-self-signed-cert.sh — GT-SIP-GW 设备自签证书生成（配套 SEC-03 / HTTPS）
#
# 用途：每台设备首次开机生成「唯一」自签证书，供 web 服务走 :443 HTTPS。
#       已存在且 SAN 匹配当前 IP 则跳过；IP 变更（SAN 不匹配）则自动重签。
# 调用：在启动脚本中、早于 init_web_listen 执行：
#         sh gen-self-signed-cert.sh                # 自动探测设备 IP
#         sh gen-self-signed-cert.sh 192.168.0.147  # 显式指定 IP
# 兼容：POSIX sh，可在 busybox 下运行。需 rootfs 内有 openssl。
#
# 可用环境变量覆盖默认：
#   CERT=/etc/ifcfg-web.crt  KEY=/etc/ifcfg-web.key  DAYS=3650
set -eu

CERT="${CERT:-/etc/ifcfg-web.crt}"
KEY="${KEY:-/etc/ifcfg-web.key}"
DAYS="${DAYS:-3650}"
SUBJ="/C=TW/O=Guangtian Information/CN=GT-SIP-GW"

# ---- 1) 取当前设备 IP：参数优先，否则自动探测第一个非 127 的 IPv4 ----
IP="${1:-}"
if [ -z "$IP" ]; then
  IP=$(ip -4 addr show 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 \
       | grep -v '^127\.' | head -n1 || true)
  if [ -z "$IP" ]; then
    IP=$(ifconfig 2>/dev/null | awk '/inet /{print $2}' | sed 's/addr://' \
         | grep -v '^127\.' | head -n1 || true)
  fi
fi
if [ -z "$IP" ]; then
  echo "[cert] 无法探测设备 IP，请以参数传入：$0 <device-ip>" >&2
  exit 1
fi

# 把 IP 中的点转义，供后续精确匹配（避免 .14 命中 .147）
IPRE=$(printf '%s' "$IP" | sed 's/\./\\./g')

# ---- 2) 已有证书且 SAN 含当前 IP → 跳过 ----
if [ -f "$CERT" ] && [ -f "$KEY" ]; then
  if openssl x509 -in "$CERT" -noout -text 2>/dev/null \
       | grep -Eq "IP Address:${IPRE}([^0-9]|\$)"; then
    echo "[cert] 已存在且 SAN 匹配当前 IP ($IP)，跳过生成。"
    exit 0
  fi
  echo "[cert] 现有证书 SAN 不含当前 IP ($IP)（可能改过 IP），重新生成。"
fi

# ---- 3) 生成唯一自签证书（含 SAN=IP，现代浏览器必须） ----
echo "[cert] 为 $IP 生成自签证书 ..."
umask 077

# 优先用 -addext（OpenSSL 1.1.1+）；老版本不支持则回退到临时 config
if openssl req -x509 -newkey rsa:2048 -nodes \
     -keyout "$KEY" -out "$CERT" -days "$DAYS" \
     -subj "$SUBJ" -addext "subjectAltName=IP:${IP}" 2>/dev/null; then
  :
else
  echo "[cert] -addext 不可用，回退到临时 config（旧版 openssl）。"
  CONF=$(mktemp 2>/dev/null || echo "/tmp/gtsipgw-ssl.$$")
  cat > "$CONF" <<EOF
[req]
distinguished_name = dn
x509_extensions    = v3
prompt             = no
[dn]
C  = TW
O  = Guangtian Information
CN = GT-SIP-GW
[v3]
subjectAltName = IP:${IP}
EOF
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$KEY" -out "$CERT" -days "$DAYS" -config "$CONF"
  rm -f "$CONF"
fi

chmod 600 "$KEY"
chmod 644 "$CERT"
echo "[cert] 完成：$CERT / $KEY (SAN=IP:$IP, $DAYS 天)"
