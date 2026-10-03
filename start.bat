@echo off
REM ⚡ NEXUS BOT — launcher Windows
cd /d "%~dp0"
title NEXUS BOT

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado. Baixe em https://nodejs.org (versao LTS 22+).
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if not defined NODE_MAJOR (
  echo [ERRO] Nao foi possivel identificar a versao do Node.js.
  pause
  exit /b 1
)
if %NODE_MAJOR% LSS 22 (
  echo [ERRO] Node.js 22+ necessario. Versao atual: %NODE_MAJOR%.
  pause
  exit /b 1
)

if not exist node_modules\@whiskeysockets\baileys (
  echo Instalando dependencias...
  call npm ci --no-audit --no-fund
)

echo Iniciando NEXUS BOT...
node src/main.js
pause
