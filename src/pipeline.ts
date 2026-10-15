import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { recordMeeting } from './bot/recorder.js';
import { detectPlatform, type JoinOptions } from './bot/platforms/index.js';
import { transcribe, formatTranscript } from './transcribe.js';
import { summarize } from './summarize.js';

const log = (...a: unknown[]) => console.log(new Date().toISOString(), '[pipeline]', ...a);

export function meetingDir(url: string) {
  const code = detectPlatform(url)?.meetingId(url) ?? 'meeting';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(config.outputDir, `${stamp}_${code}`);
}

async function postToSlack(title: string, summary: string) {
  if (!config.slackWebhook) return;
  const res = await fetch(config.slackWebhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `*${title}*\n\n${summary}`.slice(0, 39000) }),
  });
  if (!res.ok) log('Slack post failed:', res.status, await res.text());
}

/** Transcribe + summarize + deliver an audio file that's already on disk. */
export async function processAudio(
  audioPath: string,
  meta: { participants?: string[]; startedAt?: Date; endedAt?: Date; title?: string; platform?: string } = {}
) {
  const dir = path.dirname(audioPath);
  const startedAt = meta.startedAt ?? fs.statSync(audioPath).mtime;

  log('transcribing', audioPath);
  const utterances = await transcribe(audioPath);
  if (!utterances.length) throw new Error('Transcription came back empty.');
  const transcript = formatTranscript(utterances);
  fs.writeFileSync(path.join(dir, 'transcript.txt'), transcript + '\n');

  const durationMin = Math.max(1, Math.round(utterances[utterances.length - 1].end / 60));
  log('summarizing', `${durationMin} min, ${transcript.length} chars`);
  const summary = await summarize(transcript, { participants: meta.participants ?? [], startedAt, durationMin });

  const title = meta.title ?? `${meta.platform === 'zoom' ? 'Zoom' : 'Meeting'} notes — ${startedAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`;
  const notes = `# ${title}\n\n${summary}\n`;
  fs.writeFileSync(path.join(dir, 'summary.md'), notes);
  await postToSlack(title, summary);
  log('done:', path.join(dir, 'summary.md'));
  return { dir, summary, transcript };
}

/** Full run: join the call, record until it ends, then process. */
export async function runMeeting(url: string, opts: JoinOptions = {}) {
  const dir = meetingDir(url);
  const rec = await recordMeeting(url, dir, opts);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ url, ...rec }, null, 2));
  return processAudio(rec.audioPath, rec);
}
