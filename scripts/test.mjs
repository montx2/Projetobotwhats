// Run every test file sequentially with a fresh runtime state directory.
// Several modules persist config/cache files at import time, so each test file
// gets its own process and data root instead of touching the user's `data/`.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = path.join(root, 'tests');
const files = fs.readdirSync(testsDir)
  .filter((file) => file.endsWith('.test.mjs'))
  .sort();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'montxbot-tests-'));
let failed = false;

try {
  for (const file of files) {
    const dataDir = path.join(tempRoot, path.basename(file, '.test.mjs'));
    fs.mkdirSync(dataDir, { recursive: true });
    console.log(`\n▶ ${file}\n`);
    const testEnv = {
      ...process.env,
      NEXUS_TEST_MODE: '1',
      NEXUS_DATA_DIR: dataDir,
      NEXUS_ENV_FILE: path.join(tempRoot, 'no-test-secrets.env'),
      NEXUS_ENABLE_YTDLP: 'false',
      NEXUS_DISABLE_YTDLP: 'true'
    };
    for (const key of [
      'OWNER_NUMBERS', 'PAIRING_NUMBER', 'REMOVE_BG_KEYS', 'REMOVE_BG_URLS', 'REMOVE_BG_API_KEY',
      'REMOVE_BG_API_KEYS', 'LOCAL_REMBG', 'GEMINI_KEYS', 'GEMINI_API_KEY', 'OPENAI_KEYS',
      'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'GROQ_KEYS', 'GROQ_API_KEY', 'AI_BASE_URL', 'AI_KEYS',
      'AI_MODEL', 'POLLINATIONS_KEYS', 'POLLINATIONS_API_KEY', 'POLLINATIONS_KEY',
      'GROQ_API_KEYS', 'GROQ_KEY', 'GROQ_KEY_1', 'GROQ_KEY_2', 'GROQ_KEY_3',
      'GROQ_MODELS', 'GEMINI_MODELS', 'OPENAI_MODELS', 'AI_MODELS', 'AI_API_KEYS', 'AI_API_KEY',
      'OPENROUTER_API_KEY', 'COBALT_INSTANCES', 'COBALT_API_KEY', 'COBALT_AUTO_DISCOVER',
      'COBALT_DISCOVER_INTERVAL_H', 'TIKTOK_API', 'YTDLP_PATH',
      'WA_VERSION_OVERRIDE'
    ]) delete testEnv[key];
    const result = spawnSync(process.execPath, ['--test', path.join('tests', file)], {
      cwd: root,
      env: testEnv,
      stdio: 'inherit'
    });
    if (result.error) {
      console.error(result.error);
      failed = true;
    } else if (result.status !== 0) {
      failed = true;
    }
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

process.exitCode = failed ? 1 : 0;
