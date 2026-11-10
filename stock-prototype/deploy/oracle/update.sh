#!/usr/bin/env bash
# K-Stock 서버 업데이트 (v0.25): 새 코드를 받은 뒤 실행. 데이터·설정은 그대로 유지
#   cd ~/ai_test && git pull && cd stock-prototype && sudo bash deploy/oracle/update.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "sudo 로 실행하세요."; exit 1; }
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
APP=/opt/kstock
[ -d "$APP" ] || { echo "먼저 setup.sh 로 설치하세요."; exit 1; }
cp /var/lib/kstock/stock.db "/var/backups/kstock/stock-before-update-$(date +%F-%H%M).db" 2>/dev/null || true
rsync -a --delete \
  --exclude node_modules --exclude data --exclude data-sample --exclude android --exclude dist \
  --exclude release --exclude docs --exclude .git --exclude '*.bat' \
  "$SRC/" "$APP/"
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund)
chown -R root:root "$APP"
install -m 755 "$SRC/deploy/oracle/kstock-admin.sh" /usr/local/bin/kstock-admin
systemctl restart kstock
sleep 2
curl -fsS http://127.0.0.1:3000/api/health && echo && echo "업데이트 완료"
