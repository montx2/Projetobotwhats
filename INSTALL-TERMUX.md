# Instalação do MontxBOT no Termux

O bot exige Node.js 22+ e FFmpeg. A sessão e a configuração ficam em `data/` e não devem ser compartilhadas: o diretório contém credenciais do WhatsApp e, se habilitado, cache privado.

O FFmpeg é obrigatório para figurinhas e recomendado para voz e imagem: sem ele o `.voz` ainda fala (as vozes do catálogo perdem só os efeitos), o `.criar --hd` não amplia e o áudio vai como MP3 em vez de mensagem de voz (PTT).

## 1. Instale os pacotes

Use o Termux atualizado (recomendado via F-Droid) e execute:

```bash
pkg update -y && pkg upgrade -y
pkg install -y git nodejs-lts ffmpeg procps
```

Confirme a versão do Node:

```bash
node --version
```

Ela deve ser `v22` ou superior.

## 2. Obtenha e instale o bot

```bash
git clone https://github.com/montx2/Bot-zap-zap.git
cd Bot-zap-zap
./install-termux.sh
npm run doctor
```

O instalador usa o `package-lock.json` para instalar versões reproduzíveis; Baileys permanece fixado em 6.7.24.

## 3. Pareie a conta

Use uma conta sob seu controle. Informe DDI + DDD + número, só dígitos:

```bash
./bot.sh pair 5511999999999
./bot.sh start
```

No WhatsApp, abra **Dispositivos conectados → Conectar com número de telefone** e insira o código de 8 letras exibido no Termux. Não compartilhe o código nem a pasta `data/auth/`.

## 4. Configure serviços opcionais

O bot pode operar sem chaves de API. Para provedores adicionais:

```bash
cp .env.example .env
nano .env
```

Mantenha `.env` privado. As chamadas de IA enviam o conteúdo necessário ao provedor configurado; endpoints customizados são confiáveis por configuração e podem acessar rede local. Consulte o README antes de habilitar serviços.

## 5. Uso básico e privacidade

- `.menu` mostra os comandos.
- O bot responde apenas no privado do dono até que um chat/grupo seja liberado com `.ativar`.
- Captura automática de View Once, Anti-Delete e auto-download começam desligados. Ative somente por escolha explícita e leia as retenções/limites no README.
- Use `termux-wake-lock` e remova a otimização de bateria do Termux para manter a sessão ativa.

## Comandos do launcher

| Comando | Ação |
|---|---|
| `./bot.sh start` | inicia o bot |
| `./bot.sh pair NUMERO` | salva o número de pareamento |
| `./bot.sh stop` | encerra o processo |
| `./bot.sh doctor` | diagnóstico local |
| `./bot.sh test` | roda a suíte isolada |
| `./bot.sh update` | atualiza a branch atualmente selecionada e reinstala dependências |

## Problemas comuns

- **Node abaixo de 22:** `pkg upgrade -y && pkg install nodejs-lts`.
- **FFmpeg ausente:** `pkg install ffmpeg`.
- **Dependências faltando:** `npm ci` na pasta do bot.
- **Sessão encerrada:** confira a internet e o estado da conta; se for necessário refazer o pareamento, preserve `data/config.json` e remova somente a sessão antiga com cuidado.
- **Provedor sem chave:** `npm run env` informa caminhos e contagens, sem revelar valores secretos.
