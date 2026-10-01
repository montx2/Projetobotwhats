// 🩺 Doctor: verifica o ambiente antes de rodar o NEXUS.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ok = (m) => console.log(`✅ ${m}`);
const warn = (m) => console.log(`⚠️ ${m}`);
const bad = (m) => console.log(`❌ ${m}`);

console.log('\n🩺 NEXUS DOCTOR\n');

// Node
const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) ok(`Node ${process.version}`);
else bad(`Node ${process.version} — precisa do Node 20+ (pkg install nodejs-lts)`);

// FFmpeg
const ff = spawnSync(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg', ['-version'], { timeout: 8000 });
if (ff.status === 0) ok('FFmpeg instalado');
else bad('FFmpeg ausente — figurinhas e conversões precisam dele.\n   Termux: pkg install ffmpeg · Linux: apt install ffmpeg · Windows: winget install ffmpeg');

// yt-dlp (opcional, modo turbo dos downloads)
const { hasYtDlp, findYtdlp } = await import('../src/features/downloaders/ytdlp.js');
const ytdlp = findYtdlp();
if (hasYtDlp()) ok(`yt-dlp instalado (modo turbo dos downloads): ${ytdlp.join(' ')}`);
else warn('yt-dlp ausente (opcional) — dá uma reserva fortíssima nos downloads.\n   Termux/Linux: pip install -U yt-dlp');

// Dependências
if (fs.existsSync(path.join(ROOT, 'node_modules', '@whiskeysockets', 'baileys'))) ok('Dependências npm instaladas');
else bad('Dependências ausentes — rode: npm install');

// .env — validado com O MESMO carregador que o bot usa (src/core/env.js).
// Antes o doctor lia o arquivo "na mão" e podia dizer "configurado" enquanto o
// bot dizia "sem chaves"; agora os dois enxergam exatamente a mesma coisa.
const { ENV_FILE, loadDotEnv, envList, envBool } = await import('../src/core/env.js');
const envLoad = loadDotEnv();
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
  const ia = {
    'IA Gemini': envList('GEMINI_KEYS').length,
    'IA OpenAI': envList('OPENAI_KEYS').length,
    'IA Groq': envList('GROQ_KEYS').length,
    'IA Pollinations': envList('POLLINATIONS_KEYS').length
  };
  for (const [label, count] of Object.entries(ia)) {
    if (count) ok(`${label}: ${count} chave(s)`);
    else warn(`${label}: vazio — funciona sem (o bot usa Pollinations grátis)`);
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
