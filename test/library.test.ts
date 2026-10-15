import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notetaker-lib-'));
process.env.OUTPUT_DIR = dir;
const { listMeetings, getMeeting, meetingPath } = await import('../src/library.js');
const { splitTitle } = await import('../src/pipeline.js');

before(() => {
  const ok = path.join(dir, '2026-10-15T16-51-49_abc-defg-hij');
  fs.mkdirSync(ok);
  fs.writeFileSync(path.join(ok, 'summary.md'), '# Beta launch plan\n\n## TL;DR\nShip on the 28th.\n\n## Decisions\n- Ship it\n');
  fs.writeFileSync(path.join(ok, 'meta.json'), JSON.stringify({ platform: 'meet', startedAt: '2026-10-15T16:51:49Z', endedAt: '2026-10-15T17:29:49Z', participants: ['Obi'] }));
  const bad = path.join(dir, '2026-10-10T18-56-49_zoom-84512093377');
  fs.mkdirSync(bad);
  fs.writeFileSync(path.join(bad, 'error.txt'), 'Transcription came back empty.\n');
  fs.mkdirSync(path.join(dir, '2026-10-16T09-00-00_live-call-abc'));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('splitTitle separates Claude\'s "# Title" line from the notes', () => {
  assert.deepEqual(splitTitle('# Q4 plan\n\n## TL;DR\nHi'), { title: 'Q4 plan', body: '## TL;DR\nHi' });
  assert.deepEqual(splitTitle('## TL;DR\nNo title'), { title: null, body: '## TL;DR\nNo title' });
});

test('listMeetings reads status, title, TL;DR and duration, newest first', () => {
  const list = listMeetings();
  assert.deepEqual(list.map((m) => m.status), ['in-progress', 'ready', 'failed']);
  const ready = list[1];
  assert.equal(ready.title, 'Beta launch plan');
  assert.equal(ready.tldr, 'Ship on the 28th.');
  assert.equal(ready.durationMin, 38);
  assert.equal(list[2].platform, 'zoom');
  assert.equal(list[2].error, 'Transcription came back empty.');
});

test('getMeeting returns the notes body without the title line', () => {
  const m = getMeeting('2026-10-15T16-51-49_abc-defg-hij')!;
  assert.ok(m.summary!.startsWith('## TL;DR'));
  assert.equal(m.hasAudio, false);
});

test('meetingPath refuses anything that could leave OUTPUT_DIR', () => {
  for (const id of ['..', '.', '../etc', 'a/b', '..%2F', '.hidden', '']) assert.equal(meetingPath(id), null, id);
  assert.equal(meetingPath('does-not-exist'), null);
  assert.ok(meetingPath('2026-10-15T16-51-49_abc-defg-hij', 'summary.md')!.endsWith('summary.md'));
});
