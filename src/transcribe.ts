// Speech-to-text with Deepgram (Nova-3) including speaker diarization.
// (Fireworks retired its audio/transcription API in June 2026; Fireworks still writes the notes.)
// Deepgram accepts the bot's WebM/Opus recording directly, so no conversion is needed.
import fs from 'node:fs';
import { Agent, fetch } from 'undici';
import { config } from './config.js';

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

/** Builds the Deepgram request URL, including keyterms (team names, product words) to improve accuracy. */
export function deepgramUrl(): string {
  const params = new URLSearchParams({
    model: config.deepgramModel,
    smart_format: 'true',
    punctuate: 'true',
    diarize: 'true',
    utterances: 'true',
  });
  for (const term of config.deepgramKeyterms) params.append('keyterm', term);
  return `${config.deepgramUrl}?${params}`;
}

/** Turns Deepgram's response into speaker turns. */
export function parseDeepgram(json: any): Utterance[] {
  const utterances: any[] = json?.results?.utterances ?? [];
  if (utterances.length) {
    return utterances
      .filter((u) => String(u.transcript ?? '').trim())
      .map((u) => ({ speaker: u.speaker ?? 0, start: u.start, end: u.end, text: String(u.transcript).trim() }));
  }
  // No utterances (e.g. diarization off): fall back to the plain transcript as one speaker.
  const alt = json?.results?.channels?.[0]?.alternatives?.[0];
  const text = String(alt?.transcript ?? '').trim();
  return text ? [{ speaker: 0, start: 0, end: Number(json?.metadata?.duration ?? 0), text }] : [];
}

// Long meetings can take a while to upload and transcribe; Node's default fetch gives up after 5 minutes.
const longRequests = new Agent({ headersTimeout: 30 * 60_000, bodyTimeout: 30 * 60_000 });

export async function transcribe(audioPath: string): Promise<Utterance[]> {
  if (!config.deepgramKey) throw new Error('DEEPGRAM_API_KEY is not set.');
  const res = await fetch(deepgramUrl(), {
    method: 'POST',
    headers: { Authorization: `Token ${config.deepgramKey}`, 'Content-Type': 'audio/webm' },
    body: fs.createReadStream(audioPath) as any,
    duplex: 'half',
    dispatcher: longRequests,
  } as any);
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 500);
    throw new Error(`Deepgram transcription ${res.status}: ${detail}`);
  }
  return parseDeepgram(await res.json());
}
