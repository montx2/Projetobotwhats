// 🧪 Testes da remoção de fundo com um provedor de mentira (endpoint local).
//
// Cobrem o caminho que estava quebrado de ponta a ponta:
//   .env (REMOVE_BG_URLS) → ENV → pool → HTTP multipart → PNG de volta.
// Nenhuma chamada para a internet: o "provedor" é um servidor local.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Isola os testes do .env real do projeto: nada de gastar suas chaves de verdade
// nem chamar a API do remove.bg sem querer durante o `npm test`.
process.env.NEXUS_ENV_FILE = path.join(os.tmpdir(), 'nexus-teste-sem-env', '.env');
for (const key of ['REMOVE_BG_KEYS', 'REMOVE_BG_URLS', 'LOCAL_REMBG']) {
  delete process.env[key];
}

// PNG 1×1 real (base64) — é o que o provedor devolve nos testes.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// ── provedor de mentira ────────────────────────────────────────────────────
let base = '';
const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ method: req.method, url: req.url, contentType: req.headers['content-type'] || '', bytes: 0 });
  let bytes = 0;
  req.on('data', (chunk) => {
    bytes += chunk.length;
    seen[seen.length - 1].bytes = bytes;
  });
  req.on('end', () => {
    if (req.url === '/result.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }
    if (req.url === '/removebg-json') {
      // alguns provedores devolvem JSON com a URL do resultado
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ result: `${base}/result.png` }));
    }
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
base = `http://127.0.0.1:${server.address().port}`;

process.env.REMOVE_BG_URLS = `${base}/removebg`; // equivale a preencher no .env
const { removeBackground, bgPools } = await import('../src/features/bgremoval.js');

test('removeBackground usa o provedor do .env (REMOVE_BG_URLS) e devolve o PNG', async () => {
  const { buffer, via } = await removeBackground(PNG);
  assert.equal(via, 'endpoint');
  assert.ok(buffer.equals(PNG), 'devolveu os bytes do provedor');

  const req = seen.find((s) => s.url === '/removebg');
  assert.ok(req, 'o provedor foi chamado');
  assert.equal(req.method, 'POST');
  assert.match(req.contentType, /multipart\/form-data/);
  assert.ok(req.bytes > 100, 'enviou a imagem no corpo multipart');
});

test('provedor que devolve JSON com a URL do resultado também funciona', async () => {
  // O pool é montado na inicialização (igual ao bot de verdade: mudou o .env,
  // reinicie). Aqui apontamos na mão para o endpoint que responde JSON.
  bgPools().endpoints.items = [`${base}/removebg-json`];
  const { buffer, via } = await removeBackground(PNG);
  assert.equal(via, 'endpoint');
  assert.ok(buffer.equals(PNG));
});

test('sem provedor configurado, o erro diz ONDE o bot procurou o .env', () => {
  const script =
    "import { removeBackground } from './src/features/bgremoval.js';\n" +
    'try { await removeBackground(Buffer.from([0x89, 0x50, 0x4e, 0x47])); }\n' +
    'catch (e) { process.stdout.write(String(e.message)); }\n';
  const env = { ...process.env, NEXUS_ENV_FILE: '/tmp/nexus-inexistente/.env' };
  for (const key of ['REMOVE_BG_KEYS', 'REMOVE_BG_URLS', 'LOCAL_REMBG']) delete env[key];

  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    env,
    encoding: 'utf8'
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Nenhum provedor de remoção de fundo configurado/);
  assert.match(child.stdout, /REMOVE_BG_KEYS/);
  assert.match(child.stdout, /\.env/);
  assert.match(child.stdout, /REINICIE/);
});

test.after(() => server.close());
