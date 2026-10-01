// Salva o número para pareamento por código: node scripts/pair.mjs 5511999999999
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = process.env.NEXUS_DATA_DIR || path.join(ROOT, 'data');
const AUTH_DIR = path.join(DATA_DIR, 'auth');

const digits = String(process.argv[2] || '').replace(/\D/g, '');
if (!/^\d{10,15}$/.test(digits)) {
  console.error('❌ Número inválido. Use DDI + DDD + número, só dígitos.');
  console.error('   Ex.: ./bot.sh pair 5537999999999');
  process.exit(1);
}

// Brasil: celular = 55 + DDD(2) + 9 + 8 dígitos = 13 dígitos
if (digits.startsWith('55') && digits.length === 12) {
  console.warn('⚠️  Número brasileiro com 12 dígitos: faltou o 9 depois do DDD?');
  console.warn('    Normalmente é 55 + DDD + 9 + número (13 dígitos).');
}

// Se a sessão anterior nunca concluiu o pareamento, apaga para começar limpo.
try {
  const credsFile = path.join(AUTH_DIR, 'creds.json');
  if (fs.existsSync(credsFile)) {
    const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
    if (!creds.registered) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  }
} catch {
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
}
fs.rmSync(path.join(DATA_DIR, 'pairing-code.txt'), { force: true });

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'pairing-number.txt'), digits + '\n', { mode: 0o600 });
console.log(`✅ Número salvo: +${digits}`);
console.log('🚀 Agora rode: ./bot.sh start');
console.log('📱 No WhatsApp: Dispositivos conectados → Conectar com número de telefone');
