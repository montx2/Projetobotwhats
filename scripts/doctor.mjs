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

// .env
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  ok('.env presente');
  const env = fs.readFileSync(envFile, 'utf8');
  const keys = {
    REMOVE_BG_KEYS: 'remoção de fundo (remove.bg)',
    GEMINI_KEYS: 'IA Gemini',
    OPENAI_KEYS: 'IA OpenAI',
    GROQ_KEYS: 'IA Groq',
    COBALT_INSTANCES: 'downloads universais (Cobalt)'
  };
  for (const [key, label] of Object.entries(keys)) {
    const line = env.split('\n').find((l) => l.startsWith(key + '='));
    const value = line ? line.slice(key.length + 1).trim() : '';
    if (value) ok(`${label}: configurado (${value.split(',').length} item(ns))`);
    else warn(`${label}: vazio — funciona sem, mas leia o README para ativar ${label}`);
  }
} else {
  warn('.env ausente — copie o .env.example para .env e preencha (opcional mas recomendado)');
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
