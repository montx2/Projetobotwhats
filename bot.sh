#!/usr/bin/env bash
# ⚡ NEXUS BOT — launcher Termux/Linux
set -euo pipefail
cd "$(dirname "$0")"

cmd="${1:-start}"

if [ "$cmd" != "stop" ]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "❌ Node.js 22+ não encontrado. Instale com: pkg install nodejs-lts"
    exit 1
  fi
  node_major=$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)
  if [ "$node_major" -lt 22 ]; then
    echo "❌ Node.js 22+ necessário (atual: $(node --version)). Atualize com: pkg install nodejs-lts"
    exit 1
  fi
fi

case "$cmd" in
  start)
    if [ ! -d node_modules/@whiskeysockets/baileys ]; then
      echo "📦 Instalando dependências travadas pelo lockfile…"
      npm ci --no-audit --no-fund
    fi
    # Termux: evita o Android suspender o bot (conexão cai = código de pareamento morre)
    if command -v termux-wake-lock >/dev/null 2>&1; then termux-wake-lock || true; fi
    exec node src/main.js
    ;;
  pair)
    shift || true
    exec node scripts/pair.mjs "$@"
    ;;
  doctor)
    exec node scripts/doctor.mjs
    ;;
  test)
    exec npm test
    ;;
  update)
    echo "🔄 Atualizando a branch atual…"
    branch=$(git branch --show-current)
    if [ -z "$branch" ]; then echo "❌ Não foi possível identificar a branch atual."; exit 1; fi
    git pull --ff-only origin "$branch"
    npm ci --no-audit --no-fund
    echo "✅ Atualizado. Rode ./bot.sh start"
    ;;
  stop)
    if command -v pkill >/dev/null 2>&1; then
      pkill -f "node src/main.js" && echo "🛑 Bot parado." || echo "ℹ️ Bot não estava rodando."
    else
      pid=$(ps -ef 2>/dev/null | grep "[n]ode src/main.js" | awk '{print $2}' | head -1)
      if [ -n "$pid" ]; then kill "$pid" && echo "🛑 Bot parado (PID $pid)."; else echo "ℹ️ Bot não estava rodando."; fi
    fi
    ;;
  *)
    echo "⚡ NEXUS BOT"
    echo "Uso: ./bot.sh [start|pair NUMERO|doctor|test|update|stop]"
    ;;
esac
