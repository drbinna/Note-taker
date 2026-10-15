import fs from 'node:fs';
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

export async function transcribe(audioPath: string): Promise<Utterance[]> {
  if (!config.deepgramKey) throw new Error('DEEPGRAM_API_KEY is not set.');
  const params = new URLSearchParams({
    model: config.deepgramModel,
    smart_format: 'true',
    punctuate: 'true',
    diarize: 'true',
    utterances: 'true',
  });
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${config.deepgramKey}`, 'Content-Type': 'audio/webm' },
    body: fs.readFileSync(audioPath),
  });
  if (!res.ok) throw new Error(`Deepgram ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  return (json.results?.utterances ?? []).map((u: any) => ({
    speaker: u.speaker ?? 0,
    start: u.start,
    end: u.end,
    text: u.transcript,
  }));
}
