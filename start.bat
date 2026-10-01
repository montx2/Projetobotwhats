@echo off
REM ⚡ NEXUS BOT — launcher Windows
cd /d "%~dp0"
title NEXUS BOT

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado. Baixe em https://nodejs.org (versao LTS 20+).
  pause
  exit /b 1
)

if not exist node_modules\@whiskeysockets\baileys (
  echo Instalando dependencias...
  call npm install --no-audit --no-fund
)

echo Iniciando NEXUS BOT...
node src/main.js
pause
