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

Por padrão, o bot atende somente o privado do dono. O dono pode liberar um chat/grupo com `.ativar` e revogar com `.desativar`. A revogação também limpa as opções de captura, o cache e o placar de jogos daquele chat. ` .desativar tudo` revoga os demais chats.

**Única exceção — Jokenpô secreto:** durante uma série PvP em andamento, o bot troca mensagens privadas com os dois jogadores (a conta do dono é quem envia) para receber a jogada em segredo. O bot só chama no privado quem digitou o comando (`.ppt @oponente` ou `.ppt aceitar`) — quem foi apenas marcado e não respondeu nunca recebe mensagem. Nesse privado só são aceitas jogadas (`1`, `2`, `3`, `pedra`…); qualquer outro assunto, comando ou pessoa continua ignorado em silêncio. Nada é gravado em disco: a série vive em memória e termina com `.jogos cancelar`, `.desativar`, W.O. por tempo ou fim da partida.

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
.enquete <texto livre ou com |>     → cria uma enquete no grupo (IA interpreta frases soltas)
```

A proteção de links considera URLs HTTP(S), links `www.` e domínios simples, ignora mensagens de administradores e só remove mensagens quando o próprio bot é administrador. Se perder essa permissão ou não conseguir confirmar os metadados, não tenta apagar; também não encaminha o link para comandos/downloads. A lista aceita até 50 domínios por grupo; não aceita URL completa, IP, porta ou curinga. Há limite de até 20 tentativas de remoção de links por grupo/minuto; acima disso a proteção bloqueia o processamento do link sem continuar apagando. Boas-vindas e saídas usam um cartão no mesmo estilo dos demais comandos, com o nome do grupo, a menção de quem entrou/saiu e a contagem de membros; as menções são limitadas e nenhum histórico de participantes é guardado (até 5 eventos anunciados por grupo/minuto). Enquetes aceitam tanto o formato `pergunta | opção 1 | opção 2` quanto frases naturais (ex.: `.enquete Hoje tem fut, sim ou nao, ou depende da hora`), interpretadas e corrigidas pela IA (de 2 a 12 opções, com limite de 2 por usuário a cada 5 minutos e 20 por grupo/hora).

O `.menu` se adapta ao contexto: dentro de um grupo ele traz as ferramentas de gestão (boas-vindas, anti-link e enquete); em uma conversa privada liberada essas opções ficam de fora, com uma nota de onde elas valem.

Esses controles ajudam a reduzir spam e links indesejados, mas **não são moderação completa e não garantem que ninguém publique ou use conteúdo ilegal**. Administradores continuam responsáveis por revisar as regras e as mensagens do grupo.

### IA e dados enviados a terceiros

Os comandos de IA usam provedores externos configurados (ou Pollinations quando não há outras chaves). Perguntas, trechos citados e descrições de imagem podem ser enviados ao provedor de IA escolhido para gerar a resposta; no `.voz`, o texto vai apenas para os motores online grátis que falarem por ele (com o motor offline instalado, a voz sai do próprio aparelho e nada é enviado). **Não envie senhas, dados de pagamento ou informações sensíveis.**

Detalhando o caminho de cada um:

- **`.ia`** — o texto vai para o provedor de chat configurado (Groq, Gemini, OpenAI, endpoint próprio) ou, sem chaves, para o Pollinations.
- **`.criar`** — a sua descrição é reescrita pelo provedor de chat (quando disponível) e o prompt final vai para o gerador de imagem: Gemini, OpenAI ou Pollinations.
- **`.voz`** — a voz é 100% grátis e não usa nenhum serviço pago. O texto é falado pelo serviço "Ler em voz alta" do Microsoft Edge (grátis e sem chave; a Microsoft recebe o texto como receberia de qualquer leitor de tela) ou, se ele falhar, pelos provedores gratuitos de reserva (StreamElements/Google/Pollinations). Com `espeak` instalado há ainda os motores **offline** (`espeak`/`piper`), que falam sem internet e sem enviar o texto para fora.

Tudo isso são serviços de terceiros: a retenção e o uso do texto seguem as políticas de cada um. Em `.pools` você vê quais estão ativos no seu bot.

A IA conversa em português do Brasil num tom natural e tranquilo, sem gírias ou emojis por padrão. Se a pessoa vier na brincadeira, pode acompanhar com humor e uma resposta esperta, sem imitar cada gíria; provocações inofensivas e frases vulgares entram na resenha, sem respostas automáticas de recusa. Em perguntas sérias ou situações delicadas, prioriza clareza e cuidado. A memória de conversa é isolada por chat e remetente, fica apenas em RAM por até 30 minutos e é limitada em tamanho; `.ia reset` limpa a memória daquele remetente. Prompts não são gravados nos logs. A retenção e o tratamento pelo provedor externo seguem as políticas desse provedor.

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
.ia <pergunta>                  → IA conversa natural e entra na resenha se o contexto pedir
.criar <descrição> [atalhos]    → geração de imagem (prompt otimizado)
.criar anime um gato --formato 9:16 --hd  → estilo, enquadramento e nitidez
.voz <texto>                    → texto para áudio (voz do chat)
.voz grossa <texto>             → tom grave · `.voz fina` faz o contrário
.voz masculina --tom -30 oi     → voz, tom e velocidade na mesma frase
.vozes                          → vozes, tons e como configurar · `.vozes grossa` ouve
.vozpadrao masculina grossa     → salva a voz só neste chat (`auto` volta)
.traduz <idioma> <texto>        → tradução
.resumo <texto>                 → resumo
.clima <cidade>                 → clima atual e previsão do dia
.cotacao <valor> <origem> <destino> → conversão cambial de referência
.feriados [ano] [país]           → feriados nacionais (padrão: Brasil/ano atual)
.enquete <texto livre ou com |>  → enquete no grupo (IA entende frases naturais ou separadas por |)
.info                            → status do bot (exclusivo do dono)
```

### Jogos & arcade

Os jogos funcionam em chats liberados com `.ativar` e no privado do dono. Use `.jogos` para ver o catálogo; há uma partida de tabuleiro ativa por chat. Se alguém tentar abrir outro jogo com uma partida em curso, o bot explica qual partida está rolando, qual o progresso, como continuar e que `.encerrar` (ou `.jogos cancelar`) encerra a rodada atual. Os palpites aceitos podem ser enviados com o comando ou diretamente, sem prefixo. As dicas (`.termo dica`, `.forca dica`, `.quiz dica`, `.anagrama dica`, `.adivinhe dica`, `.minado dica`) são informadas uma única vez: depois de usadas, o jogo passa a exibir a informação revelada — a categoria na forca, a primeira letra no termo, casas e minas restantes no campo minado — e o rodapé para de repetir o comando.

```text
.velha [facil|medio|dificil]      → Jogo da velha contra o bot
.velha @oponente                  → desafio PvP; a pessoa aceita com .velha aceitar
.velha aberto                     → abre uma partida para alguém do grupo entrar
.termo / .wordle                  → palavra de cinco letras, seis tentativas
.forca / .hangman                 → palavra por categoria, letras ou palavra inteira
.minado                           → campo minado 5×5, coordenadas A1–E5
.minado flag A1                   → marca ou desmarca uma casa
.anagrama / .embaralhada          → descubra a palavra embaralhada
.quiz / .trivia                   → pergunta de conhecimentos gerais
.adivinhe / .numero               → encontre o número de 1 a 100
.ppt pedra|papel|tesoura          → Jokenpô contra o bot, na hora (conta sequência de vitórias 🔥)
.ppt @oponente [1|3|5]            → Jokenpô PvP SECRETO, melhor de 3 por padrão; aceite com .ppt aceitar
.roletarussa [balas 1-5]          → roleta russa solo: puxe o gatilho ou pare para garantir os pontos
.roletarussa @oponente            → duelo de roleta russa; aceite com .roletarussa aceitar
.dado / .dado 3d20                → D6 em emoji ou rolagem de vários dados
.moeda / .caraoucoroa             → cara ou coroa
.roleta pizza | sushi | massa     → escolhe entre opções separadas por |
.placar / .ranking                → ranking persistente deste chat
.placar reset                     → zera o ranking (admin do grupo ou dono)
```

**Roleta russa.** `.roletarussa` carrega o tambor com 1 bala em 6 câmaras (`.roletarussa 3 balas` aumenta o risco, até 5). A cada mensagem o jogador escolhe entre **puxar o gatilho** (`.roletarussa puxar`, ou só `puxar` sem prefixo) e **parar** (`.roletarussa parar`): quem para sai vivo e leva a vitória, com bônus que cresce a cada clique seco sobrevivido — 1 puxada vale 3 pontos, 3 puxadas 5 pontos, e chegar até a última câmara segura rende a insígnia de *Lenda do tambor*. A bala não muda de lugar sozinha: cada câmara vazia deixa a próxima mais perigosa, e o cartão sempre mostra o risco da próxima puxada. No duelo (`.roletarussa @oponente`), os dois alternam as puxadas apontando para a própria cabeça, cada um com 3 das 6 câmaras, e quem encontra a bala perde — o desafiado aceita com `.roletarussa aceitar` ou recusa com `.roletarussa recusar`. O tambor é desenhado em emoji (🎯 câmara da vez · ⬜ coberta · ⚫ já puxada · 💥 bala) e a partida entra no placar do chat como as demais.

**Jokenpô PvP secreto.** Se a jogada fosse digitada no grupo, quem joga por último veria a do outro e ganharia sempre. Por isso, depois do `.ppt aceitar`, o bot **chama os dois no privado**: cada um responde `1` 🪨, `2` 📄 ou `3` ✂️ (ou `pedra`, `papel`, `tesoura`, `.ppt pedra`) e o bot só **revela no grupo quando os dois já travaram a jogada** — com suspense de *JO... KEN... PÔ!*. Empate repete a rodada sem contar; quem não joga em 2 minutos perde por W.O.; o convite expira em 3 minutos; jogar no grupo não vale. O dono joga pelo próprio chat "Você". Se o bot não conseguir chamar alguém, o grupo é avisado e a pessoa pode chamar o número do bot e mandar `1`, `2` ou `3`. Cada pessoa só participa de uma série por vez.

Os tabuleiros são desenhados com **emoji** (❌ ⭕ 🟩🟨⬛ 🟦 🚩 💣 🔴 🎯 ⚫ 💥), que ocupam sempre a mesma largura no WhatsApp — por isso a grade nunca desalinha, em Android, iOS ou Web. Caracteres de desenho de caixa (`┌─┬┐│`) não são usados porque o WhatsApp os renderiza com fontes diferentes. Só a forca usa um bloco monoespaçado, em ASCII puro e sem moldura. O Termo usa visual minimalista (apenas o cabeçalho e a grade de 6 linhas) e valida cada palpite contra um dicionário de palavras reais de 5 letras em português, rejeitando sequências aleatórias como `abcde`. Os nomes de perfil nunca entram nas grades. Partidas em andamento ficam em memória; o ranking fica persistente em `data/games-score.json`, separado por chat. `.desativar` remove a partida e o placar daquele chat.

Links de grupos/redes e conteúdos protegidos podem não estar disponíveis. Faça downloads somente de conteúdo que você tem direito e autorização para acessar.

### Downloads automáticos e limites

- Auto-download de links soltos vem **desligado**. Para ativar conscientemente: `.config autoDownload true`.
- O bot limita cada arquivo a `maxMB` (90 MiB por padrão, configurável entre 1 e 200). Lotes também têm teto agregado de 200 MiB. Figurinhas e mídias recebidas do WhatsApp usam limites próprios.
- Comandos de alto custo têm limitação de frequência e concorrência para reduzir spam e consumo de memória.
- URLs fornecidas por usuários precisam ser HTTP/HTTPS e o destino inicial não pode ser local/privado. O cliente HTTP do bot valida cada redirecionamento e limita o corpo das respostas.
- O `yt-dlp` local é usado automaticamente **só para links do YouTube** (o bot monta a URL canônica a partir do ID, sem redirecionamento controlado pelo usuário) e é o extrator mais forte para `.yt`/`.ytmp3`: `pip install -U yt-dlp` e `pkg install ffmpeg` no Termux. Para os demais sites ele fica **desligado por padrão**, porque o binário segue redirecionamentos próprios que não passam pela validação por salto do bot; só habilite com `NEXUS_ENABLE_YTDLP=true` se confiar nos links e puder controlar a rede de saída. `NEXUS_DISABLE_YTDLP=true` desliga tudo.

### “Não consegui baixar este link — host resolve para endereço local/privado”

Esse aviso **não é o link**: é o DNS do aparelho devolvendo um endereço que o validador do bot considera interno (roteador, localhost, metadata de nuvem). O bot valida cada destino antes de baixar justamente para um link malicioso não apontar para a sua rede.

- **Rede móvel 4G/5G (Vivo/Claro/TIM).** Em IPv6-only com 464XLAT, o DNS64 do operador sintetiza um IPv6 a partir do IPv4 do site — `pin.it` vira `64:ff9b::9765:54`. O bot reconhece os prefixos `64:ff9b::/96` e `64:ff9b:1::/48` e libera quando o IPv4 embutido é público (e continua bloqueando quando ele é `127.0.0.1`, `192.168.x.x`, CGNAT etc.). Operadora com prefixo próprio: `NEXUS_NAT64_PREFIX=<rede>/96` no `.env`.
- **DNS privado / AdGuard / filtro do roteador.** Se a resolução volta como endereço local para um site em que você confia: `NEXUS_ALLOW_LOCAL_HOSTS=pinterest.com,pin.it` (aceita sufixo e `*.dominio`). Vazio por padrão — nada é liberado sem você pedir.
- **Diagnóstico.** `npm run doctor` imprime, para cada site de download, exatamente o que o DNS devolveu, o que foi bloqueado e a tradução NAT64 — usando o mesmo validador do bot. O erro no chat também nomeia o endereço devolvido.

### YouTube: “Sign in to confirm you’re not a bot” e os 403 do `.ytmp3`

O `.ytmp3`/`.yt` tenta, nesta ordem: **yt-dlp → Innertube → Invidious → Cobalt**. Se uma etapa cai, a próxima assume — nenhuma delas é obrigatória.

O que o bot faz sozinho quando o YouTube aperta:

- **Troca de cliente no yt-dlp.** O muro de verificação não trata todos os clientes do player igual. A 1ª tentativa usa a lista padrão do yt-dlp e, se vier “not a bot”/403, ele repete com outras combinações (`YTDLP_PLAYER_CLIENTS` força a primeira, `YTDLP_MAX_ATTEMPTS` limita a insistência).
- **Clientes sem PO token no Innertube.** `VISIONOS` vai primeiro (devolve URL direta, sem cifra e sem token), com `ANDROID_VR`, `IOS` e `ANDROID` como reservas.
- **Toda URL é sondada antes de ser usada.** O CDN do YouTube passou a liberar só o começo de alguns streams e responder **403 no resto**. O bot testa o primeiro e o último byte: URL que não passa é descartada na hora e a cascata segue, em vez de quebrar na metade do download.
- **Download em faixas.** O `googlevideo` recusa `GET` aberto em parte das URLs; o bot baixa em blocos de ~1 MiB, como o player real.

Quando nada disso basta, o problema é o **IP** (datacenter/VPN ou excesso de requisições) — e aí o bot responde com a dica em vez de um “tente de novo” vazio. Na ordem do que resolve:

```bash
pip install -U yt-dlp   # 1. desafio muda a cada poucas semanas; build de +1 mês falha parecendo bloqueio
                        # 2. desligue VPN/proxy — IP de datacenter é o mais penalizado
```

```env
# 3. só então: cookies de uma conta logada, exportados em ABA ANÔNIMA
#    (feche a aba logo depois; o YouTube rotaciona a sessão)
YTDLP_COOKIES=/data/data/com.termux/files/home/cookies.txt
YTDLP_COOKIES_FROM_BROWSER=          # alternativa em PC: chrome · firefox:perfil
```

Com cookies o yt-dlp **pula** os clientes que dispensam PO token (`android_vr`, `tv_simply`, `ios`), então o bot mantém uma tentativa final **sem** cookies — cobre os dois cenários sem você escolher. `npm run doctor` mostra a versão do yt-dlp, avisa quando ela está velha e confirma se os cookies foram lidos.

## Configuração

Copie o exemplo e proteja o arquivo:

```bash
cp .env.example .env
```

`.env` é local e ignorado pelo Git. Alterações exigem reinicialização. `npm run env` mostra somente contagens e caminhos, não imprime chaves.

### Provedores de IA

```env
GEMINI_KEYS=...
GROQ_KEYS=gsk_chave1,gsk_chave2,gsk_chave3
GROQ_MODELS=openai/gpt-oss-120b,openai/gpt-oss-20b
OPENAI_KEYS=...
AI_BASE_URL=https://openrouter.ai/api/v1
AI_KEYS=...
AI_MODEL=...
AI_MODELS=...
POLLINATIONS_KEYS=...
# imagem (opcional — sem nada aqui já funciona pelo Pollinations)
IMAGE_MODEL=flux
IMAGE_MODELS=flux,turbo,sana
GEMINI_IMAGE_MODELS=
# voz (opcional — tudo grátis, nada disso pede chave)
VOZES_EXTRA=meuvoz=pt-BR-ThalitaNeural|pitch=+25|fx=nasal
# usa o motor offline (espeak/piper) antes das reservas online
VOZ_LOCAL=false
ESPEAK_VOICE=
PIPER_MODEL=
```

`AI_BASE_URL`/`OPENAI_BASE_URL` são endpoints escolhidos pelo operador; as credenciais configuradas serão enviadas a eles. Use somente endpoints confiáveis. Para serviços locais, configure explicitamente o endereço privado apropriado.

#### Várias chaves do mesmo provedor

Todo provedor aceita **quantas chaves você quiser**, na mesma linha ou espalhadas:

```env
# 1) todas juntas (vírgula ou espaço)
GROQ_KEYS=gsk_chave1,gsk_chave2,gsk_chave3

# 2) uma por variável (aceita GROQ_API_KEY e GROQ_KEY)
GROQ_API_KEY=gsk_chave1
GROQ_KEY=gsk_chave2

# 3) numeradas (GROQ_KEY_1 … GROQ_KEY_12)
GROQ_KEY_1=gsk_chave1
GROQ_KEY_2=gsk_chave2
```

Todas entram no mesmo pool e giram em rodízio: quando uma estoura o limite, a
próxima assume. Os limites e cooldowns informados pelo provedor continuam sendo
respeitados — pools não tornam uma cota ilimitada nem devem contornar as regras
do serviço.

#### Modelos em cascata (o antídoto para "HTTP 404 model does not exist")

Provedores descontinuam modelos com frequência. Dois exemplos reais que
quebraram este bot: a Groq desligou `llama-3.3-70b-versatile` em 16/08/2026 e o
Google desligou `gemini-2.0-flash` em 01/06/2026 — a partir daí, todo pedido
devolvia `404 model_not_found` e **trocar a chave não resolvia nada**.

Por isso cada provedor usa uma **lista** de modelos, em ordem de preferência:

1. o modelo que falhou por 404 é marcado e o próximo é tentado **com a mesma chave**;
2. se todos os modelos conhecidos caírem, o bot consulta `GET /models` no provedor
   e passa a usar um modelo que exista hoje;
3. se o provedor inteiro estiver sem modelos de pé, ele é suspenso por 1 minuto
   (em RAM) e a mensagem cai para o próximo provedor, sem martelar a API.

Personalize a ordem com `GROQ_MODELS`, `GEMINI_MODELS`, `OPENAI_MODELS` e
`AI_MODELS` (separados por vírgula); sem elas, o bot usa as listas padrão —
`openai/gpt-oss-120b → openai/gpt-oss-20b → qwen/qwen3.8-27b → …` na Groq e
`gemini-3.8-flash → gemini-3.6-flash → …` no Gemini. `.pools` mostra a ordem
em uso, `.pools reset` limpa os cooldowns e as marcas de modelo na hora e
`.pools recarregar` relê o `.env` sem reiniciar o bot.

### Imagem (`.criar`) — como a qualidade subiu

Sem configurar nada, o bot já gera imagem pelo Pollinations (grátis). A diferença
está em três passos:

1. **o prompt é reescrito pela IA** — o seu pedido em português vira um prompt
   em inglês com sujeito, cenário, luz, lente e nível de detalhe (modelos de
   imagem entendem muito melhor assim). Se a IA estiver indisponível, o pedido
   original é usado — nunca fica sem imagem por causa disso;
2. **o melhor motor disponível desenha** — Gemini (com `GEMINI_KEYS`) → OpenAI
   `gpt-image-1` (com `OPENAI_KEYS`) → Pollinations (grátis, sem chave);
3. **acabamento opcional** — `--hd` amplia a imagem com FFmpeg (lanczos +
   nitidez) para ela não chegar borrada no celular.

Atalhos do comando:

```text
--formato 1:1 | 16:9 | 9:16 | 4:3 | 3:4 | 3:2   (aceita também quadrado, vertical, paisagem…)
--estilo realista | anime | cartoon | 3d | pintura | aquarela | desenho |
         cyberpunk | pixel | logo | terror | cartoon3d | mangá
--seed 1234      repete exatamente a mesma imagem
--modelo flux    força um modelo do provedor
--sem <coisa>    pede para evitar um elemento
--hd             amplia no final (FFmpeg)
--bruto          não reescreve o prompt (mais rápido, mais fiel ao seu texto)
```

O estilo também pode vir como primeira palavra (`.criar anime um gato samurai`)
e `.menucriar` mostra esse guia no WhatsApp. A legenda da imagem diz qual motor
e qual formato foram usados.

### Voz (`.voz`) — 100% grátis, com voz e tom configuráveis

**Nenhum serviço pago entra na voz do bot**: não existe chave de ElevenLabs nem
de TTS da OpenAI, e nada aqui pede cartão, conta ou cadastro.

O motor principal é o **"Ler em voz alta" do Microsoft Edge**: vozes neurais
brasileiras, sem chave e sem custo. Não há catálogo de personagem para decorar —
você escolhe **voz**, **tom** e **velocidade**, e o bot aplica isso na própria
síntese (`<prosody pitch rate>` no SSML), não com efeito de desenho por cima.

```text
.voz bom dia, pessoal           → usa a voz configurada neste chat
.voz grossa boa noite           → tom grave só nesta mensagem
.voz fina bom dia               → tom agudo
.voz masculina grossa e aí      → voz + tom na mesma frase
.voz --tom -35 --vel -10 oi     → ajuste fino, número por número
.voz masculina                  → sem texto: manda uma prévia daquela voz
.voz "grossa é o nome"          → aspas = texto literal, sem trocar nada
.vozes                          → o guia completo (e `.vozes grossa` para ouvir)
.vozpadrao                      → mostra o que está salvo neste chat
.vozpadrao masculina grossa     → salva voz + tom neste chat
.vozpadrao --tom -20            → muda só o tom, mantém a voz
.vozpadrao auto                 → volta ao padrão do bot
```

**Vozes:** `auto`, `masculina`, `feminina`, `narrador` (locução grave) e
`jovem`. Também vale o nome técnico do motor (`.voz pt-BR-YaraNeural oi`) e as
vozes criadas por você em `VOZES_EXTRA`.

**Tons:** `muitogrossa` (-45%), `grossa` (-25%), `normal` (0%), `fina` (+25%) e
`muitofina` (+45%). Quer outro valor? Use o número: `--tom` vai de **-60 a +60**
(negativo = mais grossa) e `--vel` vai de **-60 a +60** (velocidade da fala).

```text
.voz masculina --tom -60 --vel -20 boa noite   → o mais grave possível, devagar
.voz feminina --tom +40 --vel +15 bom dia      → aguda e animada
```

Onde cada ajuste é aplicado:

| Motor | Tom e velocidade |
| --- | --- |
| **edge** (principal) | SSML do serviço — qualidade neural, sem FFmpeg |
| **espeak** (offline) | parâmetros nativos do binário (`-p`, `-s`) |
| **piper** e reservas online | FFmpeg: muda a taxa de amostragem e compensa a duração com `atempo` (o timbre muda, a duração não) |

Ou seja: o tom continua valendo mesmo quando o bot cai para um motor de reserva
— e a legenda do áudio sempre diz o que foi usado
(`Masculina · tom -25% (grossa) · edge (online, grátis)`).

Efeitos são opcionais e ficam fora do caminho por padrão: `--fx ecoCurto`,
`--fx radio`, `--fx sussurro` (precisam de FFmpeg; sem ele a voz sai igual, só
sem o efeito).

**Criando as suas vozes** (`.env`, o catálogo é relido a cada uso):

```env
# nome=voz|pitch=+30|rate=+5|fx=nasal+ecoCurto|desc=o que aparece no .vozes
VOZES_EXTRA=meuvoz=pt-BR-ThalitaNeural|pitch=+25|rate=+10|fx=nasal
VOZES_EXTRA=meuvoz=pt-BR-ThalitaNeural|pitch=+25,meugrave=pt-BR-AntonioNeural|pitch=-10|fx=radio
```

O `--tom` do comando tem prioridade sobre o `pitch` da voz do `.env` (a
velocidade e os efeitos da voz continuam valendo).

Também dá para escolher o motor na própria voz (todos grátis):

```env
VOZES_EXTRA=voz_local=espeak:pt-br+f3|fx=robotico
VOZES_EXTRA=neurinha=piper:pt_BR-faber-medium.onnx|rate=-10
```

**Voz offline (opcional, grátis e sem internet).** Se você instalar o
`espeak-ng`, o bot passa a ter um motor local: a voz sai do próprio aparelho,
sem mandar o texto para fora e sem depender de serviço nenhum.

```bash
pkg install espeak          # Termux
apt install espeak-ng       # Debian/Ubuntu
dnf install espeak-ng       # Fedora
winget install espeak-ng    # Windows
```

O `piper` (voz neural offline, mais bonita) também é detectado quando existe
binário + modelo: `PIPER_MODEL=/caminho/voz.onnx`. Modelos grátis em
[huggingface.co/rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices).
Com `VOZ_LOCAL=true` no `.env` o motor offline é tentado antes das reservas
online — bom para rede instável.

A cadeia de reserva garante que o áudio sai mesmo se o motor principal mudar:
Edge (online, grátis) → StreamElements → Google → Pollinations →
**espeak/piper (offline, grátis)**. Com `VOZ_LOCAL=true` o motor offline passa
na frente das reservas online. Cada motor que falha entra em cooldown de 10 minutos
(ou `.pools reset` para liberar na hora) e a legenda diz qual motor foi usado.
Sem o motor offline instalado e sem internet, o `.voz` avisa o que fazer em vez
de ficar tentando à toa.

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

#### Instâncias Cobalt auto-suficientes

O Cobalt não tem instância oficial aberta: quem hospeda pode desligar o serviço
ou passar a exigir **Cloudflare Turnstile** (desafio de navegador que um bot
jamais resolve) a qualquer momento. Por isso o bot descobre, testa e mantém a
lista de instâncias **sozinho**:

1. **Descoberta** — consulta `instances.cobalt.best` (fonte principal) e
   `cobalt.directory` (reserva) e filtra candidatas: online, https, versão 10+
   e sem autenticação conhecida.
2. **Verificação de saúde** — testa cada candidata de verdade: `GET /` (versão
   e sitekey do Turnstile) + um `POST` real com timeout curto. Classifica como
   `ok`, `turnstile`, `rate-limited` ou `morta`; fora do formato da API do
   cobalt é descartada. Instâncias com Turnstile **nunca** entram no pool.
3. **Cache** — a lista boa fica em `data/cache/cobalt-instances.json` (com
   timestamp) e é recarregada no boot com zero latência.
4. **Revalidação** — a cada `COBALT_DISCOVER_INTERVAL_H` horas (padrão 12) e
   também **na hora** quando todas as instâncias do pool entram em cooldown —
   o bot se recupera no meio da falha, sem esperar o próximo ciclo.

Precedência (o bot nunca fica sem pool): `COBALT_INSTANCES` no `.env`
(modo manual, descoberta desligada) → cache local → descoberta → lista padrão
embutida. Configuração:

```env
COBALT_AUTO_DISCOVER=true      # ligar/desligar a descoberta (padrão: true)
COBALT_DISCOVER_INTERVAL_H=12  # intervalo da revalidação (1–168h)
```

Segurança: toda requisição usa o cliente HTTP do bot (validação de
SSRF/redirecionamento e limite de corpo); só URLs https públicas na raiz do
domínio são aceitas, com teto de instâncias adotadas. Quando uma instância
recusa por Turnstile, o log e a mensagem de erro dizem isso claramente
("exige verificação de navegador, trocando de instância") em vez do `HTTP 401`
genérico. O `.info` e o `npm run doctor` mostram quantas instâncias estão
ativas, de onde vieram (manual/cache/descoberta/padrão) e a última atualização.

### Comandos locais de configuração

```text
.config                         → ver preferências e contagens
.config autoDownload false      → desligar downloads automáticos
.config qualidadePadrao media   → qualidade padrão
.config maxMB 120               → limite por arquivo (1–200 MiB)
.doctor                         → diagnóstico no WhatsApp (dono)
.pools                          → chaves e modelos dos provedores (dono)
.pools reset                    → limpa cooldowns e modelos marcados (dono)
.pools recarregar               → relê o .env sem reiniciar (dono)
```

## Desenvolvimento e validação

```bash
npm ci
npm test
npm run doctor
```

A suíte executa os arquivos de teste em processos sequenciais, cada um com `NEXUS_DATA_DIR` temporário próprio (removido ao final), incluindo testes offline de jogos e alinhamento de tabuleiros, limites, cache, roteamento, migração, SSRF, redirecionamentos e streams.

## Estrutura

```text
src/
├── core/       config, HTTP seguro, key pools, armazenamento, limites
├── wa/         cliente Baileys, cache, reenvio de mensagens (sent-store), cache de grupos e helpers de mídia em stream
├── features/   router, jogos, View Once, Anti-Delete, IA (chat, imagem e voz:
│              voices.js + tts-edge.js + tts-local.js), figurinhas e downloads
└── util/       streams, FFmpeg, WebP e texto
scripts/        pareamento, doctor, relatório de ambiente e runner de testes
```
