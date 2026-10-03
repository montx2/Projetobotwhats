# MontxBOT

Bot de WhatsApp Multi-Device baseado em **Baileys 6.7.24**. Inclui figurinhas, downloads de links, IA, utilitários com APIs públicas sem chave e ferramentas de grupo opt-in: enquetes, boas-vindas/saída e proteção anti-link. Recursos que copiam ou retêm conteúdo pessoal começam desativados. Feito para Termux, Linux e Windows.

> **Aviso importante:** Baileys é uma integração não oficial. O WhatsApp pode alterar o protocolo, limitar ou encerrar sessões. Use uma conta sob seu controle, respeite as regras do WhatsApp, a legislação local, direitos autorais e a privacidade/consentimento das pessoas. Este projeto não promete disponibilidade nem proteção contra bloqueios.

## Requisitos e instalação

- Node.js **22 ou superior** (22/24 LTS recomendados).
- FFmpeg para conversão de figurinhas e áudio/vídeo.
- A dependência Baileys fica fixada em `6.7.24`; não é atualizada automaticamente para releases candidatas da v7.

### Termux

```bash
pkg update -y && pkg upgrade -y
pkg install -y git nodejs-lts ffmpeg procps
git clone https://github.com/montx2/Bot-zap-zap.git
cd Bot-zap-zap
./install-termux.sh
./bot.sh pair 55SEUNUMERO
./bot.sh start
```

No WhatsApp, abra **Dispositivos conectados → Conectar com número de telefone** e digite o código exibido. Para manter o Android acordado, use `termux-wake-lock`.

### Linux / Windows

Instale Node.js 22+ e FFmpeg. Em seguida:

```bash
npm ci
npm start
```

No Windows, execute `start.bat`. No primeiro início, use o QR exibido no terminal. Para conferir o ambiente antes do pareamento: `npm run doctor`.

## Acesso e privacidade

Por padrão, o bot atende somente o privado do dono. O dono pode liberar um chat/grupo com `.ativar` e revogar com `.desativar`. A revogação também limpa as opções de captura e o cache daquele chat. ` .desativar tudo` revoga os demais chats.

### View Once (desativado por padrão)

A captura automática é **opt-in por JID**, exige que o chat esteja liberado e entrega o arquivo apenas no privado do dono. Uma resposta comum, emoji ou mensagem citada **não** dispara download. Para ativar/desativar:

```text
.vo                         → status do chat atual
.vo on aqui                 → habilita no privado atual
.vo on <JID>                → habilita um chat já autorizado
.vo off aqui
.vo off todos               → desliga em todos os chats
```

O comando `.s` pode baixar uma View Once citada **somente no privado do dono e por ação explícita**; em grupo ou chat de terceiros a conversão é bloqueada. Considere a expectativa de privacidade de quem enviou o conteúdo antes de habilitar qualquer captura.

### Anti-Delete (desativado por padrão)

A retenção também é opt-in por chat. Mensagens recuperáveis são encaminhadas somente ao privado do dono, nunca de volta ao chat de origem. View Once é excluída. Ao desligar o recurso ou revogar o chat, o cache correspondente é apagado.

```text
.antidelete                         → status
.antidelete on aqui                 → ativa no privado atual
.antidelete on <JID>                → ativa em chat previamente autorizado
.antidelete off aqui                → desativa e limpa o cache desse chat
.antidelete off todos               → desativa em todos os chats
.antidelete ignorar grupos          → exclui e limpa todos os grupos
.antidelete ignorar privado         → exclui e limpa os privados
.antidelete ignorar <JID>           → exclui um chat
.antidelete remover <JID>           → remove o filtro
.antidelete lista                   → mostra a configuração (somente ao dono)
```

**Retenção local:** até 24 horas, no máximo 100 mensagens por chat e 1.000 no total. A mídia do WhatsApp é lida em stream, limitada a 64 MiB. A persistência em `data/cache/messages.json` ocorre somente para chats com Anti-Delete habilitado; a configuração e os dados de runtime ficam em `data/`, ignorados pelo Git. Não coloque backups dessa pasta em local público.

### Recursos de grupo (opt-in)

O dono precisa liberar o grupo com `.ativar` antes. Boas-vindas, mensagem de saída e anti-link começam **desligados**; somente administradores do grupo (ou o dono do bot) podem alterar essas configurações. Ao usar `.desativar` no grupo, suas configurações locais também são removidas.

```text
.boasvindas                         → consulta o status
.boasvindas on | off                → liga/desliga saudação de entrada
.boasvindas saida on | off          → liga/desliga saudação de saída
.antilink                           → consulta status e domínios permitidos
.antilink on | off                  → liga/desliga a proteção de links
.antilink permitir exemplo.com      → permite o domínio e seus subdomínios
.antilink remover exemplo.com       → remove o domínio permitido
.enquete pergunta | opção 1 | opção 2 → cria uma enquete de escolha única
```

A proteção de links considera URLs HTTP(S), links `www.` e domínios simples, ignora mensagens de administradores e só remove mensagens quando o próprio bot é administrador. Se perder essa permissão ou não conseguir confirmar os metadados, não tenta apagar; também não encaminha o link para comandos/downloads. A lista aceita até 50 domínios por grupo; não aceita URL completa, IP, porta ou curinga. Há limite de até 20 tentativas de remoção de links por grupo/minuto; acima disso a proteção bloqueia o processamento do link sem continuar apagando. Boas-vindas/saídas usam uma mensagem fixa e menções limitadas, sem guardar histórico de participantes (até 5 eventos anunciados por grupo/minuto). Enquetes aceitam de 2 a 12 opções, com limite de 2 por usuário a cada 5 minutos e 20 por grupo/hora.

Esses controles ajudam a reduzir spam e links indesejados, mas **não são moderação completa e não garantem que ninguém publique ou use conteúdo ilegal**. Administradores continuam responsáveis por revisar as regras e as mensagens do grupo.

### IA e dados enviados a terceiros

Os comandos de IA usam provedores externos configurados (ou Pollinations quando não há outras chaves). Perguntas, trechos citados, descrições de imagem e texto de voz podem ser enviados ao provedor escolhido para gerar a resposta. **Não envie senhas, dados de pagamento ou informações sensíveis.**

A memória de conversa é isolada por chat e remetente, fica apenas em RAM por até 30 minutos e é limitada em tamanho; `.ia reset` limpa a memória daquele remetente. Prompts não são gravados nos logs. A retenção e o tratamento pelo provedor externo seguem as políticas desse provedor.

### APIs públicas de utilidades

```text
.clima Itaúna, MG                 → clima atual e resumo da previsão de hoje
.cotacao 100 USD BRL              → converte usando taxa de referência diária
.feriados 2027 BR                 → feriados nacionais do país/ano informado
.ia clima Itaúna                  → IA responde com dados atuais do clima
.ia cotacao 100 USD BRL           → IA contextualiza uma conversão
.ia feriados 2027 BR              → IA consulta o calendário nacional
```

Esses comandos usam endpoints fixos, sem chave: [Open-Meteo](https://open-meteo.com/en/docs) para geocodificação e clima, [Frankfurter](https://frankfurter.dev/) para câmbio e [Nager.Date](https://nagerholidays.com/api) para feriados. A cidade consultada é enviada ao Open-Meteo; os códigos de moeda vão ao Frankfurter; país/ano vão ao Nager.Date. Nas perguntas à IA, esses dados também são incluídos no contexto enviado ao provedor de IA já configurado. Não informe localizações ou outros dados que não queira compartilhar.

O clima inclui atribuição **Open-Meteo · CC BY 4.0**. A API gratuita do Open-Meteo é destinada a uso não comercial segundo os termos do serviço; verifique as condições atuais antes de operar comercialmente. Câmbio é taxa diária de referência, não cotação em tempo real nem recomendação financeira. A lista de feriados considera apenas datas nacionais; feriados estaduais e municipais podem não aparecer. As respostas têm cache em memória e timeout; há limites por processo de até 4.000 consultas de clima/dia (para manter margem no limite divulgado pelo Open-Meteo), 60 consultas de câmbio/minuto e 30 consultas de feriados/minuto. Uma falha do serviço é informada em vez de inventar dados. APIs públicas podem mudar, limitar ou ficar indisponíveis — consulte os termos de cada provedor.

## Comandos

```text
.menu                         → comandos disponíveis
.ping                         → teste simples
.s                             → responde a uma imagem/vídeo/GIF com uma figurinha
.s <link>                      → baixa mídia pública e cria figurinha
.s inteira <link>              → preserva a proporção
.s cortar <link>               → preenche o quadrado cortando as bordas
.sfundo <imagem ou link>        → figurinha sem fundo
.fundo <imagem ou link>         → PNG sem fundo
.dl <link> [qualidade]          → download de mídia pública
.tiktok <link>                  → TikTok
.insta <link>                   → Instagram
.pin <link>                     → Pinterest
.yt <link> / .ytmp3 <link>      → YouTube / áudio
.tw <link> / .face <link>       → X/Twitter / Facebook
.ia <pergunta>                  → conversa com IA
.criar <descrição>              → geração de imagem
.voz <texto>                    → texto para áudio
.traduz <idioma> <texto>        → tradução
.resumo <texto>                 → resumo
.clima <cidade>                 → clima atual e previsão do dia
.cotacao <valor> <origem> <destino> → conversão cambial de referência
.feriados [ano] [país]           → feriados nacionais (padrão: Brasil/ano atual)
.enquete pergunta | opção 1 | opção 2 → enquete de escolha única no grupo
```

Links de grupos/redes e conteúdos protegidos podem não estar disponíveis. Faça downloads somente de conteúdo que você tem direito e autorização para acessar.

### Downloads automáticos e limites

- Auto-download de links soltos vem **desligado**. Para ativar conscientemente: `.config autoDownload true`.
- O bot limita cada arquivo a `maxMB` (90 MiB por padrão, configurável entre 1 e 200). Lotes também têm teto agregado de 200 MiB. Figurinhas e mídias recebidas do WhatsApp usam limites próprios.
- Comandos de alto custo têm limitação de frequência e concorrência para reduzir spam e consumo de memória.
- URLs fornecidas por usuários precisam ser HTTP/HTTPS e o destino inicial não pode ser local/privado. O cliente HTTP do bot valida cada redirecionamento e limita o corpo das respostas.
- O `yt-dlp` local fica **desligado por padrão**: o binário segue redirecionamentos próprios que não passam pela validação por salto do bot. Só habilite com `NEXUS_ENABLE_YTDLP=true` se confiar nos links e puder controlar a rede de saída; `NEXUS_DISABLE_YTDLP=true` desliga mesmo assim.

## Configuração

Copie o exemplo e proteja o arquivo:

```bash
cp .env.example .env
```

`.env` é local e ignorado pelo Git. Alterações exigem reinicialização. `npm run env` mostra somente contagens e caminhos, não imprime chaves.

### Provedores de IA

```env
GEMINI_KEYS=...
GROQ_KEYS=...
OPENAI_KEYS=...
AI_BASE_URL=https://openrouter.ai/api/v1
AI_KEYS=...
AI_MODEL=...
POLLINATIONS_KEYS=...
```

`AI_BASE_URL`/`OPENAI_BASE_URL` são endpoints escolhidos pelo operador; as credenciais configuradas serão enviadas a eles. Use somente endpoints confiáveis. Para serviços locais, configure explicitamente o endereço privado apropriado.

### Remoção de fundo e downloads

```env
REMOVE_BG_KEYS=...
REMOVE_BG_URLS=https://seu-endpoint-confiavel/rembg
LOCAL_REMBG=false
COBALT_INSTANCES=https://sua-instancia-cobalt
COBALT_API_KEY=
TIKTOK_API=https://seu-endpoint-tiktok
```

Endpoints customizados são considerados confiáveis pelo operador e podem usar rede local. Não aponte o bot para serviços desconhecidos. Chaves e instâncias em pool respeitam cooldowns e limites reportados pelo provedor; **adicionar contas não torna uma cota ilimitada nem deve contornar regras do serviço**. A chave Cobalt só é enviada às instâncias definidas em `COBALT_INSTANCES`, nunca às instâncias públicas padrão.

### Comandos locais de configuração

```text
.config                         → ver preferências e contagens
.config autoDownload false      → desligar downloads automáticos
.config qualidadePadrao media   → qualidade padrão
.config maxMB 120               → limite por arquivo (1–200 MiB)
.doctor                         → diagnóstico no WhatsApp (dono)
.pools                          → status dos provedores (dono)
```

## Desenvolvimento e validação

```bash
npm ci
npm test
npm run doctor
```

A suíte executa os arquivos de teste em processos sequenciais, cada um com `NEXUS_DATA_DIR` temporário próprio (removido ao final), incluindo testes offline de limites, cache, roteamento, migração, SSRF, redirecionamentos e streams.

## Estrutura

```text
src/
├── core/       config, HTTP seguro, key pools, armazenamento, limites
├── wa/         cliente Baileys, cache e helpers de mídia em stream
├── features/   router, View Once, Anti-Delete, IA, figurinhas e downloads
└── util/       streams, FFmpeg, WebP e texto
scripts/        pareamento, doctor, relatório de ambiente e runner de testes
```
