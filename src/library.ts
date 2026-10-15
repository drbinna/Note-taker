// Reads saved meetings from OUTPUT_DIR (one folder per meeting) for the dashboard.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export type MeetingStatus = 'ready' | 'failed' | 'in-progress';

export interface MeetingSummary {
  id: string;
  title: string;
  platform: 'meet' | 'zoom' | 'unknown';
  status: MeetingStatus;
  startedAt: string | null;
  durationMin: number | null;
  tldr: string | null;
  participants: string[];
  error: string | null;
}

export interface MeetingDetail extends MeetingSummary {
  summary: string | null;   // markdown body without the "# Title" line
  transcript: string | null;
  hasAudio: boolean;
  endReason: string | null;
  url: string | null;
}

const ID = /^[\w.-]+$/;

/** Resolves a meeting id to its folder, refusing anything that could escape OUTPUT_DIR. */
export function meetingPath(id: string, file?: string): string | null {
  if (!ID.test(id) || id.startsWith('.')) return null;
  const dir = path.join(config.outputDir, id);
  if (path.dirname(dir) !== path.resolve(config.outputDir) || !fs.existsSync(dir)) return null;
  return file ? path.join(dir, file) : dir;
}

function readText(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function readMeta(dir: string): any {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { return {}; }
}

/** Folder names look like 2026-10-15T18-30-49_zoom-1234567890 or 2026-10-15T18-30-49_abc-defg-hij. */
function fromFolderName(id: string) {
  const m = id.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})_(.+)$/);
  if (!m) return { startedAt: null, platform: 'unknown' as const };
  return {
    startedAt: new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`).toISOString(),
    platform: m[5].startsWith('zoom-') ? ('zoom' as const) : ('meet' as const),
  };
}

function section(markdown: string, heading: string): string | null {
  const re = new RegExp(`^##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'mi');
  const m = markdown.match(re);
  return m ? m[1].trim() : null;
}

function load(id: string): MeetingDetail | null {
  const dir = meetingPath(id);
  if (!dir) return null;
  const meta = readMeta(dir);
  const guess = fromFolderName(id);
  const md = readText(path.join(dir, 'summary.md'));
  const error = readText(path.join(dir, 'error.txt'))?.trim() || null;

  let title: string | null = null;
  let body: string | null = null;
  if (md) {
    const m = md.match(/^\s*#\s+(.+)\n+/);
    title = m ? m[1].trim() : null;
    body = m ? md.slice(m[0].length).trim() : md.trim();
  }

  const startedAt = meta.startedAt ?? guess.startedAt;
  const durationMin =
    meta.startedAt && meta.endedAt
      ? Math.max(1, Math.round((new Date(meta.endedAt).getTime() - new Date(meta.startedAt).getTime()) / 60000))
      : null;
  const platform = meta.platform ?? guess.platform;
  const status: MeetingStatus = md ? 'ready' : error ? 'failed' : 'in-progress';

  return {
    id,
    title: title ?? `${platform === 'zoom' ? 'Zoom' : platform === 'meet' ? 'Meet' : 'Meeting'} call`,
    platform,
    status,
    startedAt,
    durationMin,
    tldr: body ? section(body, 'TL;DR') : null,
    participants: Array.isArray(meta.participants) ? meta.participants : [],
    error,
    summary: body,
    transcript: readText(path.join(dir, 'transcript.txt')),
    hasAudio: fs.existsSync(path.join(dir, 'audio.webm')),
    endReason: meta.endReason ?? null,
    url: meta.url ?? null,
  };
}

export function listMeetings(): MeetingSummary[] {
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(config.outputDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  return ids
    .map(load)
    .filter((m): m is MeetingDetail => m !== null)
    .map(({ summary, transcript, hasAudio, endReason, url, ...rest }) => rest)
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
}

export function getMeeting(id: string): MeetingDetail | null {
  return load(id);
}
