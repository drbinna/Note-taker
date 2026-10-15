import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.FIREWORKS_API_KEY = 'test-key';
process.env.FIREWORKS_MODEL = 'accounts/fireworks/models/test-model';
const { summarize, cleanModelOutput } = await import('../src/summarize.js');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const meta = { participants: ['Obi'], startedAt: new Date('2026-10-15T16:00:00Z'), durationMin: 30 };

test('cleanModelOutput strips reasoning, code fences and preamble', () => {
  assert.equal(cleanModelOutput('<think>long thoughts</think>\n# Title\n\n## TL;DR\nHi'), '# Title\n\n## TL;DR\nHi');
  assert.equal(cleanModelOutput('```markdown\n# Title\n## TL;DR\nHi\n```'), '# Title\n## TL;DR\nHi');
  assert.equal(cleanModelOutput('Sure! Here are the notes:\n\n# Title\n## TL;DR\nHi'), '# Title\n## TL;DR\nHi');
  assert.equal(cleanModelOutput('thinking with no opening tag</think># Title'), '# Title');
});

test('summarize calls Fireworks chat completions with the configured model', async () => {
  let sent: any;
  globalThis.fetch = (async (url: string, init: any) => {
    sent = { url, headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: '<think>x</think># Pilot plan\n\n## TL;DR\nGo.' }, finish_reason: 'stop' }] }), { status: 200 });
  }) as any;

  const notes = await summarize('[00:00:01] Speaker 1: Hello', meta);
  assert.equal(notes, '# Pilot plan\n\n## TL;DR\nGo.');
  assert.equal(sent.url, 'https://api.fireworks.ai/inference/v1/chat/completions');
  assert.equal(sent.headers.Authorization, 'Bearer test-key');
  assert.equal(sent.body.model, 'accounts/fireworks/models/test-model');
  assert.equal(sent.body.messages[0].role, 'system');
  assert.match(sent.body.messages[1].content, /Names seen on screen: Obi/);
  assert.match(sent.body.messages[1].content, /<transcript>\n\[00:00:01\] Speaker 1: Hello\n<\/transcript>/);
});

test('summarize reports API errors with the status and model', async () => {
  globalThis.fetch = (async () => new Response('{"error":"model not found"}', { status: 404 })) as any;
  await assert.rejects(summarize('x', meta), /Fireworks 404 for model accounts\/fireworks\/models\/test-model: .*model not found/);
});

test('summarize explains an empty answer cut off by the token limit', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '<think>never finished' }, finish_reason: 'length' }] }), { status: 200 })) as any;
  await assert.rejects(summarize('x', meta), /ran out of tokens/);
});
