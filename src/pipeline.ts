import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { recordMeeting, type RecordHooks } from './bot/recorder.js';
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

/** Splits the model's "# Title" first line off the rest of the notes. */
export function splitTitle(markdown: string): { title: string | null; body: string } {
  const m = markdown.match(/^\s*#\s+(.+)\n+/);
  return m ? { title: m[1].trim(), body: markdown.slice(m[0].length).trim() } : { title: null, body: markdown.trim() };
}

/** Transcribe + summarize + deliver an audio file that's already on disk. */
export async function processAudio(
  audioPath: string,
  meta: { participants?: string[]; startedAt?: Date | string; endedAt?: Date | string; title?: string; platform?: string } = {},
  hooks: RecordHooks = {}
) {
  const dir = path.dirname(audioPath);
  const startedAt = meta.startedAt ? new Date(meta.startedAt) : fs.statSync(audioPath).mtime;
  fs.rmSync(path.join(dir, 'error.txt'), { force: true });

  try {
    log('transcribing', audioPath);
    hooks.onStage?.('transcribing');
    const utterances = await transcribe(audioPath);
    if (!utterances.length) throw new Error('Transcription came back empty — nobody spoke, or the audio was silent.');
    const transcript = formatTranscript(utterances);
    fs.writeFileSync(path.join(dir, 'transcript.txt'), transcript + '\n');

    const durationMin = Math.max(1, Math.round(utterances[utterances.length - 1].end / 60));
    log('summarizing', `${durationMin} min, ${transcript.length} chars`);
    hooks.onStage?.('summarizing');
    const raw = await summarize(transcript, { participants: meta.participants ?? [], startedAt, durationMin });

    const split = splitTitle(raw);
    const fallback = `${meta.platform === 'zoom' ? 'Zoom' : 'Meet'} call, ${startedAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`;
    const title = meta.title ?? split.title ?? fallback;
    fs.writeFileSync(path.join(dir, 'summary.md'), `# ${title}\n\n${split.body}\n`);
    await postToSlack(title, split.body);
    log('done:', path.join(dir, 'summary.md'));
    return { dir, title, summary: split.body, transcript };
  } catch (err: any) {
    fs.writeFileSync(path.join(dir, 'error.txt'), String(err?.message ?? err) + '\n');
    throw err;
  }
}

export interface RunHooks extends RecordHooks {
  /** Called as soon as the meeting's folder name is known. */
  onDir?: (dir: string) => void;
}

/** Full run: join the call, record until it ends, then process. */
export async function runMeeting(url: string, opts: JoinOptions = {}, hooks: RunHooks = {}) {
  const dir = meetingDir(url);
  hooks.onDir?.(dir);
  let rec;
  try {
    rec = await recordMeeting(url, dir, opts, hooks);
  } catch (err: any) {
    // Without this, a failed join leaves the folder looking "in progress" forever.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'error.txt'), String(err?.message ?? err) + '\n');
    throw err;
  }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ url, ...rec }, null, 2));
  return processAudio(rec.audioPath, rec, hooks);
}
