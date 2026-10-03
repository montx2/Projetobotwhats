import test from 'node:test';
import assert from 'node:assert/strict';

import { setDnsLookupForTests } from '../src/core/http.js';
import { aiChat, aiPoll, parseNaturalPollFallback, resetChatMemory, resetChatMemoryForChat } from '../src/features/ai.js';

setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);

test('memória da IA é isolada por remetente e pode ser apagada por chat', async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let replyNumber = 0;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    replyNumber++;
    return new Response(JSON.stringify({
      choices: [{ message: { content: `resposta-${replyNumber}` } }]
    }), { headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const alice = 'grupo@g.us:alice@s.whatsapp.net';
  const bob = 'grupo@g.us:bob@s.whatsapp.net';
  const aliceElsewhere = 'outro-grupo@g.us:alice@s.whatsapp.net';

  await aiChat(alice, 'segredo da Alice');
  const systemPrompt = requests[0].messages.find((message) => message.role === 'system')?.content || '';
  assert.match(systemPrompt, /padrão é tranquilo e sem gírias/i);
  assert.match(systemPrompt, /provocação claramente brincalhona/i);
  assert.match(systemPrompt, /não dê sermão nem use uma recusa automática/i);
  assert.match(systemPrompt, /no máximo um/i);
  assert.doesNotMatch(systemPrompt, /RESENHA TOTAL|foda pra caralho/i);
  await aiChat(bob, 'pergunta do Bob');
  await aiChat(aliceElsewhere, 'pergunta em outro grupo');
  await aiChat(alice, 'continuação da Alice');

  const aliceHistory = requests[3].messages.map((message) => message.content).join('\n');
  assert.match(aliceHistory, /segredo da Alice/);
  assert.doesNotMatch(aliceHistory, /pergunta do Bob|outro grupo/);

  resetChatMemoryForChat('grupo@g.us');
  await aiChat(alice, 'conversa nova');
  const clearedHistory = requests[4].messages.map((message) => message.content).join('\n');
  assert.doesNotMatch(clearedHistory, /segredo da Alice|continuação da Alice|resposta-4/);

  await aiChat(alice, 'outra memória');
  resetChatMemory(alice);
  await aiChat(alice, 'após reset');
  const resetHistory = requests[6].messages.map((message) => message.content).join('\n');
  assert.doesNotMatch(resetHistory, /outra memória|resposta-6/);
});

test('IA busca contexto gratuito de clima, câmbio e feriados apenas para pedidos explícitos', async (t) => {
  const originalFetch = globalThis.fetch;
  const aiRequests = [];
  const externalRequests = [];
  let responseNumber = 0;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'geocoding-api.open-meteo.com') {
      externalRequests.push(parsed.hostname);
      return new Response(JSON.stringify({
        results: [{ name: 'Weather Tool City', admin1: 'MG', country: 'Brasil', latitude: -19, longitude: -44, timezone: 'America/Sao_Paulo' }]
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (parsed.hostname === 'api.open-meteo.com') {
      externalRequests.push(parsed.hostname);
      return new Response(JSON.stringify({
        timezone: 'America/Sao_Paulo',
        current: { time: '2030-01-01T12:00', temperature_2m: 25, weather_code: 1, apparent_temperature: 26 },
        daily: { time: ['2030-01-01'], temperature_2m_min: [19], temperature_2m_max: [31], precipitation_probability_max: [12] }
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (parsed.hostname === 'api.frankfurter.dev') {
      externalRequests.push(parsed.hostname);
      return new Response(JSON.stringify({ date: '2030-01-01', base: 'EUR', quote: 'BRL', rate: 6.2 }), { headers: { 'content-type': 'application/json' } });
    }
    if (parsed.hostname === 'nagerholidays.com') {
      externalRequests.push(parsed.hostname);
      return new Response(JSON.stringify([
        { date: '2030-01-01', name: "New Year's Day", countryCode: 'PT', nationalHoliday: true, holidayTypes: ['Public'] }
      ]), { headers: { 'content-type': 'application/json' } });
    }
    if (parsed.hostname === 'text.pollinations.ai') {
      const body = JSON.parse(init.body);
      aiRequests.push(body);
      responseNumber++;
      return new Response(JSON.stringify({ choices: [{ message: { content: `resposta-${responseNumber}` } }] }), {
        headers: { 'content-type': 'application/json' }
      });
    }
    throw new Error(`host inesperado: ${parsed.hostname}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await aiChat('weather-memory', 'clima Weather Tool City');
  await aiChat('fx-memory', 'cotacao 10 EUR BRL');
  await aiChat('holiday-memory', 'feriados 2030 PT');
  await aiChat('plain-memory', 'qual é a capital do Japão?');

  const systemMessages = aiRequests.map((request) => request.messages.find((message) => message.role === 'system').content);
  assert.match(systemMessages[0], /Open-Meteo.*CC BY 4\.0/);
  assert.match(systemMessages[0], /25 °C/);
  assert.match(systemMessages[1], /Frankfurter\.dev/);
  assert.match(systemMessages[1], /6,20 BRL/);
  assert.match(systemMessages[2], /FERIADOS NACIONAIS CONSULTADOS/);
  assert.match(systemMessages[2], /2030-01-01/);
  assert.doesNotMatch(systemMessages[3], /Open-Meteo|Frankfurter|Nager\.Date/);
  assert.equal(externalRequests.filter((host) => host === 'geocoding-api.open-meteo.com').length, 1);
  assert.equal(externalRequests.filter((host) => host === 'api.open-meteo.com').length, 1);
  assert.equal(externalRequests.filter((host) => host === 'api.frankfurter.dev').length, 1);
  assert.equal(externalRequests.filter((host) => host === 'nagerholidays.com').length, 1);
});

test('IA falha de forma segura quando a API de clima não encontra a localidade', async (t) => {
  const originalFetch = globalThis.fetch;
  const requestedHosts = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    requestedHosts.push(parsed.hostname);
    if (parsed.hostname === 'geocoding-api.open-meteo.com') {
      return new Response(JSON.stringify({ results: [] }), { headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`não deveria chamar ${parsed.hostname}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(aiChat('missing-weather', 'clima Unknown Weather Place'), /não consegui consultar o clima/);
  assert.deepEqual(requestedHosts, ['geocoding-api.open-meteo.com'], 'sem dados verificados, a IA não deve inventar a previsão');
});

test('aiPoll usa a IA para estruturar texto natural e cai no fallback local se a IA falhar', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"question":"Hoje tem fut?","options":["Sim","Não","Depende da hora"]}' } }]
  }), { headers: { 'content-type': 'application/json' } });
  t.after(() => { globalThis.fetch = originalFetch; });

  const fromAi = await aiPoll('Hoje tem fut , sim ou nao, ou tepende da hora');
  assert.deepEqual(fromAi, {
    question: 'Hoje tem fut?',
    options: ['Sim', 'Não', 'Depende da hora']
  });

  // Se o provedor de IA falhar, o fallback local ainda interpreta a frase e corrige erros comuns
  globalThis.fetch = async () => { throw new Error('offline'); };
  const fromFallback = await aiPoll('Hoje tem fut , sim ou nao, ou tepende da hora');
  assert.deepEqual(fromFallback, {
    question: 'Hoje tem fut?',
    options: ['Sim', 'Não', 'Depende da hora']
  });

  assert.deepEqual(parseNaturalPollFallback('Bora jogar hoje'), {
    question: 'Bora jogar hoje?',
    options: ['Sim', 'Não', 'Talvez']
  });
});
