import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A local stand-in for Deepgram's /v1/listen, so the real upload path runs.
let received: { url?: string; auth?: string; contentType?: string; bytes: number } | null = null;
let reply: { status: number; json: unknown } = { status: 200, json: {} };
const server = http.createServer((req, res) => {
  let bytes = 0;
  req.on('data', (c) => { bytes += c.length; });
  req.on('end', () => {
    received = { url: req.url, auth: req.headers.authorization, contentType: req.headers['content-type'], bytes };
    res.writeHead(reply.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply.json));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as any).port;

process.env.DEEPGRAM_API_KEY = 'test-key';
process.env.DEEPGRAM_URL = `http://127.0.0.1:${port}/v1/listen`;
process.env.DEEPGRAM_KEYTERMS = 'Lantern, Obi';
const { transcribe, parseDeepgram, formatTranscript, deepgramUrl } = await import('../src/transcribe.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notetaker-asr-'));
const audio = path.join(dir, 'audio.webm');
fs.writeFileSync(audio, Buffer.alloc(20_000, 7)); // stand-in recording bytes
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('deepgramUrl turns on diarization and passes keyterms', () => {
  const u = new URL(deepgramUrl());
  assert.equal(u.searchParams.get('model'), 'nova-3');
  assert.equal(u.searchParams.get('diarize'), 'true');
  assert.equal(u.searchParams.get('utterances'), 'true');
  assert.deepEqual(u.searchParams.getAll('keyterm'), ['Lantern', 'Obi']);
});

test('transcribe streams the WebM recording and returns speaker turns', async () => {
  reply = {
    status: 200,
    json: { results: { utterances: [
      { speaker: 0, start: 0, end: 1.2, transcript: 'Hi team.' },
      { speaker: 1, start: 1.5, end: 2.4, transcript: 'Hey Obi.' },
    ] } },
  };
  const turns = await transcribe(audio);
  assert.deepEqual(turns, [
    { speaker: 0, start: 0, end: 1.2, text: 'Hi team.' },
    { speaker: 1, start: 1.5, end: 2.4, text: 'Hey Obi.' },
  ]);
  assert.equal(received!.auth, 'Token test-key');
  assert.equal(received!.contentType, 'audio/webm');
  assert.equal(received!.bytes, 20_000, 'whole file uploaded');
  assert.match(received!.url!, /diarize=true/);
});

test('transcribe surfaces API errors with the status', async () => {
  reply = { status: 401, json: { err_msg: 'Invalid credentials.' } };
  await assert.rejects(transcribe(audio), /Deepgram transcription 401: .*Invalid credentials/);
});

test('parser falls back to the plain transcript, and handles nothing', () => {
  assert.deepEqual(
    parseDeepgram({ metadata: { duration: 4 }, results: { channels: [{ alternatives: [{ transcript: 'Just text' }] }] } }),
    [{ speaker: 0, start: 0, end: 4, text: 'Just text' }]
  );
  assert.deepEqual(parseDeepgram({}), []);
});

test('parser output feeds the transcript formatter', () => {
  const out = formatTranscript(parseDeepgram({ results: { utterances: [
    { speaker: 0, start: 0, end: 0.8, transcript: 'Okay, go' },
    { speaker: 1, start: 65, end: 65.4, transcript: 'Yes' },
  ] } }));
  assert.equal(out, '[00:00:00] Speaker 1: Okay, go\n[00:01:05] Speaker 2: Yes');
});
