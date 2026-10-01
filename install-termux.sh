#!/usr/bin/env bash
# ⚡ NEXUS BOT — instalação Termux em 1 comando
set -euo pipefail

echo "📦 Atualizando pacotes do Termux…"
pkg update -y && pkg upgrade -y

echo "📦 Instalando Node.js, Git, FFmpeg e utilitários…"
pkg install -y nodejs-lts git ffmpeg procps

cd "$(dirname "$0")"

echo "📦 Instalando dependências do bot…"
npm install --no-audit --no-fund

echo ""
echo "✅ Instalação concluída!"
echo ""
echo "📱 Agora salve seu número para o pareamento (sem QR no Termux):"
echo "   ./bot.sh pair 55SEUNUMERO"
echo ""
echo "🚀 E inicie o bot:"
echo "   ./bot.sh start"
echo ""
echo "📲 No WhatsApp: Dispositivos conectados → Conectar com número de telefone"
echo "   e digite o código de 8 letras que aparecer aqui."
