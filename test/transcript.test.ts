import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTime, formatTranscript } from '../src/transcribe.js';

test('formatTime pads hours, minutes, seconds', () => {
  assert.equal(formatTime(0), '00:00:00');
  assert.equal(formatTime(83.9), '00:01:23');
  assert.equal(formatTime(3725), '01:02:05');
});

test('formatTranscript merges consecutive turns from one speaker', () => {
  const out = formatTranscript([
    { speaker: 0, start: 0, end: 2, text: 'Hey everyone.' },
    { speaker: 0, start: 2.5, end: 4, text: 'Let us start.' },
    { speaker: 1, start: 5, end: 7, text: 'Sounds good.' },
    { speaker: 0, start: 20, end: 22, text: 'Next item.' },
  ]);
  assert.equal(
    out,
    [
      '[00:00:00] Speaker 1: Hey everyone. Let us start.',
      '[00:00:05] Speaker 2: Sounds good.',
      '[00:00:20] Speaker 1: Next item.',
    ].join('\n')
  );
});
