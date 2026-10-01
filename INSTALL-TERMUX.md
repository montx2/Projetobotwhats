# 📱 GUIA COMPLETO — Instalação e Configuração no Termux

> O NEXUS no Termux usa **pareamento por código**: nada de QR Code.
> Este guia te leva do zero até o bot funcionando. Siga na ordem.

---

## 📲 PASSO 1 — Instalar o Termux

1. Instale o **Termux pela F-Droid** (a versão da Play Store está desatualizada e quebra):
   👉 https://f-droid.org/packages/com.termux/
2. Abra o Termux e **dê permissão de armazenamento** quando pedir.

---

## 🧰 PASSO 2 — Atualizar e instalar a base

Cole **um bloco por vez** e aperte Enter (aceite os `y` quando perguntar):

```bash
pkg update -y && pkg upgrade -y
```

```bash
pkg install -y git nodejs-lts ffmpeg procps
```

```bash
termux-setup-storage
```

> `ffmpeg` é obrigatório para figurinhas. `procps` para o `./bot.sh stop`.

---

## ⬇️ PASSO 3 — Baixar o bot

```bash
cd ~
git clone https://github.com/montx2/Bot-zap-zap.git
cd Bot-zap-zap
./install-termux.sh
```

O script instala as dependências do Node automaticamente. Aguarde terminar
(pode levar alguns minutos na primeira vez).

---

## 🔑 PASSO 4 — Configurar as chaves (o "turbo" do bot) — OPCIONAL mas recomendado

O bot **funciona sem nenhuma chave** (IA grátis Pollinations, downloads, etc).
Mas para **remoção de fundo** e mais IA, adicione suas contas:

```bash
cp .env.example .env
nano .env
```

### 🎭 Remoção de fundo (para `.sfundo` / `.fundo`)
Crie **várias contas grátis** em https://www.remove.bg/api (50 créditos/mês cada).
Quanto mais contas, mais "ilimitado" fica — o bot gira entre elas:

```env
REMOVE_BG_KEYS=chave_da_conta1,chave_da_conta2,chave_da_conta3
```

### 🧠 IA (opcional)
```env
GEMINI_KEYS=chave1,chave2    # grátis em https://aistudio.google.com
GROQ_KEYS=chave1             # grátis em https://console.groq.com
OPENAI_KEYS=chave1           # OpenAI (pago)
```
> Sem nada disso, a IA usa **Pollinations grátis** automaticamente.

Para salvar no nano: `Ctrl+O` → Enter → `Ctrl+X`.

---

## 🔗 PASSO 5 — Parear seu WhatsApp (o coração do processo)

Salve seu número (DDI + DDD + número, **só dígitos**):

```bash
./bot.sh pair 55SEUDDDSEUNUMERO
```
Exemplo real: `./bot.sh pair 5511999999999`

Agora inicie o bot:

```bash
./bot.sh start
```

O terminal vai mostrar um **código de 8 letras**, tipo `ABCD-EFGH`.

**No seu celular:**
1. Abra o **WhatsApp** → **⋮** (três pontos) → **Dispositivos conectados**
2. Toque em **Conectar um dispositivo**
3. Toque em **Conectar com número de telefone**
4. Digite o **código de 8 letras** que apareceu no Termux

Aguarde uns segundos. Quando aparecer o banner **"✅ Conectado"**, está no ar! 🎉

---

## 🎮 PASSO 6 — Usar o bot

Mande **`.menu`** em qualquer conversa (inclusive "Conversar com você mesmo").

| O que faz | Comando |
|---|---|
| Ver tudo | `.menu` |
| Testar se está vivo | `.ping` |
| Status e saúde | `.info` / `.doctor` / `.pools` |
| Figurinha | `.s` (responda uma foto/vídeo/GIF) |
| Figurinha sem fundo | `.sfundo` |
| Baixar TikTok | `.tiktok <link>` |
| Baixar Pinterest | `.pin <link>` |
| Baixar Instagram | `.insta <link>` |
| Baixar qualquer rede | `.dl <link>` |
| Conversar com IA | `.ia <pergunta>` |
| Gerar imagem | `.criar <descrição>` |
| Anti-delete status | `.antidelete` |

**View Once:** responda QUALQUER foto/vídeo de visualização única com
QUALQUER mensagem (um "oi" serve) e o bot baixa pra você. A captura
automática também já vem ligada.

**Auto-download:** cole um link de rede social solto no chat → ele baixa sozinho.

---

## 🔋 PASSO 7 — Manter o bot vivo no Android

O Android gosta de matar apps em segundo plano. Faça isto:

```bash
termux-wake-lock
```

1. **Configurações do Android → Aplicativos → Termux → Bateria** → marque **"Sem restrição"** / desative otimização.
2. Não feche o Termux arrastando pra fora dos recentes.
3. Se quiser que o bot **inicie sozinho ao ligar o celular**, instale o app
   **Termux:Boot** (F-Droid) e crie o script de auto-início (veja README).

---

## 🧾 Comandos do launcher (`./bot.sh`)

| Comando | O que faz |
|---|---|
| `./bot.sh start` | inicia o bot |
| `./bot.sh pair NUMERO` | salva número de pareamento |
| `./bot.sh stop` | para o bot |
| `./bot.sh doctor` | diagnóstico do ambiente |
| `./bot.sh test` | roda os 36 testes |
| `./bot.sh update` | atualiza código + dependências |

---

## ❓ SOLUÇÃO DE PROBLEMAS

| Problema | Solução |
|---|---|
| **`ffmpeg ausente`** no `.doctor` | `pkg install ffmpeg` |
| **`node: command not found`** | `pkg install nodejs-lts` |
| **`Cannot find module`** ao iniciar | rode `npm install` dentro da pasta do bot |
| **Código de pareamento não aparece** | confira o número: só dígitos, com DDI (55…). Rode `./bot.sh pair` de novo |
| **`Número inválido`** | falta DDI ou DDD. Ex. correto: `5511999999999` |
| **Não conecta / fica tentando** | verifique sua internet; o bot tenta sozinho de novo |
| **Bot cai ao fechar a tela** | `termux-wake-lock` + bateria sem restrição (Passo 7) |
| **Sessão expirou / deslogou** | `rm -rf data/auth` e repita o **Passo 5** |
| **`.sfundo` pede configuração** | adicione `REMOVE_BG_KEYS` no `.env` (Passo 4) |
| **Quero zerar as configurações** | apague `data/config.json` e reinicie |
| **Quero trocar de conta** | `rm -rf data/auth` + `./bot.sh pair NOVONUMERO` + `./bot.sh start` |

---

## 🔄 Atualizar o bot no futuro

```bash
cd ~/Bot-zap-zap
./bot.sh update
./bot.sh start
```

---

**Pronto! Você tem o bot mais completo rodando no seu bolso. ⚡**
Qualquer coisa: `.menu`, `.doctor` e `.info` são seus melhores amigos.
