// 🧪 Testes offline da descoberta automática de instâncias Cobalt.
//
// Tudo roda com fetch mockado (nenhuma rede): a lista pública simulada usa o
// formato REAL de instances.cobalt.best/instances.json e de
// cobalt.directory/api/working, e cada instância candidata responde como a API
// do cobalt de verdade (GET / com objeto cobalt + POST com error.api.*).
//
// Cobre: descoberta feliz, queda das fontes (→ cache → padrão), descarte de
// Turnstile, expiração/revalidação do cache, modo manual, recuperação
// emergencial quando o pool inteiro entra em cooldown, sanitização do cache,
// corrida entre descobertas simultâneas e a mensagem de erro clara para o
// usuário quando a instância exige verificação de navegador.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setDnsLookupForTests } from '../src/core/http.js';
import { writeJsonNow, DATA_DIR } from '../src/core/store.js';
import { KeyPool } from '../src/core/keypool.js';
import {
  DEFAULT_INSTANCES,
  COBALT_CACHE_FILE,
  CobaltInstanceManager,
  cobaltManager,
  resolveInitialCobaltInstances,
  readCobaltCache,
  checkInstanceHealth,
  toInstanceUrl,
  versionMajor
} from '../src/features/downloaders/cobalt-instances.js';
import { cobaltDownload, cobaltPool } from '../src/features/downloaders/cobalt.js';

setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);

const cachePath = () => path.join(DATA_DIR, COBALT_CACHE_FILE);
const cleanCache = () => fs.rmSync(cachePath(), { force: true });

/* ───────────────────────── mock de fetch ───────────────────────── */

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

/** Mesma Response pode ser devolvida várias vezes: o corpo é clonado por uso. */
async function freshResponse(response) {
  const body = response.body ? await response.clone().arrayBuffer() : null;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

/**
 * Substitui o fetch global por um roteador [matcher, resposta]; registra TODAS
 * as chamadas em `calls` (url + método) para os testes inspecionarem.
 */
function mockFetch(routes, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: String(opts?.method || 'GET').toUpperCase() });
    for (const [matcher, responder] of routes) {
      const hit = typeof matcher === 'string' ? u.includes(matcher) : matcher.test(u);
      if (hit) {
        const res = typeof responder === 'function' ? responder(u, opts) : responder;
        const response = res ?? jsonResponse({});
        return response instanceof Response ? freshResponse(response) : response;
      }
    }
    return jsonResponse({}, { status: 404 });
  };
  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => {
      globalThis.fetch = original;
    });
}

/** Instância candidata que responde como a API cobalt de verdade. */
function healthyInstance({
  version = '11.7.1',
  turnstileKey = '',
  postStatus = 400,
  postCode = 'error.api.link.missing'
} = {}) {
  return (url, opts) => {
    if (String(opts?.method || 'GET').toUpperCase() === 'POST') {
      return jsonResponse({ status: 'error', error: { code: postCode } }, { status: postStatus });
    }
    return jsonResponse({
      cobalt: {
        version,
        url,
        startTime: '1750000000000',
        services: ['youtube', 'tiktok'],
        ...(turnstileKey ? { turnstileSitekey: turnstileKey } : {})
      },
      git: { commit: 'abc123', branch: 'main', remote: 'imputnet/cobalt' }
    });
  };
}

/** Entrada no formato de instances.cobalt.best/instances.json. */
function kwiatEntry(api, { score = 50, version = '11.7.1', online = true, protocol = 'https', auth = false } = {}) {
  return { api, frontend: null, protocol, online, version, score, status: 'good', services: {}, info: { auth, cors: true } };
}

function freshManager(pool, { origin = 'cache', instances, updatedAt = Date.now() } = {}) {
  const manager = new CobaltInstanceManager({ testMode: false });
  manager.attach(pool, { instances: instances || (pool ? [...pool.items] : []), origin, updatedAt });
  return manager;
}

/* ───────────────────────── validação de URL/versão ───────────────────────── */

test('toInstanceUrl só aceita https público na raiz do domínio', () => {
  assert.equal(toInstanceUrl('capi.3kh0.net'), 'https://capi.3kh0.net');
  assert.equal(toInstanceUrl('https://ok.example'), 'https://ok.example');
  assert.equal(toInstanceUrl('https://ok.example/'), 'https://ok.example');
  assert.equal(toInstanceUrl('ok.example', 'https'), 'https://ok.example');
  // http, credenciais, caminho, query, hosts locais e IPs privados: nunca
  assert.equal(toInstanceUrl('http://ok.example'), null);
  assert.equal(toInstanceUrl('ok.example', 'http'), null);
  assert.equal(toInstanceUrl('https://user:senha@ok.example'), null);
  assert.equal(toInstanceUrl('https://ok.example/api'), null);
  assert.equal(toInstanceUrl('https://ok.example/?x=1'), null);
  assert.equal(toInstanceUrl('https://localhost'), null);
  assert.equal(toInstanceUrl('https://rede.local'), null);
  assert.equal(toInstanceUrl('https://192.168.0.10'), null);
  assert.equal(toInstanceUrl('https://10.0.0.5'), null);
  assert.equal(toInstanceUrl('https://127.0.0.1'), null);
  assert.equal(toInstanceUrl(''), null);
  assert.equal(toInstanceUrl('sem-ponto'), null);
});

test('versionMajor lê o major da versão do cobalt', () => {
  assert.equal(versionMajor('10.9.4'), 10);
  assert.equal(versionMajor('11.7.1'), 11);
  assert.equal(versionMajor('v11.2.3'), 11);
  assert.equal(versionMajor('7.15'), 7);
  assert.equal(versionMajor('unknown'), null);
  assert.equal(versionMajor('-1'), null);
  assert.equal(versionMajor(''), null);
});

/* ───────────────────────── classificação de saúde ───────────────────────── */

test('checkInstanceHealth classifica ok, turnstile, auth, rate, morta e inválida', async () => {
  await mockFetch(
    [
      ['saudavel.example', healthyInstance()],
      ['cf.example', healthyInstance({ turnstileKey: '0x4AAAAAAAfim' })],
      ['comchave.example', healthyInstance({ postStatus: 401, postCode: 'error.api.auth.key.missing' })],
      ['limitada.example', healthyInstance({ postStatus: 429, postCode: 'error.api.rate_exceeded' })],
      ['noar.example', healthyInstance({ postStatus: 500, postCode: 'error.api.generic' })],
      [
        'html.example',
        (url, opts) =>
          opts?.method === 'POST'
            ? jsonResponse({ status: 'error', error: { code: 'error.api.link.missing' } }, { status: 400 })
            : new Response('<html>just a moment...</html>', { status: 200, headers: { 'content-type': 'text/html' } })
      ],
      ['velha.example', healthyInstance({ version: '9.9.9' })]
    ],
    async () => {
      assert.equal((await checkInstanceHealth('https://saudavel.example')).status, 'ok');
      assert.equal((await checkInstanceHealth('https://cf.example')).status, 'turnstile');
      assert.equal((await checkInstanceHealth('https://comchave.example')).status, 'auth');
      assert.equal((await checkInstanceHealth('https://limitada.example')).status, 'rate');
      assert.equal((await checkInstanceHealth('https://noar.example')).status, 'dead');
      assert.equal((await checkInstanceHealth('https://html.example')).status, 'invalid');
      assert.equal((await checkInstanceHealth('https://velha.example')).status, 'invalid');
    }
  );
});

test('checkInstanceHealth também detecta Turnstile no POST (401 jwt)', async () => {
  await mockFetch(
    [
      ['jwt.example', healthyInstance({ postStatus: 401, postCode: 'error.api.auth.jwt.missing' })]
    ],
    async () => {
      const result = await checkInstanceHealth('https://jwt.example');
      assert.equal(result.status, 'turnstile');
      assert.equal(result.reason, 'error.api.auth.jwt.missing');
    }
  );
});

/* ───────────────────────── descoberta ───────────────────────── */

test('descoberta: lista pública → verificação real → pool atualizado + cache gravado', async () => {
  cleanCache();
  await mockFetch(
    [
      [
        'instances.cobalt.best',
        () =>
          jsonResponse([
            kwiatEntry('ts.example', { score: 95 }),                                  // Turnstile no GET /
            kwiatEntry('boa-a.example', { score: 90 }),                               // ok
            kwiatEntry('boa-b.example', { score: 80, version: '10.9.4' }),            // ok
            kwiatEntry('rateada.example', { score: 30 }),                             // viva, mas 429
            kwiatEntry('offline.example', { score: 99, online: false }),              // fora do ar
            kwiatEntry('antiga.example', { score: 70, version: '7.15' }),             // versão < 10
            kwiatEntry('insegura.example', { score: 98, protocol: 'http' }),          // http: nunca
            kwiatEntry('comauth.example', { score: 97, auth: true })                  // auth obrigatória
          ])
      ],
      ['ts.example', healthyInstance({ turnstileKey: '0x4CHAVE' })],
      ['boa-a.example', healthyInstance()],
      ['boa-b.example', healthyInstance({ version: '10.9.4' })],
      ['rateada.example', healthyInstance({ postStatus: 429, postCode: 'error.api.rate_exceeded' })]
    ],
    async (calls) => {
      const pool = new KeyPool('cobalt', DEFAULT_INSTANCES, { cooldownMs: 1000 });
      const manager = freshManager(pool);
      try {
        const result = await manager.refresh({ reason: 'teste' });

        assert.equal(result.source, 'instances.cobalt.best');
        assert.equal(result.counts.ok, 2);
        assert.equal(result.counts.turnstile, 1);
        assert.equal(result.counts.rate, 1);

        // ok primeiro (por score), rate-limitada por último; 3 >= piso → substitui
        assert.deepEqual(pool.items, [
          'https://boa-a.example',
          'https://boa-b.example',
          'https://rateada.example'
        ]);

        // a verificação foi DE VERDADE: POST de teste em cada candidata viva
        assert.equal(calls.filter((c) => c.url.includes('boa-a.example') && c.method === 'POST').length, 1);
        // Turnstile detectada já no GET /: nem gasta POST
        assert.equal(calls.filter((c) => c.url.includes('ts.example') && c.method === 'POST').length, 0);
        // filtradas na lista nem chegaram a ser verificadas
        assert.equal(calls.some((c) => c.url.includes('offline.example')), false);
        assert.equal(calls.some((c) => c.url.includes('antiga.example')), false);
        assert.equal(calls.some((c) => c.url.includes('insegura.example')), false);
        assert.equal(calls.some((c) => c.url.includes('comauth.example')), false);

        // cache persistido para o próximo boot
        const cache = readCobaltCache();
        assert.deepEqual(cache.instances, pool.items);
        assert.ok(cache.updatedAt > Date.now() - 60_000, 'timestamp da descoberta');
        assert.equal(manager.status().origin, 'discovery');
      } finally {
        manager.stop();
      }
    }
  );
  cleanCache();
});

test('descoberta: fonte secundária cobalt.directory assume quando a primária cai', async () => {
  cleanCache();
  await mockFetch(
    [
      ['instances.cobalt.best', () => jsonResponse({}, { status: 500 })],
      [
        'cobalt.directory/api/working',
        () =>
          jsonResponse({
            lastUpdatedUTC: new Date().toISOString(),
            data: {
              youtube: ['https://dir-a.example', 'https://dir-b.example'],
              tiktok: ['https://dir-a.example'],
              instagram: []
            }
          })
      ],
      ['dir-a.example', healthyInstance()],
      ['dir-b.example', healthyInstance()]
    ],
    async () => {
      const pool = new KeyPool('cobalt', ['https://reserva.example'], { cooldownMs: 1000 });
      const manager = freshManager(pool);
      try {
        const result = await manager.refresh();
        assert.equal(result.source, 'cobalt.directory');
        // dir-a atende 2 serviços (score maior) → primeira da lista
        assert.equal(pool.items[0], 'https://dir-a.example');
        assert.equal(pool.items[1], 'https://dir-b.example');
        // só 2 adotadas: mescla em vez de descartar a reserva que já existia
        assert.ok(pool.items.includes('https://reserva.example'));
      } finally {
        manager.stop();
      }
    }
  );
  cleanCache();
});

test('listas públicas fora do ar → cache segue valendo e o pool não fica vazio', async () => {
  cleanCache();
  writeJsonNow(COBALT_CACHE_FILE, {
    instances: ['https://emcache.example'],
    updatedAt: Date.now(),
    origin: 'discovery'
  });
  try {
    const initial = resolveInitialCobaltInstances();
    assert.equal(initial.origin, 'cache');
    assert.deepEqual(initial.instances, ['https://emcache.example']);

    const pool = new KeyPool('cobalt', initial.instances, { cooldownMs: 1000 });
    const manager = freshManager(pool, { origin: 'cache', instances: initial.instances, updatedAt: initial.updatedAt });
    try {
      await mockFetch(
        [
          ['instances.cobalt.best', () => jsonResponse({}, { status: 503 })],
          ['cobalt.directory', () => { throw new Error('fetch failed'); }]
        ],
        async () => {
          await assert.rejects(() => manager.refresh(), /nenhuma fonte/i);
          // pool intacto, cache intacto: nada é descartado por causa da falha
          assert.deepEqual(pool.items, ['https://emcache.example']);
          assert.deepEqual(readCobaltCache().instances, ['https://emcache.example']);
        }
      );
    } finally {
      manager.stop();
    }
  } finally {
    cleanCache();
  }
});

test('sem cache e sem manual → DEFAULT_INSTANCES como último recurso', () => {
  cleanCache();
  try {
    const initial = resolveInitialCobaltInstances();
    assert.equal(initial.origin, 'default');
    assert.deepEqual(initial.instances, DEFAULT_INSTANCES);
    assert.ok(DEFAULT_INSTANCES.length >= 5, 'o bot nunca pode ficar sem pool');
  } finally {
    cleanCache();
  }
});

test('cache adulterado é saneado na leitura (só https público na raiz)', () => {
  cleanCache();
  writeJsonNow(COBALT_CACHE_FILE, {
    instances: ['https://boa.example', 'http://ruim.example', 'https://com.caminho/api', 'lixo total', ''],
    updatedAt: 123
  });
  try {
    const cache = readCobaltCache();
    assert.deepEqual(cache.instances, ['https://boa.example']);
    assert.equal(cache.updatedAt, 123);
  } finally {
    cleanCache();
  }
});

/* ───────────────────────── revalidação ───────────────────────── */

test('cache vencido dispara revalidação na inicialização e adota a lista nova', async () => {
  cleanCache();
  writeJsonNow(COBALT_CACHE_FILE, {
    instances: ['https://velha.example'],
    updatedAt: Date.now() - 13 * 3_600_000, // intervalo padrão: 12h → vencido
    origin: 'discovery'
  });
  try {
    const initial = resolveInitialCobaltInstances();
    assert.equal(initial.origin, 'cache');
    const pool = new KeyPool('cobalt', initial.instances, { cooldownMs: 1000 });
    const manager = new CobaltInstanceManager({ testMode: false });
    try {
      await mockFetch(
        [
          [
            'instances.cobalt.best',
            () => jsonResponse([kwiatEntry('nova.example', { score: 70 })])
          ],
          ['nova.example', healthyInstance()]
        ],
        async () => {
          const bootRefresh = manager.attach(pool, initial);
          assert.ok(bootRefresh instanceof Promise, 'cache vencido → refresh no boot (em segundo plano)');
          await bootRefresh;
          // a nova entra na frente; com só 1 adotada, a velha segue de reserva
          assert.equal(pool.items[0], 'https://nova.example');
          assert.ok(pool.items.includes('https://velha.example'));
          const cache = readCobaltCache();
          assert.ok(cache.updatedAt > Date.now() - 60_000, 'cache regravado com timestamp novo');
          assert.equal(manager.status().origin, 'discovery');
        }
      );
    } finally {
      manager.stop();
    }
  } finally {
    cleanCache();
  }
});

test('cache fresco no boot: zero latência, sem descoberta imediata', async () => {
  cleanCache();
  writeJsonNow(COBALT_CACHE_FILE, {
    instances: ['https://fresca.example'],
    updatedAt: Date.now(),
    origin: 'discovery'
  });
  try {
    const pool = new KeyPool('cobalt', ['https://fresca.example'], { cooldownMs: 1000 });
    const manager = new CobaltInstanceManager({ testMode: false });
    try {
      await mockFetch([], async (calls) => {
        const bootRefresh = manager.attach(pool, { instances: ['https://fresca.example'], origin: 'cache', updatedAt: Date.now() });
        assert.equal(bootRefresh, null, 'cache fresco → nada a fazer no boot');
        assert.equal(manager.scheduled, true, 'revalidação periódica agendada');
        assert.equal(calls.length, 0, 'nenhuma rede');
      });
    } finally {
      manager.stop();
    }
  } finally {
    cleanCache();
  }
});

test('pool inteiro em cooldown → revalidação emergencial recupera sozinho', async () => {
  cleanCache();
  const pool = new KeyPool('cobalt', ['https://morta1.example', 'https://morta2.example'], {
    cooldownMs: 5 * 60_000
  });
  const manager = freshManager(pool);
  try {
    // todas em cooldown = o cenário em que o .dl parava de funcionar
    for (const item of pool.items) pool.reportFailure(item, { reason: 'falha geral simulada' });
    assert.equal(pool.available, 0);

    await mockFetch(
      [
        ['instances.cobalt.best', () => jsonResponse([kwiatEntry('renascida.example', { score: 70 })])],
        ['renascida.example', healthyInstance()]
      ],
      async () => {
        assert.equal(cobaltManager.onPoolExhausted(), false, 'singleton em modo teste nunca dispara rede');
        assert.equal(manager.onPoolExhausted(), true, 'dispara a revalidação emergencial');
        await manager.pendingRefresh();
        assert.equal(pool.items[0], 'https://renascida.example');
        assert.ok(pool.available >= 1, 'instância nova livre para uso imediatamente');
        // throttle: chamada imediata seguinte não repete a descoberta
        assert.equal(manager.onPoolExhausted(), false);
      }
    );
  } finally {
    manager.stop();
    cleanCache();
  }
});

test('descobertas simultâneas viram uma só (sem corrida, sem trabalho duplicado)', async () => {
  cleanCache();
  let listCalls = 0;
  await mockFetch(
    [
      [
        'instances.cobalt.best',
        () => {
          listCalls += 1;
          return jsonResponse([kwiatEntry('unica.example', { score: 50 })]);
        }
      ],
      ['unica.example', healthyInstance()]
    ],
    async () => {
      const pool = new KeyPool('cobalt', ['https://velha.example'], { cooldownMs: 1000 });
      const manager = freshManager(pool);
      try {
        const [a, b] = await Promise.all([manager.refresh(), manager.refresh()]);
        assert.equal(listCalls, 1, 'a lista pública foi lida UMA vez');
        assert.equal(a, b, 'as duas chamadas compartilharam a mesma promessa');
        assert.equal(pool.items[0], 'https://unica.example');
      } finally {
        manager.stop();
      }
    }
  );
  cleanCache();
});

test('attach agenda a revalidação periódica e stop() limpa o timer', () => {
  cleanCache();
  const manager = new CobaltInstanceManager({ testMode: false });
  try {
    const pool = new KeyPool('cobalt', ['https://x.example'], { cooldownMs: 1000 });
    manager.attach(pool, { instances: ['https://x.example'], origin: 'cache', updatedAt: Date.now() });
    assert.equal(manager.scheduled, true);
    assert.equal(manager.pendingRefresh(), null);
    manager.stop();
    assert.equal(manager.scheduled, false);
    assert.equal(manager.stopped, true);
  } finally {
    manager.stop();
    cleanCache();
  }
});

/* ───────────────────────── precedência e flags ───────────────────────── */

test('COBALT_INSTANCES manual tem prioridade absoluta: descoberta ignorada', async () => {
  cleanCache();
  process.env.COBALT_INSTANCES = 'https://minha.example, https://outra.example';
  try {
    const initial = resolveInitialCobaltInstances();
    assert.equal(initial.origin, 'manual');
    assert.deepEqual(initial.instances, ['https://minha.example', 'https://outra.example']);

    const pool = new KeyPool('cobalt', initial.instances, { cooldownMs: 1000 });
    const manager = new CobaltInstanceManager({ testMode: false });
    try {
      await mockFetch([], async (calls) => {
        assert.equal(manager.attach(pool, initial), null, 'modo manual não agenda nem descobre');
        assert.equal(manager.scheduled, false);
        assert.equal(manager.status().autoDiscover, false);
        assert.equal(manager.status().origin, 'manual');
        assert.deepEqual(await manager.refresh(), { skipped: true });
        assert.equal(calls.length, 0, 'modo manual = zero rede para descoberta');
        assert.equal(pool.size, 2, 'pool manual intacto');
      });
    } finally {
      manager.stop();
    }
  } finally {
    delete process.env.COBALT_INSTANCES;
    cleanCache();
  }
});

test('COBALT_AUTO_DISCOVER=false desliga a descoberta (cache/padrão seguem valendo)', async () => {
  cleanCache();
  process.env.COBALT_AUTO_DISCOVER = 'false';
  try {
    const pool = new KeyPool('cobalt', DEFAULT_INSTANCES, { cooldownMs: 1000 });
    const manager = new CobaltInstanceManager({ testMode: false });
    try {
      await mockFetch([], async (calls) => {
        assert.equal(
          manager.attach(pool, { instances: DEFAULT_INSTANCES, origin: 'default' }),
          null,
          'flag desligada: nem boot refresh'
        );
        assert.equal(manager.scheduled, false);
        assert.deepEqual(await manager.refresh(), { skipped: true });
        assert.equal(calls.length, 0);
        assert.deepEqual(pool.items, DEFAULT_INSTANCES, 'lista padrão intacta');
      });
    } finally {
      manager.stop();
    }
  } finally {
    delete process.env.COBALT_AUTO_DISCOVER;
    cleanCache();
  }
});

/* ───────────────────────── erro claro para o usuário ───────────────────────── */

test('cobaltDownload: instância com Turnstile → mensagem clara + cooldown longo', async () => {
  const pool = cobaltPool();
  const previous = { cooldowns: pool.cooldowns, stats: pool.stats, index: pool.index };
  pool.cooldowns = new Map();
  pool.stats = new Map();
  pool.index = 0;
  try {
    await mockFetch(
      [
        // TODAS as instâncias do pool recusam com o erro real de Turnstile
        [/./, () => jsonResponse({ status: 'error', error: { code: 'error.api.auth.jwt.missing' } }, { status: 401 })]
      ],
      async () => {
        await assert.rejects(
          () => cobaltDownload('https://www.tiktok.com/@a/video/1', 'melhor'),
          (error) => {
            assert.match(error.message, /verificação de navegador \(Turnstile\)/);
            assert.match(error.message, /COBALT_INSTANCES/);
            return true;
          }
        );
        // cada instância que recusou foi esfriada (não é mais tentada a cada 5 min)
        assert.equal(pool.available, 0);
      }
    );
  } finally {
    pool.cooldowns = previous.cooldowns;
    pool.stats = previous.stats;
    pool.index = previous.index;
  }
});
