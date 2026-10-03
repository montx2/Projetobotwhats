import test from 'node:test';
import assert from 'node:assert/strict';

import { setDnsLookupForTests } from '../src/core/http.js';
import { aiChat, resetChatMemory, resetChatMemoryForChat } from '../src/features/ai.js';

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
