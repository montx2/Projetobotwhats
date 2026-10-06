// 🔎 Sonda do ComedyHub — diagnostica o download de um meme passo a passo.
//
// Uso:
//   node scripts/comedyhub-probe.mjs https://thecomedyhub.com.br/meme/<id>
//   npm run comedyhub -- https://thecomedyhub.com.br/meme/<id>
//
// O que ele faz, na ordem:
//   1) confere se a API do site responde (rota pública de métricas);
//   2) mostra se existe sessão (token do .env ou salvo pelo .chlogin);
//   3) sem sessão: tenta login com COMEDYHUB_LOGIN/COMEDYHUB_PASSWORD, se houver;
//   4) lê o JSON do post e LISTA todos os candidatos de mídia que encontrou;
//   5) sonda cada candidato (tipo real servido, tamanho) e mostra o escolhido;
//   6) baixa o começo do arquivo e confere a assinatura dos bytes (foto × vídeo).
//
// Nada é enviado para lugar nenhum: é só diagnóstico local. Rode no Termux/PC
// onde o bot está instalado.

import { createHash } from 'node:crypto';
import { httpGet, fetchBuffer, formatBytes, shortUrl } from '../src/core/http.js';
import { comedyHubSession, comedyHubLogin, comedyHubMediaCandidates, comedyHubPostId } from '../src/features/downloaders/comedyhub.js';
import { probeStream } from '../src/features/downloaders/media.js';

const link = process.argv[2] || '';
const line = (label, value = '') => console.log(`  ${String(label).padEnd(26)} ${value}`);
const ok = (message) => console.log(`✅ ${message}`);
const warn = (message) => console.log(`⚠️  ${message}`);
const bad = (message) => console.log(`❌ ${message}`);

console.log('\n🔎 SONDA COMEDYHUB\n');

const id = comedyHubPostId(link);
line('Link recebido', link || '(nenhum)');
line('ID do meme', id || '— não reconhecido —');
if (!id) {
  bad('Passe um link no formato https://thecomedyhub.com.br/meme/<uuid>');
  process.exitCode = 1;
  process.exit(1);
}

/* 1) API no ar? */
console.log('\n── 1. API do ComedyHub ──');
try {
  const res = await httpGet('https://api.thecomedyhub.com.br/api/v2/metrics/json', { json: true, timeoutMs: 20_000 });
  if (res.ok && res.data?.data?.totals) {
    const totals = res.data.data.totals;
    ok(`API respondeu (${totals.totalPosts} posts publicados no site)`);
  } else {
    bad(`API respondeu HTTP ${res.status} — ${String(res.text || '').slice(0, 120)}`);
  }
} catch (error) {
  bad(`não alcancei a API: ${String(error?.message || error).slice(0, 140)}`);
  warn('confira a internet/DNS deste aparelho antes de culpar o bot');
}

/* 2) Sessão */
console.log('\n── 2. Sessão (token) ──');
let session = comedyHubSession();
if (session?.token) {
  line('Origem', session.source);
  line('Conta', session.user || '(não informada)');
  line('Token', `${session.token.slice(0, 12)}…`);
  line('Vencido?', session.expired ? `sim ${warn('')}` : 'não');
} else {
  warn('sem token salvo — o site só libera o meme com login');
}

/* 3) Login automático (opcional) */
if (!session?.token || session.expired) {
  const login = process.env.COMEDYHUB_LOGIN || process.env.COMEDYHUB_EMAIL || '';
  const password = process.env.COMEDYHUB_PASSWORD || '';
  if (login && password) {
    console.log('\n── 3. Login automático (.env) ──');
    try {
      const out = await comedyHubLogin(login, password);
      ok(`login aceito em ${out.endpoint}`);
      session = comedyHubSession();
    } catch (error) {
      bad(String(error?.message || error).slice(0, 300));
    }
  } else {
    warn('sem COMEDYHUB_LOGIN/COMEDYHUB_PASSWORD no .env (opcional)');
  }
}

if (!session?.token || session.expired) {
  console.log('\nPara conectar, escolha um caminho no WhatsApp do bot:');
  console.log('  .chlogin seu@email.com suasenha      (pega o token e não salva a senha)');
  console.log('  .chtoken eyJhbGciOi...               (token copiado do site)');
  console.log('  ou defina COMEDYHUB_TOKEN no .env');
  process.exitCode = 1;
  process.exit(1);
}

/* 4) JSON do post */
console.log('\n── 4. Dados do post na API ──');
let post = null;
const paths = ['/memes/{id}', '/posts/{id}', '/memes/id/{id}', '/chubs/{id}'];
for (const path of paths) {
  const url = `https://api.thecomedyhub.com.br/api/v2${path.replace('{id}', id)}`;
  try {
    const res = await httpGet(url, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${session.token}`,
        origin: 'https://thecomedyhub.com.br',
        referer: 'https://thecomedyhub.com.br/app/feed/recents'
      },
      json: true,
      timeoutMs: 25_000
    });
    line(path, `HTTP ${res.status}`);
    if (res.ok && res.data) {
      const data = res.data.data || res.data.meme || res.data.post || res.data;
      if (data && typeof data === 'object' && !post) {
        post = data;
        ok(`post lido por ${path}`);
        break;
      }
    } else if (res.status === 401 || res.status === 498) {
      bad(`sessão recusada (HTTP ${res.status}) — faça .chlogin de novo`);
      process.exitCode = 1;
      process.exit(1);
    }
  } catch (error) {
    line(path, String(error?.message || error).slice(0, 90));
  }
}

if (!post) {
  bad('não consegui ler o post — o meme pode ter sido apagado ou está em moderação');
  process.exitCode = 1;
  process.exit(1);
}

console.log('\n  Campos principais do post:');
for (const key of ['id', 'title', 'type', 'status', 'downloadUrl', 'contentUrl', 'thumbnailUrl', 'downloadExtension', 'width', 'height']) {
  if (post[key] !== undefined) line(key, String(post[key]).slice(0, 110));
}

/* 5) Candidatos */
console.log('\n── 5. Candidatos de mídia (do melhor para o pior) ──');
const candidates = comedyHubMediaCandidates(post);
if (!candidates.length) {
  bad('o post não devolveu nenhum arquivo de mídia utilizável');
  process.exitCode = 1;
  process.exit(1);
}
for (const [index, candidate] of candidates.entries()) {
  line(`${index + 1}. ${candidate.label}`, `${candidate.kind} · ${shortUrl(candidate.url)}`);
}

const expected = candidates[0].kind === 'image' || candidates[0].kind === 'gif' ? 'image' : 'video';
console.log(`\n  Sondando com expectativa de ${expected}…`);
let chosen = null;
for (const candidate of candidates) {
  const probe = await probeStream(candidate.url, { expect: expected, timeoutMs: 15_000, referer: 'https://thecomedyhub.com.br/' });
  const size = probe.sizeBytes ? ` · ${formatBytes(probe.sizeBytes)}` : '';
  line(`• ${candidate.label}`, `${probe.verdict}${probe.contentType ? ` · ${probe.contentType}` : ''}${size}`);
  if (probe.verdict === 'ok' && !chosen) chosen = candidate;
}
if (!chosen) {
  warn('nenhum candidato passou na sonda — pode ser bloqueio de rede ou meme removido do storage');
  chosen = candidates[0];
}

/* 6) Baixa o começo e confere os bytes */
console.log('\n── 6. Download de teste (primeiros KB) ──');
try {
  const buffer = await fetchBuffer(chosen.url, {
    maxBytes: 256 * 1024,
    timeoutMs: 60_000,
    headers: {
      referer: 'https://thecomedyhub.com.br/',
      ...(chosen.url.includes('thecomedyhub.com.br') ? { authorization: `Bearer ${session.token}` } : {})
    }
  });
  const head = buffer.subarray(0, 16);
  const isJpeg = head[0] === 0xff && head[1] === 0xd8;
  const isPng = head[0] === 0x89 && head.toString('ascii', 1, 4) === 'PNG';
  const isWebp = head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP';
  const isMp4 = head.toString('ascii', 4, 8) === 'ftyp';
  const isWebm = head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  const formas = [isJpeg && 'JPEG', isPng && 'PNG', isWebp && 'WebP', isMp4 && 'MP4', isWebm && 'WebM'].filter(Boolean);
  ok(`baixei ${formatBytes(buffer.length)} de ${shortUrl(chosen.url)}`);
  line('Assinatura', formas.join(' · ') || `desconhecida (${head.toString('hex').slice(0, 24)})`);
  line('sha256 (parcial)', createHash('sha256').update(buffer).digest('hex').slice(0, 16));
  if (expected === 'video' && (isJpeg || isPng || isWebp)) {
    warn('veio uma IMAGEM quando o post é vídeo — mande esta saída para o dono do bot');
  } else if (expected === 'video' && (isMp4 || isWebm)) {
    ok('é vídeo de verdade: o download do bot vai funcionar');
  } else if (expected === 'image' && (isJpeg || isPng || isWebp)) {
    ok('é imagem de verdade: o download do bot vai funcionar');
  }
} catch (error) {
  bad(`falhou ao baixar: ${String(error?.message || error).slice(0, 200)}`);
  process.exitCode = 1;
}

console.log('\nFim da sonda. Se algo falhou, copie esta saída inteira e mande no chat.\n');
