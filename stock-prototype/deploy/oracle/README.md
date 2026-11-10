# K-Stock 클라우드 서버 만들기 (Oracle Cloud 무료 서버)

다른 기기(다른 사람의 휴대폰·PC)와 화면을 공유하려면 K-Stock 서버를 인터넷에 하나 만들어 두고, 모든 기기가 그 서버에 접속하게 합니다. 이 안내는 **Oracle Cloud의 Always Free(기간 제한 없는 무료) 서버**를 기준으로 합니다. 같은 스크립트는 네이버 클라우드 등 다른 Ubuntu 서버에서도 동작합니다.

> 필요한 것: 이메일, 결제 카드(Oracle 가입 시 본인 확인용, 유료 전환을 직접 하지 않으면 청구되지 않음), PC(Windows는 PowerShell 사용), 약 30~60분
>
> 무료 요금제 조건은 바뀔 수 있으니 가입할 때 Oracle 안내를 확인하세요.

---

## 1. Oracle Cloud 가입

1. <https://www.oracle.com/kr/cloud/free/> 에서 **무료로 시작하기**를 누르고 가입합니다.
2. **홈 리전**은 **South Korea Central (Seoul)** 또는 **South Korea North (Chuncheon)** 을 고릅니다.
   - 홈 리전은 나중에 바꿀 수 없고, 무료 서버는 홈 리전에서만 만들 수 있습니다.

## 2. 무료 서버(인스턴스) 만들기

1. 콘솔 메뉴 **컴퓨트 → 인스턴스 → 인스턴스 생성**
2. **이미지**: *Canonical Ubuntu 24.04* (또는 22.04)
3. **Shape**: *Ampere → VM.Standard.A1.Flex* (1 OCPU, 6GB 메모리면 충분)
   - "용량 부족"이 나오면 잠시 뒤 다시 시도하거나 *VM.Standard.E2.1.Micro* 를 고릅니다.
4. **SSH 키**: *키 쌍 생성*을 고르고 **개인 키 저장**을 눌러 `ssh-key-....key` 파일을 꼭 내려받아 둡니다(다시 받을 수 없음).
5. **생성**을 누르고, 상태가 *실행 중*이 되면 **공용 IP 주소**를 메모합니다.

## 3. 웹 접속 포트(80·443) 열기

1. 인스턴스 화면의 **서브넷** 링크 → **보안 목록(Default Security List)** → **수신 규칙 추가**
2. 소스 CIDR `0.0.0.0/0`, IP 프로토콜 `TCP`, 대상 포트 `80,443` 으로 추가합니다.
   (서버 안의 방화벽은 설치 스크립트가 엽니다.)

## 4. 무료 도메인 만들기 (DuckDNS)

HTTPS(자물쇠) 인증서를 받으려면 도메인이 필요합니다.

1. <https://www.duckdns.org> 에 로그인(구글·깃허브 계정 등)
2. 원하는 이름(예: `ourkstock`)을 입력하고 **add domain** → `ourkstock.duckdns.org`
3. **current ip** 칸에 2단계의 공용 IP를 넣고 **update ip**
4. 화면 위쪽의 **token** 값을 메모합니다(설치 스크립트가 IP 변경 시 자동 갱신하는 데 사용).

## 5. 서버에 접속

PC의 PowerShell(또는 터미널)에서:

```bash
ssh -i 내려받은키파일.key ubuntu@공용IP
```

처음 접속할 때 `yes` 를 입력합니다. Windows에서 키 파일 권한 오류가 나면 키 파일을 `C:\Users\내이름\.ssh\` 폴더로 옮겨 다시 시도합니다.

## 6. K-Stock 설치

서버에 접속한 상태에서 코드를 받습니다(비공개 저장소면 GitHub 아이디와 **토큰**을 비밀번호 대신 입력):

```bash
git clone -b claude/brave-pasteur-2rb0f4 https://github.com/pooky825-design/ai_test.git
```

(`-b ...` 는 지금 작업 중인 브랜치입니다. 이 브랜치를 main 에 합친 뒤에는 `-b` 부분을 빼도 됩니다.)

```bash
cd ai_test/stock-prototype
```

설치 스크립트를 실행합니다. `DOMAIN`, `SIGNUP_CODE`(가족·지인에게만 알려줄 가입 코드), `DUCKDNS_TOKEN` 을 바꿔 넣으세요:

```bash
sudo DOMAIN=ourkstock.duckdns.org SIGNUP_CODE=우리집코드2026 DUCKDNS_TOKEN=덕DNS토큰 bash deploy/oracle/setup.sh
```

마지막에 `설치 완료: https://ourkstock.duckdns.org` 가 나오면 끝입니다. 스크립트가 하는 일:

| 항목 | 내용 |
|---|---|
| 앱 | `/opt/kstock` 에 설치, 전용 계정 `kstock` 으로 실행(`kstock.service`, 꺼지면 자동 재시작) |
| 데이터 | `/var/lib/kstock/stock.db` (앱 폴더와 분리) |
| HTTPS | Caddy 가 인증서를 자동 발급·갱신, 앱은 서버 안(127.0.0.1)에서만 대기 |
| 방화벽 | 80·443 만 추가로 열기 |
| 보안 업데이트 | 자동 설치, SSH 무차별 대입 차단(fail2ban) |
| 백업 | 매일 `/var/backups/kstock/stock-날짜.db` (14일 보관) |
| 관리자 명령 | `kstock-admin` |

## 7. 사용하기

1. **PC**: 브라우저에서 `https://ourkstock.duckdns.org` 접속 → 회원가입(가입 코드 입력)
2. **휴대폰 앱(v0.25 이상)**: 로그인 화면 아래 **클라우드 서버에 연결** (또는 환경설정 → 클라우드 서버 연결) → 서버 주소 입력 → 연결
3. **휴대폰에 있던 데이터 옮기기**: 연결 **전에** 환경설정 → *백업 파일 저장* → 연결 후 서버에서 회원가입·로그인 → 환경설정 → *백업 파일로 복원*
4. **화면 공유**: 각자 서버에 가입한 뒤, 환경설정 → 화면 공유 · 권한 관리에서 상대 이메일과 권한을 정하면 **어느 기기에서든** 공유가 됩니다.
5. 앱에서 **이 휴대폰 모드로 전환**을 누르면 언제든 휴대폰 안의 데이터로 돌아갑니다(서버 데이터는 그대로).

## 8. 운영

| 하고 싶은 일 | 명령 (서버에서) |
|---|---|
| 상태 확인 | `systemctl status kstock` |
| 실시간 로그 | `journalctl -u kstock -f` |
| 회원 목록 | `sudo kstock-admin list-users` |
| 비밀번호 재설정 | `sudo kstock-admin reset-password 이메일` → 임시 비밀번호를 본인에게 전달 |
| 가입 코드 변경 | `sudo nano /etc/kstock.env` 에서 `SIGNUP_CODE=` 수정 후 `sudo systemctl restart kstock` |
| 새 버전으로 업데이트 | `cd ~/ai_test && git pull && cd stock-prototype && sudo bash deploy/oracle/update.sh` |
| 백업을 PC로 받기 | PC에서 `scp -i 키파일.key ubuntu@공용IP:/var/backups/kstock/stock-날짜.db .` (먼저 서버에서 `sudo chmod 644` 필요) |

## 9. 보안 체크리스트

- [ ] **가입 코드(SIGNUP_CODE)** 를 정했다. 정하지 않으면 주소를 아는 누구나 가입할 수 있다.
- [ ] SSH 개인 키 파일을 안전한 곳에 보관했다(잃어버리면 서버 접속 불가).
- [ ] SSH 비밀번호 로그인이 꺼져 있다. Oracle Ubuntu 이미지는 기본으로 꺼져 있으며, 설치 스크립트가 켜져 있으면 경고한다.
- [ ] 보안 목록에 22(SSH)·80·443 외의 포트를 열지 않았다.
- [ ] 각자 **앱의 백업 파일 저장**으로 가끔 자기 데이터를 받아 둔다. 무료 서버는 오래 사용이 거의 없으면 회수될 수 있고, 드물게 계정이 정지되는 사례도 있다.

공개 서버 모드(`KSTOCK_MODE=cloud`)에서 앱이 바뀌는 점:

- 데모 계정을 만들지 않는다.
- 비밀번호 재설정 링크를 화면에 보여주지 않는다. 대신 관리자가 `kstock-admin` 으로 재설정한다.
- 로그인은 이메일+IP 기준 15분에 5회 실패하면 잠긴다. 가입은 IP당 1시간에 10회로 제한한다.
- 로그인 쿠키는 HTTPS 전용(Secure)이다.
- 보안 헤더(CSP·HSTS·X-Frame-Options 등)를 붙인다.

## 10. 문제 해결

| 증상 | 확인할 것 |
|---|---|
| 브라우저에서 접속이 안 됨 | 3단계 보안 목록에 80·443이 열렸는지, DuckDNS IP가 공용 IP와 같은지 |
| 인증서 오류 | 도메인이 서버 IP를 가리킨 뒤 `sudo systemctl restart caddy`, `journalctl -u caddy -n 50` |
| 앱이 "클라우드 서버에 연결하지 못했습니다" | 서버가 켜져 있는지(`systemctl status kstock`), 주소가 `https://` 로 시작하는지 |
| 시세가 안 나옴 | 클라우드 IP는 야후가 막는 경우가 있다. 이때는 네이버(예비 출처)로 받으며, `journalctl -u kstock` 에서 오류를 확인한다. |
