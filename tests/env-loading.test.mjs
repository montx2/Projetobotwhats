// 🧪 Testes do carregamento do .env — a regressão do bug
// "meu remove.bg não funciona mesmo com a API certa".
//
// O bug: em ESM os `import` rodam antes do corpo do arquivo, então o main.js
// antigo executava loadDotEnv() DEPOIS de src/core/config.js montar o objeto
// ENV. Resultado: ENV sem nenhuma chave, .env ignorado, remove.bg/IA/Cobalt
// sempre "sem chaves". Estes testes garantem que isso nunca volte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDotEnv, loadDotEnv, envList, envBool } from '../src/core/env.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function tempEnv(content) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-env-')), '.env');
  fs.writeFileSync(file, content);
  return file;
}

test('parseDotEnv: comentários, aspas, export, BOM e CRLF', () => {
  const pairs = parseDotEnv(
    '\uFEFF# comentário\r\nREMOVE_BG_KEYS=abc123,def456\r\nexport GEMINI_KEYS="gk-1 gk-2"\r\n' +
      "OPENAI_KEYS='sk-1'\r\n\r\nLOCAL_REMBG=true\r\n#REMOVE_BG_URLS=https://ignorada\r\n"
  );
  const map = Object.fromEntries(pairs);
  assert.equal(map.REMOVE_BG_KEYS, 'abc123,def456');
  assert.equal(map.GEMINI_KEYS, 'gk-1 gk-2');
  assert.equal(map.OPENAI_KEYS, 'sk-1');
  assert.equal(map.LOCAL_REMBG, 'true');
  assert.equal(map.REMOVE_BG_URLS, undefined);
});

test('loadDotEnv: aplica no process.env, não sobrescreve valor real e preenche vazio', () => {
  const file = tempEnv(
    'NEXUS_TEST_A=do_arquivo\nNEXUS_TEST_B=do_arquivo\nNEXUS_TEST_C=ligado\n'
  );
  process.env.NEXUS_TEST_A = 'do_sistema'; // valor real: deve ganhar do .env
  process.env.NEXUS_TEST_B = ''; // vazio: o .env deve preencher (bug clássico de painel/export)
  delete process.env.NEXUS_TEST_C;

  const result = loadDotEnv(file);
  assert.equal(result.loaded, true);
  assert.equal(result.entries, 3);
  assert.equal(process.env.NEXUS_TEST_A, 'do_sistema');
  assert.equal(process.env.NEXUS_TEST_B, 'do_arquivo');
  assert.equal(process.env.NEXUS_TEST_C, 'ligado');
  assert.equal(envBool('NEXUS_TEST_C'), false); // não é boolean reconhecido
  assert.equal(envBool('NEXUS_TEST_UNSET_XYZ', true), true); // fallback sem variável
  assert.deepEqual(envList('NEXUS_TEST_A'), ['do_sistema']);

  delete process.env.NEXUS_TEST_A;
  delete process.env.NEXUS_TEST_B;
  delete process.env.NEXUS_TEST_C;
});

test('loadDotEnv: arquivo inexistente não quebra nada', () => {
  const result = loadDotEnv(path.join(os.tmpdir(), 'nexus-nao-existe-12345', '.env'));
  assert.equal(result.loaded, false);
  assert.equal(result.applied, 0);
});

test('REGRESSÃO: o ENV do bot (e o pool de remove.bg) enxerga o .env no import', () => {
  const file = tempEnv(
    'REMOVE_BG_KEYS=chave_teste_1,chave_teste_2\nLOCAL_REMBG=1\nGEMINI_KEYS=gk_teste\n'
  );
  const script =
    "import { ENV, envSummary } from './src/core/config.js';\n" +
    "import { bgPools, bgStatus } from './src/features/bgremoval.js';\n" +
    'const s = envSummary();\n' +
    'process.stdout.write(JSON.stringify({ keys: ENV.removeBgKeys, local: ENV.localRembg, gemini: ENV.geminiKeys, pool: bgPools().removebg.size, status: bgStatus()[0], envFile: s.file, envLoaded: s.loaded }));\n';

  // Limpa o que o processo do teste possa ter herdado (variável REAL do sistema
  // ganha do .env, por design) para provar que o arquivo apontado é lido.
  const childEnv = { ...process.env, NEXUS_ENV_FILE: file };
  for (const key of ['REMOVE_BG_KEYS', 'LOCAL_REMBG', 'GEMINI_KEYS']) delete childEnv[key];

  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    env: childEnv,
    encoding: 'utf8'
  });
  assert.equal(child.status, 0, child.stderr);
  const out = JSON.parse(child.stdout);

  // Sem a correção do carregamento, tudo isto vinha vazio (era o bug relatado).
  assert.deepEqual(out.keys, ['chave_teste_1', 'chave_teste_2']);
  assert.equal(out.local, true);
  assert.deepEqual(out.gemini, ['gk_teste']);
  assert.equal(out.pool, 2);
  assert.match(out.status, /remove\.bg: 2\/2/);
  assert.equal(out.envFile, file);
  assert.equal(out.envLoaded, true);
});
