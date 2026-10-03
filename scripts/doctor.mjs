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

// yt-dlp (opcional e desligado por padrão por segurança)
const { hasYtDlp, findYtdlp, isYtdlpEnabled } = await import('../src/features/downloaders/ytdlp.js');
const ytdlp = findYtdlp();
if (!isYtdlpEnabled()) {
  warn(`yt-dlp ${ytdlp ? `detectado (${ytdlp.join(' ')})` : 'não detectado'}, mas desativado por padrão. Habilite conscientemente com NEXUS_ENABLE_YTDLP=true.`);
} else if (hasYtDlp()) ok(`yt-dlp habilitado: ${ytdlp.join(' ')}`);
else warn('yt-dlp habilitado, mas não encontrado — Termux/Linux: pip install -U yt-dlp');

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
  const cobalt = envList('COBALT_INSTANCES').length;
  if (cobalt) ok(`downloads universais (Cobalt): ${cobalt} instância(s)`);
  else warn('downloads universais (Cobalt): vazio — o bot usa as instâncias públicas (opcional)');
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
