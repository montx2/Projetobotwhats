# ⚡ NEXUS BOT

**O bot de WhatsApp mais completo da sua vida.** Multi-Device (Baileys), feito para
**Termux** (pareamento por código, sem QR), e também roda em **Linux** e **Windows** (com QR).

Tudo que importa, nada que atrapalha:

| Recurso | Descrição |
|---|---|
| 👁️ **View Once** | Captura automática + responda qualquer view once com qualquer mensagem — **100% silenciosa, vai SÓ pro seu privado (0 rastros)** |
| 🛡️ **Anti-Delete** | **Ligado em tudo por padrão** — tudo que apagarem vai **SÓ pro seu privado (0 rastros)**, com filtros de ignorar |
| 🖼️ **Figurinhas** | Imagem, vídeo, GIF e figurinha→figurinha, **com remoção de fundo por IA** — e **figurinha automática direto de um link** (`.s <link>`), sem baixar nada antes |
| 🎭 **Remoção de fundo** | Pool de APIs com várias contas girando (estilo "requisições ilimitadas") |
| 🧠 **IA completa** | Chat, geração de imagens, voz, tradução e resumo — com pool de chaves + fallback grátis |
| ⬇️ **Downloader universal** | TikTok, Instagram, Pinterest, YouTube, X, Facebook, Threads, Reddit, Twitch, Vimeo e a cauda longa |
| 🎚️ **Qualidade** | Sempre a **MELHOR por padrão**; peça `baixa` para reduzir |
| 🔒 **Privacidade** | Só você manda. Quem você liberar com `.ativar` usa tudo, **menos View Once e Anti-Delete** (que nunca aparecem pra ninguém) |
| 🎨 **Menu duplo** | Um menu completo só no seu privado e um menu público nos chats liberados |

---

## 🚀 Instalação rápida

### 📱 Termux (recomendado)

```bash
pkg update -y && pkg upgrade -y
pkg install -y git nodejs-lts ffmpeg
git clone https://github.com/montx2/Bot-zap-zap.git
cd Bot-zap-zap
./install-termux.sh        # instala tudo
./bot.sh pair 55SEUNUMERO  # salva seu número (sem QR no Termux!)
./bot.sh start             # mostra o código de 8 letras
```

No WhatsApp: **Dispositivos conectados → Conectar com número de telefone** → digite o código.

> 💡 Precisa manter o Termux vivo? Rode `termux-wake-lock` antes do `./bot.sh start`.

### 🐧 Linux

```bash
sudo apt install nodejs npm ffmpeg   # Node 20+
npm install
npm start                            # escaneie o QR no terminal
```

### 🪟 Windows

1. Instale o [Node.js LTS 20+](https://nodejs.org) e FFmpeg (`winget install ffmpeg`).
2. Dê dois cliques em `start.bat` (ele instala as dependências sozinho).
3. Escaneie o QR Code que aparece no terminal.

---

## 🎮 Como usar

Mande **`.menu`** no WhatsApp. Resumo:

### 👁️ View Once — 100% silenciosa
- **Captura automática**: toda view once recebida é baixada e enviada **somente para o seu privado**.
- **Por resposta**: responda a view once com *qualquer mensagem* (um "oi", um emoji, `.s`…) **em qualquer conversa ou grupo** e o bot baixa a mídia e manda direto pro seu privado.
- **Zero rastros**: o bot nunca reenvia a mídia no grupo nem na conversa da outra pessoa, e nunca responde nada lá.
- Configurar: `.vo` (status) · `.vo on` · `.vo off`

### 🛡️ Anti-Delete — 100% silencioso
Vem **ligado em todos os chats**. Quando alguém apaga, o bot manda o conteúdo recuperado **somente para o seu privado** — nada volta pro grupo ou pro chat de origem.

```
.antidelete                    → status
.antidelete ignorar grupos     → para de proteger grupos
.antidelete ignorar privado    → para de proteger PVs
.antidelete ignorar aqui       → ignora o chat atual
.antidelete ignorar <número>   → ignora um contato específico
.antidelete remover grupos     → volta a proteger
.antidelete lista              → ver filtros
.antidelete on | off           → liga/desliga global (só o dono)
```

### 🖼️ Figurinhas
```
.s / .fig / !sticker    → foto, vídeo, GIF ou figurinha → figurinha
.s <link>               → baixa o link e JÁ monta a figurinha (novo 🔥)
.sfundo                 → figurinha SEM FUNDO (IA remove o fundo)
.fundo                  → devolve PNG transparente (sem virar figurinha)
```

**Figurinha direto do link** — manda o link, recebe a figurinha pronta, sem baixar nada antes:
```
.s https://br.pinterest.com/pin/123456789/     → figurinha do pin
.s pin.it/abc123                               → aceita link curto e até sem https://
.s inteira https://pin.it/abc123               → imagem completa, sem esticar
.s cortar https://pin.it/abc123                → preenche o quadrado cortando as bordas
.sfundo https://i.pinimg.com/originals/a/b/c.jpg → baixa e remove o fundo com IA
.s <link1> <link2> <link3>                     → até 3 links de uma vez
```
- Funciona com **qualquer** link que o `.dl` baixa: Pinterest, TikTok, Instagram,
  YouTube, X/Twitter, Facebook, Threads, Reddit, GIFs (Giphy/Tenor) e sites em geral.
- Link que já é arquivo (termina em `.jpg`, `.png`, `.gif`, `.mp4`…) é baixado na hora,
  sem passar pelos extratores — o caminho mais rápido.
- **Carrossel/slideshow** vira figurinha da primeira foto; **vídeo** vira figurinha animada (até 7 s).
- Também funciona **respondendo** a uma mensagem que contém o link: responde com `.s` e pronto.
- Se o link for só áudio, o bot avisa e sugere `.dl <link>`.

> O nome do pacote e o autor da figurinha são fixos (definidos em `nomePack` /
> `autorPack`, no `data/config.json`). Não existe mais comando para trocar por
> figurinha — se quiser mudar, edite o config e reinicie o bot.
Dica: dá pra responder uma **view once** com `.s` e transformar em figurinha. 😉

### ⬇️ Downloads (sempre na melhor qualidade)
```
.dl <link> [qualidade]      → universal (qualquer rede)
.tiktok <link> [qualidade]  → TikTok sem marca d'água (HD original)
.ttmp3 <link>               → só a música do TikTok
.pin <link> [qualidade]     → Pinterest (foto original, vídeo e GIF)
.insta <link> [qualidade]   → Instagram (reels, posts, carrossel)
.yt <link> [qualidade]      → YouTube
.ytmp3 <link>               → só o áudio do YouTube
.tw <link>                  → X/Twitter (vídeo, GIF e fotos)
.face <link>                → Facebook (vídeos e reels públicos)
```
- **Qualidades**: `melhor` (padrão 👑), `alta`, `media`, `baixa` — em qualquer ordem: `.tiktok baixa <link>`
- **Auto-download**: cole o link solto no chat que ele baixa sozinho.
- Redes com extrator próprio: TikTok, Instagram, Pinterest, YouTube, X, Facebook,
  Threads, Reddit, Twitch e Vimeo. A cauda longa (Snapchat, SoundCloud,
  Dailymotion e centenas de sites) passa pelo Cobalt e pelo yt-dlp.

**Como cada rede é baixada** (métodos reais, não chute):

| Rede | Estratégia principal | Reservas |
|---|---|---|
| TikTok | TikWM (`/api/` com `hd=1`, sem `web:1`) | Cobalt (túnel) → scraping direto |
| Instagram | Página de incorporação (`/p/<code>/embed/captioned/`) lendo o `contextJSON` | Visão de crawler com UA do facebookexternalhit → Cobalt |
| Pinterest | Widget API (`widgets.pinterest.com/v3/pidgets/pins/info/`) | SSR `__PWS_DATA__` → savepin → Cobalt |
| YouTube | Innertube (clientes ANDROID_VR e IOS) | Cobalt → yt-dlp |
| X/Twitter | vxtwitter (`api.vxtwitter.com`) | fxtwitter → Cobalt |
| Facebook | Plugin público de vídeo (`browser_native_hd_url`) | Página direta → Cobalt |
| Threads/Reddit/Twitch/Vimeo | Embed público de cada um | Cobalt |

> 🧰 **Modo turbo**: se você tiver o `yt-dlp` instalado (`pip install -U yt-dlp` no
> Termux), o bot detecta e usa como reserva fortíssima para qualquer site.

### 🧠 IA
```
.ia <pergunta>            → conversa (com memória no chat · .ia reset limpa)
.criar <descrição>        → gera imagem
.voz <texto>              → áudio falando o texto
.traduz inglês <texto>    → tradução
.resumo <texto>           → resumão em bullets
```

---

## 🔑 O sistema de POOLS (requisições "ilimitadas")

A mágica do NEXUS: em vez de UMA conta/API, você configura **VÁRIAS** e o bot
gira entre elas. Quando uma estoura o limite, ela entra em "geladeira" e a
próxima assume. Copie `.env.example` para `.env` e preencha:

```bash
cp .env.example .env
nano .env
```

### 🎭 Remoção de fundo (para .sfundo / .fundo)
Crie quantas contas grátis quiser em <https://www.remove.bg/api> (50 créditos/mês cada):
```env
REMOVE_BG_KEYS=chave_da_conta1,chave_da_conta2,chave_da_conta3
```
> ⚠️ O `.env` fica **na raiz do bot** (a mesma pasta do `package.json`) e é lido na
> **inicialização**: depois de colar as chaves, reinicie o bot. Confira o que ele
> enxergou com **`.pools`** no WhatsApp ou **`npm run env`** no terminal.
Alternativas:
```env
REMOVE_BG_URLS=https://sua-api-própria/removebg   # POST multipart campo "image"
LOCAL_REMBG=true                                   # usa o rembg local (pip install rembg)
```

### 🧠 IA (opcional — sem nada, usa Pollinations grátis)
```env
GEMINI_KEYS=key1,key2        # aistudio.google.com (grátis)
GROQ_KEYS=key1               # console.groq.com (grátis, rápido)
OPENAI_KEYS=key1             # OpenAI
AI_BASE_URL=https://openrouter.ai/api/v1   # qualquer API compatível com OpenAI
AI_KEYS=key1,key2
AI_MODEL=anthropic/claude-3.5-sonnet
```
Ordem de uso: suas chaves → Gemini → Groq → OpenAI → **Pollinations (grátis, sempre)**.

### ⬇️ Downloads universais (Cobalt)
O bot já vem com instâncias públicas. Para ficar 100% confiável, adicione as suas
(veja a lista em <https://instances.cobalt.best> ou suba a sua: <https://github.com/imputnet/cobalt>):
```env
COBALT_INSTANCES=https://sua-instancia.cobalt,https://outra-instancia
```

> 📊 Veja a saúde dos pools no WhatsApp: **`.pools`** (dono) e **`.info`**
> 🩺 No terminal: **`npm run env`** mostra o caminho do `.env` e quantas chaves de
> cada tipo o bot encontrou; **`.doctor`** / `npm run doctor` faz o diagnóstico completo.

---

## ⚙️ Comandos de configuração

```
.config                       → ver tudo
.config autoDownload false    → desligar auto-download de links
.config qualidadePadrao media → qualidade padrão dos downloads
.config maxMB 50              → limite de tamanho por arquivo
.menu · .ping · .info · .doctor · .pools
```

---

## 🧪 Testes

```bash
npm test          # 102 testes offline (lógica, roteamento, anti-delete, view once,
                  # figurinhas WebP/EXIF, figurinha a partir de link, extratores de
                  # redes sociais e carregamento do .env)
npm run doctor    # diagnóstico do ambiente
npm run env       # mostra o que o bot leu do .env (chaves, caminhos, contagens)
```

## 🩺 Problemas comuns

| Sintoma | Solução |
|---|---|
| QR não aparece no Termux | Normal! Termux usa código: `./bot.sh pair SEUNUMERO` |
| Código de pareamento não aparece | Confira o número: só dígitos, com DDI (ex. 55…) |
| Loop de 405 ao conectar | O bot já faz cache da versão do WA Web; se persistir: `WA_VERSION_OVERRIDE=2,3000,REVISAO` |
| Figurinha não sai | Falta FFmpeg: `pkg install ffmpeg` / `apt install ffmpeg` / `winget install ffmpeg` |
| `.s <link>` não sai a figurinha | Confira se o link abre no navegador. Vídeos muito longos passam do teto de 64 MB do `.s` — use um link curto (TikTok/Reels/Pin) ou baixe com `.dl <link>` |
| `.fundo` / `.sfundo` diz "Nenhum provedor configurado" | Confira se o `.env` está **na raiz do bot** e reinicie. Veja o que o bot enxerga com `.pools` (dono) ou `npm run env` |
| Coloquei a chave e nada mudou | O `.env` só é lido na **inicialização** — depois de salvar, reinicie (`./bot.sh stop` + `./bot.sh start`) |
| Download falha em alguma rede | O bot tenta em cascata (extrator da rede → Cobalt → yt-dlp → scraping). Tente de novo ou use `.dl <link>` |
| Download do Instagram falha | IG bloqueia muitos IPs; o bot tenta incorporação → visão de crawler → Cobalt |
| Áudio do YouTube não sai | Instale o yt-dlp (`pip install -U yt-dlp`) para destravar o modo turbo |
| Ninguém do grupo consegue usar | Dê `.ativar` dentro do grupo (tem que ser você, o dono) |
| Bot cai no Termux ao fechar | `termux-wake-lock` e não mate o app nas configurações de bateria |

## 🧱 Estrutura

```
src/
├── main.js               # boot, dono, handlers
├── core/                 # config, env, http, keypool (motor de contas), store
├── wa/                   # conexão Baileys (QR/código) + cache de mensagens
├── features/             # viewonce, antidelete, sticker, stickerlink (figurinha de
│                         # link), bgremoval, ai, download
│   └── downloaders/      # tiktok, instagram, pinterest, youtube, twitter,
│                         # facebook, generic, cobalt, ytdlp, media, qualidade
└── util/                 # ffmpeg, webp (exif), texto
```

Zero bancos externos, zero módulos nativos obrigatórios: instala em qualquer lugar.

## 🙏 Créditos e inspiração

Construído sobre [Baileys](https://github.com/WhiskeySockets/Baileys). Ideias e
padrões estudados nos melhores bots abertos da comunidade (Atlas-MD, ChisatoBOT,
KIRA X MD e cia.) — e depois refeitos do zero, mais simples e mais rápidos.
APIs: TikWM, Pollinations, Cobalt, remove.bg.

---

**Feito com ⚡ para ser o bot, não um botzinho.**
