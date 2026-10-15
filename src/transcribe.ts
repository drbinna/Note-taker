// Speech-to-text with Fireworks (Whisper v3) including speaker diarization.
// The bot records WebM/Opus; Fireworks lists mp3/m4a/wav/flac, so we convert to a small
// mono mp3 with ffmpeg first.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// Use undici's own fetch/FormData with its Agent: Node's built-in fetch bundles a different
// undici version and rejects an Agent from the npm package ("invalid onRequestStart method").
import { Agent, fetch, FormData } from 'undici';
import { config } from './config.js';

const run = promisify(execFile);

export interface Utterance {
  speaker: number;
  start: number; // seconds
  end: number;
  text: string;
}

export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** Merges back-to-back utterances from the same speaker and renders "[hh:mm:ss] Speaker N: ..." lines. */
export function formatTranscript(utterances: Utterance[]): string {
  const merged: Utterance[] = [];
  for (const u of utterances) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === u.speaker && u.start - last.end < 2) {
      last.text += ' ' + u.text;
      last.end = u.end;
    } else {
      merged.push({ ...u });
    }
  }
  return merged.map((u) => `[${formatTime(u.start)}] Speaker ${u.speaker + 1}: ${u.text.trim()}`).join('\n');
}

/** Fireworks hosts each Whisper variant on its own endpoint. */
export function asrEndpoint(model: string): string {
  if (config.fireworksAsrUrl) return config.fireworksAsrUrl;
  const host = /turbo/i.test(model) ? 'audio-turbo.us-virginia-1.direct.fireworks.ai' : 'audio-prod.us-virginia-1.direct.fireworks.ai';
  return `https://${host}/v1/audio/transcriptions`;
}

/** Converts the recording to 16 kHz mono mp3 (~21 MB per hour), which Fireworks accepts. */
export async function toMp3(input: string): Promise<string> {
  const out = path.join(path.dirname(input), path.basename(input, path.extname(input)) + '.upload.mp3');
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', out]);
  } catch (err: any) {
    if (err?.code === 'ENOENT') throw new Error('ffmpeg is not installed. Install it (the Docker image includes it).');
    throw new Error(`Couldn't convert the recording to mp3: ${String(err?.stderr || err?.message || err).trim()}`);
  }
  return out;
}

type Word = { word?: string; text?: string; start: number; end: number; speaker_id?: string | number | null };
type Segment = { text: string; start: number; end: number; speaker_id?: string | number | null; words?: Word[] };

/**
 * Turns Fireworks' verbose_json into speaker turns. Speaker ids (e.g. "SPEAKER_01" or 1) become
 * 0, 1, 2… in order of first appearance. Uses word-level speakers when present (most precise),
 * then segment-level, and falls back to a single speaker if diarization returned nothing.
 */
export function parseFireworksTranscript(json: any): Utterance[] {
  const segments: Segment[] = Array.isArray(json?.segments) ? json.segments : [];
  const words: Word[] = Array.isArray(json?.words) && json.words.length
    ? json.words
    : segments.flatMap((s) => (Array.isArray(s.words) ? s.words : []));

  const ids = new Map<string, number>();
  const speakerOf = (id: unknown) => {
    const key = String(id);
    if (!ids.has(key)) ids.set(key, ids.size);
    return ids.get(key)!;
  };
  const has = (v: unknown) => v !== undefined && v !== null && v !== '';

  if (words.length && words.some((w) => has(w.speaker_id))) {
    const out: Utterance[] = [];
    let lastSpeaker = 0;
    for (const w of words) {
      const token = String(w.word ?? w.text ?? '').trim();
      if (!token) continue;
      const speaker = has(w.speaker_id) ? speakerOf(w.speaker_id) : lastSpeaker;
      lastSpeaker = speaker;
      const cur = out[out.length - 1];
      if (cur && cur.speaker === speaker && w.start - cur.end < 1.5) {
        cur.text += ' ' + token;
        cur.end = w.end;
      } else {
        out.push({ speaker, start: w.start, end: w.end, text: token });
      }
    }
    return out.map((u) => ({ ...u, text: u.text.replace(/\s+([,.!?;:])/g, '$1') }));
  }

  if (segments.length) {
    const diarized = segments.some((s) => has(s.speaker_id));
    return segments
      .filter((s) => String(s.text ?? '').trim())
      .map((s) => ({ speaker: diarized && has(s.speaker_id) ? speakerOf(s.speaker_id) : 0, start: s.start, end: s.end, text: String(s.text).trim() }));
  }

  const text = String(json?.text ?? '').trim();
  return text ? [{ speaker: 0, start: 0, end: Number(json?.duration ?? 0), text }] : [];
}

// Long meetings can take a while to transcribe; Node's default fetch gives up after 5 minutes.
const longRequests = new Agent({ headersTimeout: 30 * 60_000, bodyTimeout: 30 * 60_000 });

export async function transcribe(audioPath: string): Promise<Utterance[]> {
  if (!config.fireworksKey) throw new Error('FIREWORKS_API_KEY is not set.');
  const model = config.fireworksAsrModel;
  const mp3 = await toMp3(audioPath);

  try {
    const form = new FormData();
    form.append('file', await fs.openAsBlob(mp3, { type: 'audio/mpeg' }), 'audio.mp3');
    form.append('model', model);
    form.append('temperature', '0');
    form.append('vad_model', 'silero');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities', 'word,segment');
    form.append('diarize', 'true');

    const res = await fetch(asrEndpoint(model), {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.fireworksKey}` },
      body: form,
      dispatcher: longRequests,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 500);
      throw new Error(`Fireworks transcription ${res.status} (${model}): ${detail}`);
    }
    return parseFireworksTranscript(await res.json());
  } finally {
    fs.rmSync(mp3, { force: true });
  }
}
