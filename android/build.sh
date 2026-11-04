#!/usr/bin/env bash
# 전화영어 안드로이드 APK 빌드 스크립트 (Gradle 없이 빌드)
#
# 필요한 것 (Ubuntu/Debian):
#   sudo apt-get install android-sdk-platform-23 aapt apksigner zipalign dalvik-exchange openjdk-17-jdk
#   그리고 저장소 루트에서 npm install
#
# 결과물: dist/english-phone-tutor.apk
# 서명 키: 처음 실행 시 ~/.android/english-phone-tutor.keystore 를 만들고 이후 계속 사용합니다.
#          (KEYSTORE / KEYSTORE_PASS 환경변수로 바꿀 수 있습니다.)
#          키가 바뀌면 기존에 설치된 앱 위에 업데이트할 수 없으니 키 파일을 잘 보관하세요.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
SDK="${ANDROID_SDK:-/usr/lib/android-sdk}"
PLATFORM="${ANDROID_JAR:-$SDK/platforms/android-23/android.jar}"
DX="${DX:-$SDK/build-tools/debian/dx}"
KEYSTORE="${KEYSTORE:-$HOME/.android/english-phone-tutor.keystore}"
KEYSTORE_PASS="${KEYSTORE_PASS:-android}"
BUILD="$HERE/build"
OUT="$ROOT/dist/english-phone-tutor.apk"

for tool in aapt zipalign apksigner javac keytool; do
  command -v "$tool" >/dev/null || { echo "필요한 도구가 없습니다: $tool" >&2; exit 1; }
done
[ -f "$PLATFORM" ] || { echo "android.jar 를 찾을 수 없습니다: $PLATFORM" >&2; exit 1; }
[ -x "$DX" ] || DX="$(command -v dx || command -v dalvik-exchange)"

rm -rf "$BUILD"
mkdir -p "$BUILD/gen" "$BUILD/classes" "$BUILD/assets/www" "$(dirname "$OUT")"

echo "1/6 웹 화면 복사 + Claude 호출 코드 번들"
cp -r "$ROOT/public/." "$BUILD/assets/www/"
(cd "$ROOT" && npx --no-install esbuild mobile/entry.js --bundle --format=iife --target=chrome90 \
  --minify --log-level=warning --outfile="$BUILD/assets/www/tutor-bundle.js")
sed -i 's|<script src="app.js"></script>|<script src="tutor-bundle.js"></script>\n  <script src="app.js"></script>|' \
  "$BUILD/assets/www/index.html"
grep -q 'tutor-bundle.js' "$BUILD/assets/www/index.html" || { echo "index.html 에 번들 삽입 실패" >&2; exit 1; }

echo "2/6 리소스 컴파일 (aapt)"
aapt package -f -m -J "$BUILD/gen" -M "$HERE/AndroidManifest.xml" -S "$HERE/res" \
  -A "$BUILD/assets" -I "$PLATFORM" -F "$BUILD/app.unsigned.apk"

echo "3/6 Java 컴파일"
javac -nowarn -Xlint:-options -source 8 -target 8 -encoding UTF-8 -bootclasspath "$PLATFORM" \
  -d "$BUILD/classes" $(find "$BUILD/gen" "$HERE/src" -name '*.java')

echo "4/6 DEX 변환"
"$DX" --dex --min-sdk-version=23 --output="$BUILD/classes.dex" "$BUILD/classes"
(cd "$BUILD" && aapt add -f app.unsigned.apk classes.dex >/dev/null)

echo "5/6 정렬 (zipalign)"
zipalign -f -p 4 "$BUILD/app.unsigned.apk" "$BUILD/app.aligned.apk"

echo "6/6 서명 (apksigner)"
if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -keystore "$KEYSTORE" -storepass "$KEYSTORE_PASS" -keypass "$KEYSTORE_PASS" \
    -alias app -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=English Phone Tutor" >/dev/null 2>&1
  echo "   새 서명 키를 만들었습니다: $KEYSTORE"
fi
apksigner sign --ks "$KEYSTORE" --ks-pass "pass:$KEYSTORE_PASS" --ks-key-alias app \
  --out "$OUT" "$BUILD/app.aligned.apk"
apksigner verify "$OUT"

echo "완료: $OUT ($(du -h "$OUT" | cut -f1))"
