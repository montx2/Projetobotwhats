// Testes da camada de redundância da IA: várias chaves do mesmo provedor +
// cascata de modelos (caso real: a Groq desligou llama-3.3-70b-versatile em
// 16/08/2026 e o modelo fixo passou a devolver 404 model_not_found).

import test from 'node:test';
import assert from 'node:assert/strict';

import { setDnsLookupForTests } from '../src/core/http.js';

setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);

const GROQ_HOST = 'api.groq.com';

/**
 * Importa o módulo de IA com um cache-buster: os pools são montados no import,
 * então cada teste precisa de uma instância nova com o .env já ajustado.
 */
let importTag = 0;
async function loadAi() {
  return import(`../src/features/ai.js?groqpool=${++importTag}`);
}

/** Substitui o fetch por um simulador da API da Groq. */
function mockGroq(responder) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname !== GROQ_HOST) throw new Error(`host inesperado: ${parsed.hostname}`);
    const body = init.body ? JSON.parse(init.body) : {};
    const key = String(init.headers?.authorization || '').replace(/^Bearer /, '');
    calls.push({ path: parsed.pathname, model: body.model, key });
    const result = responder(body, parsed, key) || {};
    return new Response(JSON.stringify(result.body ?? { choices: [{ message: { content: 'ok' } }] }), {
      status: result.status || 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  return {
    calls,
    /** Só as chamadas de chat (ignora o GET /models da descoberta). */
    chatCalls: () => calls.filter((c) => Boolean(c.model)),
    restore() {
      globalThis.fetch = originalFetch;
    }
  };
}

/** O 404 real da Groq para modelo descontinuado (mensagem ambígua). */
const notFound = (model) => ({
  status: 404,
  body: {
    error: {
      message: `The model ${model} does not exist or you do not have access to it.`,
      type: 'invalid_request_error',
      code: 'model_not_found'
    }
  }
});

/** 404 sem ambiguidade: o modelo saiu do ar para todo mundo. */
const decommissioned = (model) => ({
  status: 404,
  body: { error: { message: `The model ${model} has been decommissioned and is no longer available.` } }
});

function withEnv(vars, fn) {
  return async (t) => {
    const saved = new Map();
    for (const [name, value] of Object.entries(vars)) {
      saved.set(name, process.env[name]);
      process.env[name] = value;
    }
    try {
      await fn(t);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };
}

test(
  'várias chaves na mesma variável formam um pool e giram quando uma estoura o limite',
  withEnv({ GROQ_KEYS: 'gsk_primeira,gsk_segunda,gsk_terceira' }, async (t) => {
    const { aiChat, aiPoolSizes } = await loadAi();
    assert.equal(aiPoolSizes().groq, 3, 'as três chaves da mesma variável entram no pool');

    const mock = mockGroq((body, _parsed, key) => {
      if (key === 'gsk_primeira') return { status: 429, body: { error: { message: 'Rate limit reached for model' } } };
      return { body: { choices: [{ message: { content: `respondido por ${key}` } }] } };
    });
    t.after(() => mock.restore());

    const reply = await aiChat('pool-keys', 'oi');
    assert.match(reply, /respondido por gsk_(segunda|terceira)/);
    assert.equal(mock.calls.filter((c) => c.key === 'gsk_primeira').length, 1, 'a chave limitada é tentada e sai de cena');
  })
);

test('chaves avulsas (GROQ_API_KEY, GROQ_KEY_1, GROQ_KEY_2) também entram no pool', async () => {
  const { envListNumbered } = await import('../src/core/env.js');
  process.env.GROQ_KEY = 'gsk_avulsa';
  process.env.GROQ_API_KEY = 'gsk_antiga';
  process.env.GROQ_KEY_1 = 'gsk_numerada';
  process.env.GROQ_KEY_2 = 'gsk_numerada2';
  process.env.GROQ_KEYS = 'gsk_lista1,gsk_lista2';
  try {
    assert.deepEqual(envListNumbered('GROQ_KEYS', { aliases: ['GROQ_API_KEYS', 'GROQ_API_KEY', 'GROQ_KEY'] }), [
      'gsk_lista1',
      'gsk_lista2',
      'gsk_antiga',
      'gsk_avulsa',
      'gsk_numerada',
      'gsk_numerada2'
    ]);
  } finally {
    for (const name of ['GROQ_KEY', 'GROQ_API_KEY', 'GROQ_KEY_1', 'GROQ_KEY_2', 'GROQ_KEYS']) delete process.env[name];
  }
});

test(
  'modelo descontinuado (404) cai para o próximo modelo COM A MESMA CHAVE',
  withEnv({ GROQ_KEYS: 'gsk_unica', GROQ_MODELS: 'llama-3.3-70b-versatile,openai/gpt-oss-120b' }, async (t) => {
    const { aiChat } = await loadAi();
    const mock = mockGroq((body) => {
      if (body.model === 'llama-3.3-70b-versatile') return notFound(body.model);
      return { body: { choices: [{ message: { content: `ok via ${body.model}` } }] } };
    });
    t.after(() => mock.restore());

    const reply = await aiChat('model-fallback', 'oi');
    assert.equal(reply, 'ok via openai/gpt-oss-120b');
    assert.deepEqual(
      mock.calls.map((c) => c.model),
      ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'],
      'tenta o modelo morto e, sem trocar de chave, usa o próximo'
    );
  })
);

test(
  'modelo aposentado para todos não gasta as outras chaves nem esfria o pool',
  withEnv({ GROQ_KEYS: 'gsk_morta,gsk_boa', GROQ_MODELS: 'modelo-aposentado' }, async (t) => {
    const { aiChat, aiStatus } = await loadAi();
    const mock = mockGroq((body) => decommissioned(body.model));
    t.after(() => mock.restore());

    await assert.rejects(aiChat('model-dead', 'oi'), /nenhum modelo disponível|Todos os provedores de IA falharam/);
    assert.equal(mock.chatCalls().length, 1, 'erro que se repetiria em toda chave encerra o pool na hora');
    assert.ok(
      aiStatus().includes('groq: 2/2 chaves'),
      `modelo morto não é culpa da chave: ${JSON.stringify(aiStatus())}`
    );
  })
);

test(
  'com a mensagem ambígua da Groq, as outras chaves ainda são tentadas e o pool segue saudável',
  withEnv({ GROQ_KEYS: 'gsk_a,gsk_b', GROQ_MODELS: 'modelo-antigo' }, async (t) => {
    const { aiChat, aiStatus } = await loadAi();
    const mock = mockGroq((body) => notFound(body.model));
    t.after(() => mock.restore());

    await assert.rejects(aiChat('model-ambiguous', 'oi'), /Todos os provedores de IA falharam/);
    assert.deepEqual(mock.chatCalls().map((c) => c.key), ['gsk_a', 'gsk_b'], 'mensagem ambígua não descarta as outras chaves');
    assert.ok(aiStatus().includes('groq: 2/2 chaves'), '404 de modelo não coloca a chave em cooldown');
  })
);

test(
  'quando todos os modelos conhecidos morrem, o bot descobre os modelos do provedor em /models',
  withEnv({ GROQ_KEYS: 'gsk_unica', GROQ_MODELS: 'modelo-que-nao-existe' }, async (t) => {
    const { aiChat } = await loadAi();
    const mock = mockGroq((body, parsed) => {
      if (parsed.pathname.endsWith('/models')) {
        return {
          body: {
            data: [{ id: 'whisper-large-v3' }, { id: 'openai/gpt-oss-120b' }, { id: 'text-embedding-3-large' }]
          }
        };
      }
      if (body.model === 'openai/gpt-oss-120b') return { body: { choices: [{ message: { content: 'ok via descoberto' } }] } };
      return notFound(body.model);
    });
    t.after(() => mock.restore());

    const reply = await aiChat('model-discovery', 'oi');
    assert.equal(reply, 'ok via descoberto');
    const tried = mock.calls.filter((c) => c.model).map((c) => c.model);
    assert.ok(tried.includes('openai/gpt-oss-120b'), 'usa o modelo vivo descoberto');
    assert.ok(!tried.includes('whisper-large-v3'), 'ignora modelos que não são de chat');
  })
);

test(
  'modelo marcado como fora do ar é lembrado (não repete o 404 a cada mensagem)',
  withEnv({ GROQ_KEYS: 'gsk_unica', GROQ_MODELS: 'modelo-morto,modelo-vivo' }, async (t) => {
    const { aiChat } = await loadAi();
    const mock = mockGroq((body) => {
      if (body.model === 'modelo-morto') return notFound(body.model);
      return { body: { choices: [{ message: { content: 'ok' } }] } };
    });
    t.after(() => mock.restore());

    await aiChat('blocked-1', 'primeira mensagem');
    const primeira = mock.calls.map((c) => c.model);
    await aiChat('blocked-2', 'segunda mensagem');
    const segunda = mock.calls.map((c) => c.model);

    assert.deepEqual(primeira, ['modelo-morto', 'modelo-vivo']);
    assert.deepEqual(segunda, [...primeira, 'modelo-vivo'], 'na segunda mensagem o modelo morto já é pulado');
  })
);

test(
  'provedor sem nenhum modelo de pé é suspenso: não martela a API e volta com .pools reset',
  withEnv({ GROQ_KEYS: 'gsk_unica', GROQ_MODELS: 'modelo-aposentado' }, async (t) => {
    const { aiChat, aiModelStatus, resetAiPools } = await loadAi();
    const mock = mockGroq((body) => decommissioned(body.model));
    t.after(() => mock.restore());

    await assert.rejects(aiChat('suspend-1', 'oi'), /Todos os provedores de IA falharam/);
    const depoisDaPrimeira = mock.chatCalls().length;
    assert.equal(depoisDaPrimeira, 1);

    // Segunda mensagem: o provedor está suspenso, então nem chega a fazer HTTP.
    await assert.rejects(aiChat('suspend-2', 'oi'), /Todos os provedores de IA falharam/);
    assert.equal(mock.chatCalls().length, depoisDaPrimeira, 'não repete as chamadas enquanto estiver suspenso');
    assert.match(aiModelStatus().join(' '), /groq: ⏳ sem modelos de pé/, 'o .pools mostra a suspensão');

    const cleared = resetAiPools();
    assert.ok(cleared.models > 0, 'o reset libera os modelos marcados');
    assert.match(aiModelStatus().join(' '), /groq: modelo-aposentado/, 'depois do reset o modelo volta pra lista');
  })
);

test(
  'provedor que exige max_completion_tokens é detectado e o pedido é reenviado',
  withEnv({ GROQ_KEYS: 'gsk_unica', GROQ_MODELS: 'openai/gpt-oss-120b' }, async (t) => {
    const { aiChat } = await loadAi();
    const tokensUsados = [];
    const mock = mockGroq((body) => {
      if ('max_tokens' in body) {
        tokensUsados.push('max_tokens');
        return {
          status: 400,
          body: { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", code: 'unsupported_parameter' } }
        };
      }
      tokensUsados.push('max_completion_tokens');
      return { body: { choices: [{ message: { content: 'ok com max_completion_tokens' } }] } };
    });
    t.after(() => mock.restore());

    assert.equal(await aiChat('token-param', 'oi'), 'ok com max_completion_tokens');
    assert.deepEqual(tokensUsados, ['max_tokens', 'max_completion_tokens']);

    // Na mensagem seguinte já vai direto com o parâmetro novo.
    tokensUsados.length = 0;
    await aiChat('token-param-2', 'oi de novo');
    assert.deepEqual(tokensUsados, ['max_completion_tokens'], 'aprendeu o parâmetro do provedor');
  })
);

test('novas chaves podem entrar sem reiniciar o bot (.pools recarregar)', async (t) => {
  const fs = await import('node:fs');
  const { ENV_FILE } = await import('../src/core/env.js');
  const { aiPoolSizes, reloadAiPools } = await loadAi();

  const backup = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : null;
  try {
    fs.writeFileSync(ENV_FILE, 'GROQ_KEYS=gsk_uma\n');
    reloadAiPools();
    assert.equal(aiPoolSizes().groq, 1, 'começa com uma chave');

    // Operador cola mais duas chaves e manda recarregar.
    fs.writeFileSync(ENV_FILE, 'GROQ_KEYS=gsk_uma,gsk_duas,gsk_tres\nGROQ_MODELS=openai/gpt-oss-20b\n');
    const reloaded = reloadAiPools();
    assert.equal(reloaded.loaded, true);
    assert.equal(aiPoolSizes().groq, 3, 'as três chaves entram sem reiniciar o processo');
  } finally {
    if (backup === null) fs.rmSync(ENV_FILE, { force: true });
    else fs.writeFileSync(ENV_FILE, backup);
    for (const name of ['GROQ_KEYS', 'GROQ_MODELS']) delete process.env[name];
  }
});

test(
  'a lista padrão não depende de modelos já desligados pelos provedores',
  withEnv({ GROQ_KEYS: 'gsk_unica', GEMINI_KEYS: 'gemini-teste' }, async (t) => {
    const { aiModelStatus, resetAiPools } = await loadAi();
    resetAiPools();
    const rows = aiModelStatus().join(' | ');
    assert.doesNotMatch(rows, /gemini: gemini-2\.0-flash/, 'gemini-2.0-flash foi desligado em 01/06/2026');
    assert.match(rows, /groq: openai\/gpt-oss-120b/, 'o substituto oficial do llama-3.3-70b vem primeiro');
  })
);
