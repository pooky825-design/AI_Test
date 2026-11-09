@echo off
chcp 65001 >nul
title 주식 관리시스템 프로토타입
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js가 설치되어 있지 않습니다.
  echo https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요.
  pause
  exit /b 1
)

if not exist node_modules (
  echo 처음 실행이라 필요한 패키지를 설치합니다. 1~2분 정도 걸립니다...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [오류] 패키지 설치에 실패했습니다. 인터넷 연결을 확인해 주세요.
    pause
    exit /b 1
  )
)

set OPEN_BROWSER=1
node server\index.js
pause
