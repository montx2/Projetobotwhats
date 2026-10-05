// 🩺 Doctor: verifica o ambiente antes de rodar o MontxBOT.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ok = (m) => console.log(`✅ ${m}`);
const warn = (m) => console.log(`⚠️ ${m}`);
const bad = (m) => console.log(`❌ ${m}`);

console.log('\n🩺 NEXUS DOCTOR\n');

// Load the same .env the bot uses before inspecting opt-in runtime flags.
const { ENV_FILE, loadDotEnv, envList, envBool } = await import('../src/core/env.js');
const envLoad = loadDotEnv();

// Node
const major = Number(process.versions.node.split('.')[0]);
if (major >= 22) ok(`Node ${process.version}`);
else bad(`Node ${process.version} — precisa do Node 22+ (pkg install nodejs-lts)`);

// FFmpeg
const ff = spawnSync(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg', ['-version'], { timeout: 8000 });
if (ff.status === 0) {
  ok('FFmpeg instalado');
  ok('figurinhas: mídia anexada/citada E figurinha direto de link (.s <link>) funcionando');
} else {
  bad('FFmpeg ausente — figurinhas e conversões precisam dele.\n   Termux: pkg install ffmpeg · Linux: apt install ffmpeg · Windows: winget install ffmpeg');
}

// Voz (.voz) — tudo grátis: motor online sem chave + motores offline opcionais.
const { localStatus } = await import('../src/features/tts-local.js');
const voice = localStatus();
console.log('ℹ️ Voz (.voz): grátis e sem chave — edge (online) + streamelements/google/pollinations (reservas).');
if (voice.espeak.installed) ok(`voz offline: espeak instalado (${voice.espeak.bin}) — .voz fala até sem internet`);
else warn('voz offline: espeak não instalado (opcional) — Termux: pkg install espeak · Linux: apt install espeak-ng');
if (voice.piper.installed) ok(`voz offline neural: piper (${voice.piper.model})`);

// yt-dlp: usado automaticamente SÓ para links do YouTube (URL canônica montada
// pelo bot). Para os demais sites continua desligado por padrão, por segurança.
const { findYtdlp, isYtdlpEnabled, canUseYtdlp, youtubeWatchUrl, ytdlpVersion, hasCookies } = await import(
  '../src/features/downloaders/ytdlp.js'
);
const ytdlp = findYtdlp();
if (canUseYtdlp(youtubeWatchUrl('dQw4w9WgXcQ'))) {
  ok(`yt-dlp ativo para YouTube: ${ytdlp.join(' ')}${isYtdlpEnabled() ? ' (e demais sites)' : ' (demais sites: NEXUS_ENABLE_YTDLP=false)'}`);
  // Versão velha é a causa nº 1 de "Sign in to confirm you're not a bot": o
  // YouTube muda o desafio a cada poucas semanas.
  const version = ytdlpVersion();
  const parts = String(version).match(/^(\d{4})\.(\d{2})\.(\d{2})/);
  if (parts) {
    const days = Math.floor((Date.now() - Date.UTC(+parts[1], +parts[2] - 1, +parts[3])) / 86_400_000);
    if (days >= 30) warn(`yt-dlp ${version} tem ${days} dias — atualize: pip install -U yt-dlp (evita o falso "bot check")`);
    else ok(`yt-dlp atualizado (${version}, ${days} dia(s))`);
  }
  if (hasCookies()) ok('cookies do YouTube configurados (usados quando o IP cai no muro de verificação)');
} else if (!ytdlp) {
  warn('yt-dlp não encontrado — é o extrator mais forte para .ytmp3/.yt. Termux/Linux: pip install -U yt-dlp');
} else {
  warn('yt-dlp desligado por NEXUS_DISABLE_YTDLP=true — .ytmp3/.yt vão depender só de Innertube/Cobalt');
}

// Dependências
if (fs.existsSync(path.join(ROOT, 'node_modules', '@whiskeysockets', 'baileys'))) ok('Dependências npm instaladas');
else bad('Dependências ausentes — rode: npm ci');

// .env — validado com O MESMO carregador que o bot usa (src/core/env.js).
// Antes o doctor lia o arquivo "na mão" e podia dizer "configurado" enquanto o
// bot dizia "sem chaves"; agora os dois enxergam exatamente a mesma coisa.
if (!envLoad.loaded) {
  warn(`.env ausente em ${ENV_FILE} — copie o .env.example para .env e preencha (opcional mas recomendado)`);
} else {
  ok(`.env lido pelo bot: ${ENV_FILE} (${envLoad.entries} variável(is) no arquivo)`);
  const bgOk = envList('REMOVE_BG_KEYS').length || envList('REMOVE_BG_URLS').length || envBool('LOCAL_REMBG', false);
  if (bgOk) {
    ok(
      `remoção de fundo: ${envList('REMOVE_BG_KEYS').length} chave(s) remove.bg · ` +
        `${envList('REMOVE_BG_URLS').length} endpoint(s) · rembg local ${envBool('LOCAL_REMBG', false) ? 'ligado' : 'desligado'}`
    );
  } else {
    warn('remoção de fundo: nenhuma chave — .fundo e .sfundo vão falhar. Coloque REMOVE_BG_KEYS=chave1,chave2');
  }
  const { envSummary } = await import('../src/core/config.js');
  const summary = envSummary();
  const ia = {
    'IA Gemini': summary.geminiKeys,
    'IA OpenAI': summary.openaiKeys,
    'IA Groq': summary.groqKeys,
    'IA custom (AI_KEYS)': summary.aiKeys,
    'IA Pollinations': summary.pollinationsKeys
  };
  for (const [label, count] of Object.entries(ia)) {
    if (count) ok(`${label}: ${count} chave(s)`);
    else warn(`${label}: vazio — funciona sem (o bot usa Pollinations grátis)`);
  }
  if (summary.groqKeys === 1) {
    warn('IA Groq: só 1 chave. Se ela estourar o limite, a IA cai no Pollinations — aceita várias: GROQ_KEYS=gsk_1,gsk_2,gsk_3');
  }
  const pinnedModels = [
    ['GROQ_MODELS', summary.groqModels],
    ['GEMINI_MODELS', summary.geminiModels],
    ['AI_MODELS', summary.aiModels]
  ].filter(([, count]) => count > 0);
  if (pinnedModels.length) {
    ok(`modelos fixados no .env: ${pinnedModels.map(([name, count]) => `${name} (${count})`).join(' · ')} — o bot usa essa ordem antes do padrão`);
  } else {
    console.log('ℹ️ Modelos: usando as listas padrão do bot (com reserva automática quando um modelo é descontinuado).');
  }
}

// Cobalt — funciona até SEM .env (auto-descoberta ligada por padrão), então o
// diagnóstico entra fora do bloco do .env. Aqui é leitura offline do cache:
// o doctor não faz rede.
{
  const { readCobaltCache, DEFAULT_INSTANCES, agoText } = await import('../src/features/downloaders/cobalt-instances.js');
  const manual = envList('COBALT_INSTANCES').length;
  const autoDiscover = envBool('COBALT_AUTO_DISCOVER', true);
  if (manual) {
    ok(`downloads universais (Cobalt): modo manual — ${manual} instância(s) do .env (descoberta desligada)`);
  } else {
    const cache = readCobaltCache();
    if (cache) {
      ok(
        `downloads universais (Cobalt): ${cache.instances.length} instância(s) descoberta(s) no cache · ` +
        `última atualização ${agoText(cache.updatedAt)}${cache.source ? ` · fonte: ${cache.source}` : ''}`
      );
    } else if (autoDiscover) {
      console.log(
        `ℹ️ downloads universais (Cobalt): sem cache ainda — o bot descobre instâncias sozinho ao iniciar ` +
        `(${DEFAULT_INSTANCES.length} padrão como reserva imediata)`
      );
    } else {
      warn(
        `downloads universais (Cobalt): sem cache e COBALT_AUTO_DISCOVER=false — ` +
        `usando as ${DEFAULT_INSTANCES.length} instâncias padrão embutidas`
      );
    }
    const intervalH = Math.min(168, Math.max(1, Math.round(Number(process.env.COBALT_DISCOVER_INTERVAL_H) || 12)));
    console.log(`ℹ️ Cobalt auto-descoberta: ${autoDiscover ? `ligada (revalida a cada ${intervalH}h)` : 'desligada (COBALT_AUTO_DISCOVER=false)'}`);
  }
}

// DNS/rede — a causa nº 1 do "não baixa nada": o DNS do aparelho devolve um
// endereço local/privado (DNS64 de rede móvel, DNS privado/AdGuard, filtro do
// operador) e o validador do bot recusa o download antes mesmo de tentar.
// Aqui é o MESMO validador do bot (src/core/http.js), não um `ping` qualquer.
{
  const { dnsReport } = await import('../src/core/http.js');
  const hosts = [
    'pin.it', 'www.pinterest.com', 'i.pinimg.com',
    'www.tiktok.com', 'www.instagram.com', 'www.youtube.com', 's.whatsapp.net'
  ];
  console.log('\nℹ️ DNS dos sites de download (o que o validador do bot vê):');
  const blockedHosts = [];
  const deadHosts = [];
  for (const host of hosts) {
    const report = await dnsReport(host);
    if (report.error) {
      bad(`DNS ${host}: resolução falhou (${report.error}) — o DNS do aparelho não devolveu endereço`);
      deadHosts.push(host);
      continue;
    }
    if (report.allowed) {
      const nat64 = report.nat64.length ? ` · NAT64 ${report.nat64[0].address} → ${report.nat64[0].ipv4} (ok)` : '';
      ok(`DNS ${host}: ${report.answers.map((a) => a.address).slice(0, 3).join(', ')}${nat64}`);
      continue;
    }
    blockedHosts.push(host);
    bad(`DNS ${host}: endereço local/privado (${report.blocked.join(', ')}) — download desse site vai falhar`);
  }
  // Dois problemas diferentes, dois conselhos: quem não resolveu não tem nada a
  // ver com o validador de endereço privado (liberar o host não resolveria).
  if (blockedHosts.length) {
    warn(
      `DNS devolvendo endereço local/privado para: ${blockedHosts.join(', ')}. É a REDE, não o link:\n` +
        '   1) Android: Configurações → Rede e internet → DNS privado → "Desativado" (ou troque para 1.1.1.1 / 8.8.8.8)\n' +
        '   2) Teste em outra rede (Wi-Fi ↔ dados móveis) para confirmar\n' +
        '   3) Operadora com prefixo DNS64 próprio: NEXUS_NAT64_PREFIX=<prefixo>/96 no .env\n' +
        `   4) Confiando no site, libere no .env: NEXUS_ALLOW_LOCAL_HOSTS=${blockedHosts.join(',')}`
    );
  }
  if (deadHosts.length) {
    warn(
      `DNS sem resposta para: ${deadHosts.join(', ')}. Verifique a conexão do aparelho, ` +
        'o DNS privado do Android e se há proxy/VPN ativo (ou bloqueio de saída no firewall).'
    );
  }
  if (process.env.NEXUS_ALLOW_LOCAL_HOSTS) ok(`NEXUS_ALLOW_LOCAL_HOSTS ativo: ${process.env.NEXUS_ALLOW_LOCAL_HOSTS}`);
  if (process.env.NEXUS_NAT64_PREFIX) ok(`NEXUS_NAT64_PREFIX ativo: ${process.env.NEXUS_NAT64_PREFIX}`);
}

// Sessão
const authDir = path.join(ROOT, 'data', 'auth');
if (fs.existsSync(path.join(authDir, 'creds.json'))) ok('Sessão WhatsApp salva (já pareado)');
else console.log('ℹ️ Sem sessão ainda — no primeiro start o bot pede pareamento.');

// Plataforma
if (process.env.TERMUX_VERSION || String(process.env.HOME || '').includes('com.termux')) {
  ok('Termux detectado — pareamento será por CÓDIGO (sem QR Code) ✔️');
} else {
  console.log(`ℹ️ Plataforma: ${process.platform} — QR Code habilitado no terminal`);
}

console.log('\n✨ Diagnóstico concluído.\n');
