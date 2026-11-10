#!/usr/bin/env bash
# K-Stock 클라우드 서버 설치 스크립트 (v0.25)
# 대상: Oracle Cloud(또는 다른 클라우드) Ubuntu 22.04 / 24.04 서버, ARM(Ampere)·x86 모두 가능
#
# 사용법 (저장소의 stock-prototype 폴더에서):
#   sudo DOMAIN=kstock.duckdns.org SIGNUP_CODE=우리집코드 bash deploy/oracle/setup.sh
# 선택:
#   DUCKDNS_TOKEN=...   DuckDNS 주소를 쓸 때 서버 IP를 자동으로 등록·갱신
#
# 하는 일: Node.js·Caddy 설치 → 앱을 /opt/kstock 에 설치 → 전용 계정(kstock)으로 서비스 실행
#          → HTTPS 인증서 자동 발급(Caddy) → 80/443 포트 열기 → 자동 보안 업데이트·fail2ban
#          → 매일 DB 백업(/var/backups/kstock, 14일 보관) → 관리자 명령 kstock-admin 설치
# 여러 번 실행해도 안전합니다(이미 설치된 것은 건너뜀, 데이터는 유지).
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "sudo 로 실행하세요."; exit 1; }
: "${DOMAIN:?DOMAIN 을 지정하세요. 예) sudo DOMAIN=kstock.duckdns.org bash deploy/oracle/setup.sh}"
SIGNUP_CODE="${SIGNUP_CODE:-}"
DUCKDNS_TOKEN="${DUCKDNS_TOKEN:-}"
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
APP=/opt/kstock
DATA=/var/lib/kstock
BACKUP=/var/backups/kstock
export DEBIAN_FRONTEND=noninteractive

[ -f "$SRC/server/index.js" ] || { echo "stock-prototype 폴더 안에서 실행하세요 ($SRC)"; exit 1; }

echo "[1/9] 기본 패키지"
apt-get update -y
apt-get install -y curl ca-certificates gnupg rsync unattended-upgrades fail2ban \
  debian-keyring debian-archive-keyring apt-transport-https

echo "[2/9] Node.js 22"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
NODE_BIN="$(command -v node)"
node -v

echo "[3/9] Caddy (HTTPS 자동 인증서)"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "[4/9] 앱 설치 ($APP)"
id kstock >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin kstock
mkdir -p "$APP" "$DATA" "$BACKUP"
rsync -a --delete \
  --exclude node_modules --exclude data --exclude data-sample --exclude android --exclude dist \
  --exclude release --exclude docs --exclude .git --exclude '*.bat' \
  "$SRC/" "$APP/"
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund)
chown -R root:root "$APP"
chown -R kstock:kstock "$DATA"
chmod 750 "$DATA"
chmod 700 "$BACKUP"

echo "[5/9] 설정 파일 (/etc/kstock.env)"
if [ ! -f /etc/kstock.env ]; then
  cat > /etc/kstock.env <<ENV
KSTOCK_MODE=cloud
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
DATA_DIR=$DATA
SIGNUP_CODE=$SIGNUP_CODE
ENV
elif [ -n "$SIGNUP_CODE" ]; then
  sed -i "s|^SIGNUP_CODE=.*|SIGNUP_CODE=$SIGNUP_CODE|" /etc/kstock.env
fi
chmod 600 /etc/kstock.env

echo "[6/9] 서비스 등록 (kstock.service)"
cat > /etc/systemd/system/kstock.service <<UNIT
[Unit]
Description=K-Stock 주식 자산 관리 서버
After=network-online.target
Wants=network-online.target

[Service]
User=kstock
Group=kstock
EnvironmentFile=/etc/kstock.env
WorkingDirectory=$APP
ExecStart=$NODE_BIN server/index.js
Restart=always
RestartSec=5
# 보안: 앱은 데이터 폴더만 쓸 수 있고 권한 상승 불가
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable kstock >/dev/null
systemctl restart kstock

echo "[7/9] HTTPS 설정 (Caddy → 127.0.0.1:3000)"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
	header -Server
}
CADDY
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

echo "[8/9] 방화벽(80·443 열기), 자동 보안 업데이트, fail2ban"
# Oracle Ubuntu 이미지는 iptables 에 모두 거부(REJECT) 규칙이 있어 그 앞에 허용 규칙을 넣어야 한다
if command -v iptables >/dev/null 2>&1; then
  for p in 80 443; do
    if ! iptables -C INPUT -p tcp -m state --state NEW --dport "$p" -j ACCEPT 2>/dev/null; then
      n="$(iptables -L INPUT --line-numbers -n | awk '/REJECT/{print $1; exit}')"
      if [ -n "$n" ]; then iptables -I INPUT "$n" -p tcp -m state --state NEW --dport "$p" -j ACCEPT
      else iptables -A INPUT -p tcp -m state --state NEW --dport "$p" -j ACCEPT; fi
    fi
  done
  if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save >/dev/null; fi
fi
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then ufw allow 80/tcp; ufw allow 443/tcp; fi
cat > /etc/apt/apt.conf.d/20auto-upgrades <<APT
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT
systemctl enable --now fail2ban >/dev/null 2>&1 || true
if sshd -T 2>/dev/null | grep -qi '^passwordauthentication yes'; then
  echo "  ⚠ SSH 비밀번호 로그인이 켜져 있습니다. 키 파일 로그인만 쓰도록 끄는 것을 권장합니다(README 참고)."
fi

echo "[9/9] 매일 백업, 관리자 명령, DuckDNS"
cat > /etc/cron.daily/kstock-backup <<'CRON'
#!/bin/sh
# K-Stock DB 매일 백업 (14일 보관)
set -e
d=/var/backups/kstock
mkdir -p "$d"
[ -f /var/lib/kstock/stock.db ] && cp /var/lib/kstock/stock.db "$d/stock-$(date +%F).db"
chmod 600 "$d"/stock-*.db 2>/dev/null || true
find "$d" -name 'stock-*.db' -mtime +14 -delete
CRON
chmod 755 /etc/cron.daily/kstock-backup
install -m 755 "$SRC/deploy/oracle/kstock-admin.sh" /usr/local/bin/kstock-admin
if [ -n "$DUCKDNS_TOKEN" ] && [[ "$DOMAIN" == *.duckdns.org ]]; then
  SUB="${DOMAIN%.duckdns.org}"
  printf 'SUB=%s\nTOKEN=%s\n' "$SUB" "$DUCKDNS_TOKEN" > /etc/kstock-duckdns.env
  chmod 600 /etc/kstock-duckdns.env
  cat > /etc/cron.d/kstock-duckdns <<'DDNS'
*/10 * * * * root . /etc/kstock-duckdns.env && curl -fsS "https://www.duckdns.org/update?domains=$SUB&token=$TOKEN&ip=" >/dev/null 2>&1
DDNS
  . /etc/kstock-duckdns.env && curl -fsS "https://www.duckdns.org/update?domains=$SUB&token=$TOKEN&ip=" && echo " (DuckDNS 갱신)"
fi

sleep 2
if curl -fsS http://127.0.0.1:3000/api/health >/dev/null; then
  echo
  echo "=============================================="
  echo " 설치 완료: https://$DOMAIN"
  echo " 가입 코드: $(grep '^SIGNUP_CODE=' /etc/kstock.env | cut -d= -f2- | sed 's/^$/(없음 — 누구나 가입 가능)/')"
  echo " 상태 확인: systemctl status kstock / journalctl -u kstock -f"
  echo " 비밀번호 재설정: sudo kstock-admin reset-password 이메일"
  echo " 처음 접속할 때 HTTPS 인증서 발급에 1분쯤 걸릴 수 있습니다."
  echo "=============================================="
else
  echo "서버가 응답하지 않습니다. journalctl -u kstock -n 50 으로 오류를 확인하세요." >&2
  exit 1
fi
