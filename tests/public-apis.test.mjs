import test from 'node:test';
import assert from 'node:assert/strict';

import { setDnsLookupForTests } from '../src/core/http.js';
import { DEFAULT_CONFIG, cfg } from '../src/core/config.js';
import { handleMessage } from '../src/features/router.js';
import { publicMenu } from '../src/features/menu.js';
import {
  convertCurrency,
  extractCurrencyIntent,
  extractHolidayIntent,
  extractWeatherLocation,
  formatCurrencyMessage,
  formatPublicHolidaysMessage,
  formatWeatherMessage,
  getPublicHolidays,
  getWeatherByCity,
  parseCurrencyAmount
} from '../src/features/public-apis.js';

setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('intents de APIs da IA exigem contexto explícito e valores válidos', () => {
  assert.equal(extractWeatherLocation('qual a previsão do tempo para São Paulo amanhã?'), 'São Paulo');
  assert.equal(extractWeatherLocation('Vai chover em Itaúna, Minas Gerais hoje?'), 'Itaúna, Minas Gerais');
  assert.equal(extractWeatherLocation('como está o clima de Itaúna?'), 'Itaúna');
  assert.equal(extractWeatherLocation('como está o tempo no momento?'), null);
  assert.equal(extractWeatherLocation('qual a capital do Japão?'), null);

  assert.deepEqual(extractCurrencyIntent('cotacao 100 USD BRL'), { amount: 100, from: 'USD', to: 'BRL' });
  assert.deepEqual(extractCurrencyIntent('cotação 100 USD BRL'), { amount: 100, from: 'USD', to: 'BRL' });
  assert.deepEqual(extractCurrencyIntent('quanto vale 1.234,50 EUR em BRL?'), { amount: 1234.5, from: 'EUR', to: 'BRL' });
  assert.equal(extractCurrencyIntent('quanto vale uma casa em BRL?'), null);
  assert.equal(parseCurrencyAmount('1.234,56'), 1234.56);
  assert.equal(parseCurrencyAmount('100.50'), 100.5);
  assert.equal(parseCurrencyAmount('0'), null);
  assert.equal(extractHolidayIntent('feriados 2027 PT').country, 'PT');
  assert.deepEqual(extractHolidayIntent('quais são os feriados de Portugal em 2026?', new Date('2025-01-01T00:00:00Z')), { year: 2026, country: 'PT' });
  assert.deepEqual(extractHolidayIntent('quais são os próximos feriados?', new Date('2026-01-01T00:00:00Z')), { year: 2026, country: 'BR' });

  const menu = publicMenu();
  assert.match(menu, /\.clima <cidade>/);
  assert.match(menu, /\.cotacao <valor>/);
  assert.match(menu, /\.feriados \[ano\]/);
  assert.match(menu, /\.ia clima <cidade>/);
});

test('consulta de clima valida resposta, formata em português, atribui a fonte e usa cache', async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    requests.push(parsed);
    if (parsed.hostname === 'geocoding-api.open-meteo.com') {
      return jsonResponse({
        results: [{ name: 'Itaúna', admin1: 'Minas Gerais', country: 'Brasil', latitude: -20.0756, longitude: -44.5764, timezone: 'America/Sao_Paulo' }]
      });
    }
    if (parsed.hostname === 'api.open-meteo.com') {
      return jsonResponse({
        timezone: 'America/Sao_Paulo',
        current: {
          time: '2026-10-02T14:00', temperature_2m: 21.5, relative_humidity_2m: 58,
          apparent_temperature: 22.1, precipitation: 0, weather_code: 2, wind_speed_10m: 8.2
        },
        daily: {
          time: ['2026-10-02'], temperature_2m_min: [16.4], temperature_2m_max: [28.1],
          precipitation_probability_max: [15]
        }
      });
    }
    throw new Error(`host inesperado: ${parsed.hostname}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const weather = await getWeatherByCity('Itaúna, MG');
  const cached = await getWeatherByCity('itaúna, mg');
  assert.equal(requests.length, 2, 'uma consulta de geocodificação e outra de previsão; a segunda leitura vem do cache');
  assert.equal(requests[0].searchParams.get('name'), 'Itaúna, MG');
  assert.equal(requests[0].searchParams.get('language'), 'pt');
  assert.equal(requests[1].searchParams.get('timezone'), 'auto');
  assert.equal(weather.temperatureC, 21.5);
  assert.equal(cached.location.name, 'Itaúna');
  assert.match(formatWeatherMessage(weather), /Clima — Itaúna, Minas Gerais, Brasil/);
  assert.match(formatWeatherMessage(weather), /Open-Meteo.*CC BY 4\.0/);
  assert.match(formatWeatherMessage(weather), /chance máxima de chuva 15%/);
});

test('consulta de clima falha de forma clara sem geocodificação e rejeita consultas enormes antes da rede', async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return jsonResponse({ results: [] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(getWeatherByCity('Cidade Sem Resultado'), /não encontrei/);
  await assert.rejects(getWeatherByCity('x'.repeat(101)), /no máximo 100 caracteres/);
  assert.equal(calls, 1);
});

test('câmbio usa Frankfurter, valida códigos, converte valor local e apresenta ressalva financeira', async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    requests.push(parsed);
    return jsonResponse({ date: '2026-10-01', base: 'USD', quote: 'BRL', rate: 5.25 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const conversion = await convertCurrency('1.234,56', 'usd', 'brl');
  const cached = await convertCurrency(100, 'USD', 'BRL');
  assert.equal(requests.length, 1, 'a taxa do par fica em cache');
  assert.equal(requests[0].hostname, 'api.frankfurter.dev');
  assert.equal(conversion.converted, 6481.44);
  assert.equal(cached.rate, 5.25);
  assert.match(formatCurrencyMessage(conversion), /6\.481,44 BRL/);
  assert.match(formatCurrencyMessage(conversion), /não é cotação em tempo real/);

  await assert.rejects(convertCurrency(10, 'USDD', 'BRL'), /códigos de moeda ISO/);
  const sameCurrency = await convertCurrency(10, 'BRL', 'BRL');
  assert.equal(sameCurrency.converted, 10);
  assert.equal(requests.length, 1, 'entrada inválida e mesma moeda não fazem chamadas externas');
});

test('feriados mantém apenas eventos nacionais públicos e informa que datas locais podem faltar', async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    requests.push(parsed);
    return jsonResponse([
      { date: '2027-01-01', name: "New Year's Day", countryCode: 'BR', nationalHoliday: true, holidayTypes: ['Public'] },
      { date: '2027-02-01', name: 'Carnival', countryCode: 'BR', nationalHoliday: true, holidayTypes: ['Optional'] },
      { date: '2027-07-09', name: 'State holiday', countryCode: 'BR', nationalHoliday: false, holidayTypes: ['Public'] }
    ]);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const holidays = await getPublicHolidays(2027, 'br');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].hostname, 'nagerholidays.com');
  assert.equal(requests[0].pathname, '/api/v4/Holidays/BR/2027');
  const message = formatPublicHolidaysMessage(holidays, 2027, 'BR', '2027-01-01');
  assert.match(message, /Confraternização Universal/);
  assert.doesNotMatch(message, /Carnaval|State holiday/);
  assert.match(message, /datas estaduais e municipais podem variar/);
});

test('roteador expõe .clima, .cotacao e .feriados no privado autorizado', async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    requests.push(parsed);
    if (parsed.hostname === 'geocoding-api.open-meteo.com') {
      return jsonResponse({ results: [{ name: 'RouteTestville', admin1: 'MG', country: 'Brasil', latitude: -19, longitude: -44, timezone: 'America/Sao_Paulo' }] });
    }
    if (parsed.hostname === 'api.open-meteo.com') {
      return jsonResponse({
        timezone: 'America/Sao_Paulo',
        current: { time: '2026-10-02T14:00', temperature_2m: 23, weather_code: 0 },
        daily: { time: ['2026-10-02'], temperature_2m_min: [17], temperature_2m_max: [29], precipitation_probability_max: [5] }
      });
    }
    if (parsed.hostname === 'api.frankfurter.dev') {
      return jsonResponse({ date: '2026-10-01', base: 'GBP', quote: 'BRL', rate: 7.1 });
    }
    if (parsed.hostname === 'nagerholidays.com') {
      return jsonResponse([{ date: '2028-01-01', name: "New Year's Day", countryCode: 'US', nationalHoliday: true, holidayTypes: ['Public'] }]);
    }
    throw new Error(`host inesperado: ${parsed.hostname}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  Object.assign(cfg.get(), structuredClone(DEFAULT_CONFIG));

  const sent = [];
  const sock = {
    user: { id: '5511900000000@s.whatsapp.net' },
    sendMessage: async (jid, content) => {
      sent.push({ jid, content });
      return { key: { id: `reply-${sent.length}`, remoteJid: jid } };
    }
  };
  const deps = {
    type: 'notify',
    ownerJid: '5511900000000@s.whatsapp.net',
    isOwner: () => true,
    isOwnerPrivateChat: () => true,
    sendOwner: async () => {}
  };
  const issue = async (jid, text) => handleMessage(sock, {
    key: { remoteJid: jid, id: `message-${jid}`, fromMe: true },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: text }
  }, deps);

  await issue('5511900000000@s.whatsapp.net', '.clima RouteTestville');
  await issue('5511900000001@s.whatsapp.net', '.cotacao 10 GBP BRL');
  await issue('5511900000002@s.whatsapp.net', '.feriados 2028 US');

  const replies = sent.map((entry) => entry.content.text || '').join('\n');
  assert.match(replies, /Open-Meteo.*CC BY 4\.0/);
  assert.match(replies, /71,00 BRL/);
  assert.match(replies, /Feriados nacionais — Estados Unidos/);
  assert.equal(requests.length, 4, 'clima usa geocodificação + previsão; câmbio e feriados fazem uma chamada cada');
});

test('comandos de APIs públicas continuam bloqueados em chats sem opt-in', async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('a API não deve ser chamada antes do opt-in');
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  Object.assign(cfg.get(), structuredClone(DEFAULT_CONFIG));

  const sent = [];
  const sock = {
    sendMessage: async (jid, content) => {
      sent.push({ jid, content });
      return { key: { id: `reply-${sent.length}`, remoteJid: jid } };
    }
  };
  const deps = {
    type: 'notify',
    ownerJid: '5511900000000@s.whatsapp.net',
    isOwner: () => false,
    isOwnerPrivateChat: () => false,
    sendOwner: async () => {}
  };
  const group = 'grupo-sem-opt-in@g.us';
  await handleMessage(sock, {
    key: { remoteJid: group, id: 'unauthorized-weather', fromMe: false, participant: '5511999999999@s.whatsapp.net' },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: '.clima Itaúna' }
  }, deps);

  assert.equal(sent.length, 0);
  assert.equal(calls, 0, 'nenhuma localização sai para terceiros antes de o chat ser liberado');
});
