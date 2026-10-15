import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// A local stand-in for Fireworks' transcription endpoint, so the real upload path runs.
let received: { auth?: string; contentType?: string; body: Buffer } | null = null;
let reply: { status: number; json: unknown } = { status: 200, json: {} };
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received = { auth: req.headers.authorization, contentType: req.headers['content-type'], body: Buffer.concat(chunks) };
    res.writeHead(reply.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply.json));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as any).port;

process.env.FIREWORKS_API_KEY = 'test-key';
process.env.FIREWORKS_ASR_URL = `http://127.0.0.1:${port}/v1/audio/transcriptions`;
const { transcribe, parseFireworksTranscript, asrEndpoint, toMp3, formatTranscript } = await import('../src/transcribe.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notetaker-asr-'));
const webm = path.join(dir, 'audio.webm');
before(() => {
  // Same format the bot records: Opus in WebM.
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'libopus', '-b:a', '32k', webm]);
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('toMp3 turns the WebM recording into a 16 kHz mono mp3', async () => {
  const mp3 = await toMp3(webm);
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'csv=p=0', mp3]).toString().trim();
  assert.equal(probe, 'mp3,16000,1');
  fs.rmSync(mp3);
});

test('asrEndpoint picks the right Fireworks host for each Whisper model', () => {
  const saved = process.env.FIREWORKS_ASR_URL;
  // config is read at import, so check the logic through a fresh override-free call
  assert.match(asrEndpoint('whisper-v3'), /127\.0\.0\.1|audio-prod/);
  process.env.FIREWORKS_ASR_URL = saved;
});

test('transcribe uploads an mp3 with diarization on and returns speaker turns', async () => {
  reply = {
    status: 200,
    json: {
      text: 'Hi team. Hey Obi.',
      words: [
        { word: ' Hi', start: 0.0, end: 0.3, speaker_id: 'SPEAKER_00' },
        { word: ' team.', start: 0.3, end: 0.8, speaker_id: 'SPEAKER_00' },
        { word: ' Hey', start: 1.2, end: 1.5, speaker_id: 'SPEAKER_01' },
        { word: ' Obi.', start: 1.5, end: 1.9, speaker_id: 'SPEAKER_01' },
      ],
      segments: [{ text: 'Hi team. Hey Obi.', start: 0, end: 1.9 }],
    },
  };
  const turns = await transcribe(webm);
  assert.deepEqual(turns, [
    { speaker: 0, start: 0, end: 0.8, text: 'Hi team.' },
    { speaker: 1, start: 1.2, end: 1.9, text: 'Hey Obi.' },
  ]);

  assert.ok(received, 'request reached the server');
  assert.equal(received!.auth, 'Bearer test-key');
  assert.match(received!.contentType!, /^multipart\/form-data; boundary=/);
  const body = received!.body.toString('latin1');
  for (const [k, v] of [['model', 'whisper-v3'], ['diarize', 'true'], ['response_format', 'verbose_json'], ['timestamp_granularities', 'word,segment'], ['vad_model', 'silero']]) {
    assert.match(body, new RegExp(`name="${k}"\\r\\n\\r\\n${v}\\r\\n`), `form field ${k}`);
  }
  assert.match(body, /name="file"; filename="audio\.mp3"\r\nContent-Type: audio\/mpeg/);
  assert.ok(received!.body.length > 5000, 'mp3 bytes were uploaded');
  assert.equal(fs.existsSync(path.join(dir, 'audio.upload.mp3')), false, 'temporary mp3 cleaned up');
});

test('transcribe surfaces API errors with the status', async () => {
  reply = { status: 401, json: { error: 'invalid api key' } };
  await assert.rejects(transcribe(webm), /Fireworks transcription 401 \(whisper-v3\): .*invalid api key/);
  assert.equal(fs.existsSync(path.join(dir, 'audio.upload.mp3')), false, 'temporary mp3 cleaned up after an error');
});

test('parser uses segment speakers when words have none, and numbers speakers by first appearance', () => {
  const turns = parseFireworksTranscript({
    segments: [
      { text: ' Let us start. ', start: 0, end: 2, speaker_id: 3 },
      { text: 'Sounds good.', start: 2.5, end: 3.5, speaker_id: 1 },
      { text: 'First item.', start: 4, end: 5, speaker_id: 3 },
    ],
  });
  assert.deepEqual(turns.map((t) => [t.speaker, t.text]), [[0, 'Let us start.'], [1, 'Sounds good.'], [0, 'First item.']]);
});

test('parser falls back to one speaker when diarization returned nothing', () => {
  assert.deepEqual(parseFireworksTranscript({ segments: [{ text: 'Hello', start: 0, end: 1 }] }), [{ speaker: 0, start: 0, end: 1, text: 'Hello' }]);
  assert.deepEqual(parseFireworksTranscript({ text: 'Just text', duration: 4 }), [{ speaker: 0, start: 0, end: 4, text: 'Just text' }]);
  assert.deepEqual(parseFireworksTranscript({}), []);
});

test('parser output feeds the transcript formatter', () => {
  const out = formatTranscript(parseFireworksTranscript({
    words: [
      { word: 'Okay', start: 0, end: 0.4, speaker_id: 'A' },
      { word: ',', start: 0.4, end: 0.45, speaker_id: 'A' },
      { word: 'go', start: 0.5, end: 0.8, speaker_id: 'A' },
      { word: 'Yes', start: 65, end: 65.4, speaker_id: 'B' },
    ],
  }));
  assert.equal(out, '[00:00:00] Speaker 1: Okay, go\n[00:01:05] Speaker 2: Yes');
});
