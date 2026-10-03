// 🔎 Relatório do .env — mostra EXATAMENTE o que o bot está enxergando.
//
// Uso:  npm run env     (ou: node scripts/env-report.mjs)
//
// Serve para matar a dúvida "coloquei a chave e não funciona": aqui aparece o
// caminho do arquivo que o bot procura e quantas chaves ele encontrou em cada
// variável. Se o caminho estiver errado, é só mover/criar o .env ali.
import { ENV_FILE, loadDotEnv, envList, envBool } from '../src/core/env.js';
import { envSummary } from '../src/core/config.js';

const load = loadDotEnv();
const s = envSummary();

const line = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`);

console.log('\n🔎 CONFIGURAÇÃO DO BOT (.env)\n');
line('Arquivo procurado', ENV_FILE);
line('Encontrado?', load.loaded ? '✅ sim' : '❌ NÃO — crie o .env na raiz do bot (cp .env.example .env)');
line('Variáveis no arquivo', String(load.entries));

console.log('\n  ── Remoção de fundo (.fundo / .sfundo) ──');
line('REMOVE_BG_KEYS', s.removeBgKeys ? `✅ ${s.removeBgKeys} chave(s)` : '❌ vazio — crie contas grátis em remove.bg/api');
line('REMOVE_BG_URLS', s.removeBgUrls ? `✅ ${s.removeBgUrls} endpoint(s)` : '— vazio (opcional)');
line('LOCAL_REMBG', s.localRembg || envBool('LOCAL_REMBG') ? '✅ ligado' : '— desligado (opcional)');
if (!s.removeBgKeys && !s.removeBgUrls && !s.localRembg) {
  console.log('  ⚠️  Sem nenhum provedor: .fundo e .sfundo vão responder "Nenhum provedor configurado".');
}

console.log('\n  ── IA (.ia / .criar / .voz) ──');
line('GEMINI_KEYS', s.geminiKeys ? `✅ ${s.geminiKeys} chave(s)` : '— vazio');
line('GROQ_KEYS', s.groqKeys ? `✅ ${s.groqKeys} chave(s)` : '— vazio (aceita várias: GROQ_KEYS=gsk_1,gsk_2)');
line('OPENAI_KEYS', s.openaiKeys ? `✅ ${s.openaiKeys} chave(s)` : '— vazio');
line('AI_KEYS', s.aiKeys ? `✅ ${s.aiKeys} chave(s)` : '— vazio');
line('POLLINATIONS_KEYS', s.pollinationsKeys ? `✅ ${s.pollinationsKeys} chave(s)` : '— vazio (usa Pollinations grátis)');
line('AI_BASE_URL / AI_MODEL', `${process.env.AI_BASE_URL || '—'} / ${process.env.AI_MODEL || '—'}`);
line('GROQ_MODELS', s.groqModels ? `${s.groqModels} modelo(s) fixado(s)` : '— padrão do bot (gpt-oss-120b → reservas)');
line('GEMINI_MODELS', s.geminiModels ? `${s.geminiModels} modelo(s) fixado(s)` : '— padrão do bot (gemini-3.8-flash → reservas)');
line('AI_MODELS', s.aiModels ? `${s.aiModels} modelo(s) fixado(s)` : '— padrão do bot');

console.log('\n  ── Imagem (.criar) ──');
line('IMAGE_MODEL', s.imageModel || '— padrão do bot (flux → reservas)');
line('IMAGE_MODELS', s.imageModels ? `${s.imageModels} modelo(s) fixado(s)` : '— padrão do bot');
line('GEMINI_IMAGE_MODELS', s.geminiImageModels ? `${s.geminiImageModels} modelo(s) fixado(s)` : '— descoberta automática');

console.log('\n  ── Voz (.voz) ──');
line('Motor principal', 'edge — grátis, sem chave (WebSocket nativo do Node 22+)');
line('VOZES_EXTRA', s.vozesExtra ? `✅ ${s.vozesExtra} voz(es) personalizada(s)` : '— nenhuma (crie vozes no formato nome=voz|pitch=+30|fx=nasal)');
line('ELEVENLABS_KEYS', s.elevenLabsKeys ? `✅ ${s.elevenLabsKeys} chave(s)` : '— vazio (opcional)');
line('ELEVENLABS_VOICE_ID', process.env.ELEVENLABS_VOICE_ID || '— padrão (Rachel)');

console.log('\n  ── Downloads ──');
line('COBALT_INSTANCES', String(envList('COBALT_INSTANCES').length));
line('TIKTOK_API', String(envList('TIKTOK_API').length));
line('YTDLP_PATH', process.env.YTDLP_PATH || '— (autodetecta no PATH)');

console.log('\n  ── Dono / pareamento ──');
line('OWNER_NUMBERS', JSON.stringify(envList('OWNER_NUMBERS')));
line('PAIRING_NUMBER', String(process.env.PAIRING_NUMBER || '—'));

console.log('\n💡 Depois de editar o .env, reinicie o bot (./bot.sh start) e confira com .pools no WhatsApp.\n');
