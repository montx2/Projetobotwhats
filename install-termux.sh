#!/usr/bin/env bash
# ⚡ NEXUS BOT — instalação Termux em 1 comando
set -euo pipefail

echo "📦 Atualizando pacotes do Termux…"
pkg update -y && pkg upgrade -y

echo "📦 Instalando Node.js, Git, FFmpeg e utilitários…"
pkg install -y nodejs-lts git ffmpeg procps

# espeak deixa o .voz funcionando 100% offline e de graça (sem chave, sem
# internet). É opcional: se o pacote não estiver disponível no seu espelho, o
# bot continua funcionando com os motores online grátis.
echo "🔊 Instalando o motor de voz offline (espeak)…"
pkg install -y espeak || echo "⚠️  espeak indisponível agora — .voz segue grátis com os motores online (tente: pkg install espeak)"

cd "$(dirname "$0")"

echo "📦 Instalando dependências do bot…"
npm ci --no-audit --no-fund

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
