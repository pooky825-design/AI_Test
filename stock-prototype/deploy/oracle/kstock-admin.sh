#!/usr/bin/env bash
# K-Stock 관리자 명령 (v0.25) — 서버에서 실행
#   sudo kstock-admin list-users
#   sudo kstock-admin reset-password 이메일     (임시 비밀번호 발급)
# 서버는 DB를 메모리에 올려 두고 쓰므로, 잠깐 서비스를 멈추고 실행한 뒤 다시 켭니다(몇 초).
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "sudo 로 실행하세요."; exit 1; }
DATA_DIR="$(grep '^DATA_DIR=' /etc/kstock.env | cut -d= -f2-)"
systemctl stop kstock
runuser -u kstock -- env KSTOCK_MODE=cloud DATA_DIR="${DATA_DIR:-/var/lib/kstock}" node /opt/kstock/server/tools/admin.js "$@"
rc=$?
systemctl start kstock
exit $rc
