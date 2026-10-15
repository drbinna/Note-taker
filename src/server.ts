// HTTP server: the team dashboard (public/) plus the JSON API it uses.
// Every /api route needs `Authorization: Bearer $SERVER_TOKEN`; the dashboard asks for it once.
//
//   POST /api/join            {"url": "<Meet or Zoom link>", "passcode"?: "123456"}
//   GET  /api/jobs            bots running now and recently finished
//   POST /api/jobs/:id/stop   make a bot leave now (it still writes notes for what it heard)
//   GET  /api/meetings        saved meetings, newest first
//   GET  /api/meetings/:id    one meeting: notes, transcript, details
//   POST /api/meetings/:id/retry   re-run transcript + notes from the saved recording
//   GET  /api/meetings/:id/{audio.webm|transcript.txt|summary.md}   downloads
//
// The older /join and /jobs routes still work for curl scripts.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { runMeeting, processAudio } from './pipeline.js';
import { detectPlatform } from './bot/platforms/index.js';
import { listMeetings, getMeeting, meetingPath } from './library.js';
import type { Stage } from './bot/recorder.js';

type JobStatus = 'starting' | Stage | 'done' | 'failed' | 'stopped';
interface Job {
  id: string;
  url: string;
  platform: string;
  status: JobStatus;
  meetingId: string | null;
  error?: string;
  createdAt: string;
  recordingSince?: string;
  finishedAt?: string;
}
const jobs = new Map<string, Job>();
const controllers = new Map<string, AbortController>();
const retrying = new Set<string>(); // meeting ids being re-transcribed

// public/ sits next to src/ in the repo and next to dist/ in the image.
const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = [path.resolve(here, '../public'), path.resolve(here, '../../public')].find((p) => fs.existsSync(p)) ?? path.resolve('public');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webm': 'audio/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

function sendFile(res: http.ServerResponse, file: string, opts: { download?: string; cache?: boolean } = {}) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': opts.cache ? 'public, max-age=300' : 'no-store',
      ...(opts.download ? { 'Content-Disposition': `attachment; filename="${opts.download}"` } : {}),
      ...SECURITY_HEADERS,
    });
    fs.createReadStream(file).pipe(res);
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10_000) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function authorized(req: http.IncomingMessage): boolean {
  if (!config.serverToken) return false;
  const got = Buffer.from(String(req.headers.authorization ?? ''));
  const want = Buffer.from(`Bearer ${config.serverToken}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

function startJob(url: string, passcode?: string): Job {
  const platform = detectPlatform(url)!;
  const job: Job = { id: randomUUID(), url, platform: platform.name, status: 'starting', meetingId: null, createdAt: new Date().toISOString() };
  const ctrl = new AbortController();
  jobs.set(job.id, job);
  controllers.set(job.id, ctrl);

  runMeeting(url, { passcode }, {
    signal: ctrl.signal,
    onDir: (dir) => { job.meetingId = path.basename(dir); },
    onStage: (stage) => {
      job.status = stage;
      if (stage === 'recording') job.recordingSince = new Date().toISOString();
    },
  })
    .then(() => { job.status = 'done'; })
    .catch((e) => {
      job.status = ctrl.signal.aborted && !job.recordingSince ? 'stopped' : 'failed';
      job.error = String(e?.message ?? e);
      console.error(e);
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      controllers.delete(job.id);
    });
  return job;
}

/** Running bots plus anything that finished in the last 12 hours. */
function visibleJobs(): Job[] {
  const cutoff = Date.now() - 12 * 3600_000;
  for (const [id, j] of jobs) if (j.finishedAt && Date.parse(j.finishedAt) < cutoff) jobs.delete(id);
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function handleJoin(req: http.IncomingMessage, res: http.ServerResponse) {
  let url = '';
  let passcode: string | undefined;
  try {
    const body = JSON.parse(await readBody(req));
    url = String(body.url ?? '').trim();
    passcode = body.passcode ? String(body.passcode).trim() : undefined;
  } catch { /* fall through */ }
  if (!url.startsWith('https://') || !detectPlatform(url)) {
    return send(res, 400, { error: 'Paste a Google Meet or Zoom link that starts with https://' });
  }
  const job = startJob(url, passcode);
  send(res, 202, job);
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://x');
  const method = req.method ?? 'GET';

  if (pathname === '/health') return send(res, 200, { ok: true });

  // ---- API ----
  if (pathname.startsWith('/api/') || pathname === '/join' || pathname === '/jobs' || pathname.startsWith('/jobs/')) {
    if (!authorized(req)) return send(res, 401, { error: 'Wrong or missing access code.' });

    if (method === 'GET' && pathname === '/api/me') return send(res, 200, { ok: true });
    if (method === 'POST' && (pathname === '/api/join' || pathname === '/join')) return handleJoin(req, res);
    if (method === 'GET' && (pathname === '/api/jobs' || pathname === '/jobs')) return send(res, 200, visibleJobs());

    let m = pathname.match(/^\/(?:api\/)?jobs\/([\w-]+)(\/stop)?$/);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job) return send(res, 404, { error: 'No such bot.' });
      if (method === 'GET' && !m[2]) return send(res, 200, job);
      if (method === 'POST' && m[2]) {
        controllers.get(job.id)?.abort();
        return send(res, 202, job);
      }
    }

    if (method === 'GET' && pathname === '/api/meetings') return send(res, 200, listMeetings());

    m = pathname.match(/^\/api\/meetings\/([\w.-]+)$/);
    if (method === 'GET' && m) {
      const meeting = getMeeting(m[1]);
      return meeting ? send(res, 200, meeting) : send(res, 404, { error: 'Meeting not found.' });
    }

    m = pathname.match(/^\/api\/meetings\/([\w.-]+)\/retry$/);
    if (method === 'POST' && m) {
      const id = m[1];
      const audio = meetingPath(id, 'audio.webm');
      if (!audio || !fs.existsSync(audio)) return send(res, 404, { error: 'No recording was saved for this meeting.' });
      if (retrying.has(id)) return send(res, 409, { error: 'Already working on this one.' });
      let meta: any = {};
      try { meta = JSON.parse(fs.readFileSync(meetingPath(id, 'meta.json')!, 'utf8')); } catch { /* no meta */ }
      retrying.add(id);
      fs.rmSync(meetingPath(id, 'error.txt')!, { force: true }); // shows as "in progress" right away
      processAudio(audio, meta)
        .catch((e) => console.error('retry failed:', e))
        .finally(() => retrying.delete(id));
      return send(res, 202, { ok: true });
    }

    m = pathname.match(/^\/api\/meetings\/([\w.-]+)\/(audio\.webm|transcript\.txt|summary\.md)$/);
    if (method === 'GET' && m) {
      const file = meetingPath(m[1], m[2]);
      return file ? sendFile(res, file, { download: `${m[1]}-${m[2]}` }) : send(res, 404, { error: 'not found' });
    }

    return send(res, 404, { error: 'not found' });
  }

  // ---- Dashboard (static files; the app itself asks for the access code) ----
  if (method !== 'GET' && method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file)) {
    return sendFile(res, path.join(PUBLIC_DIR, 'index.html')); // client-side routes
  }
  sendFile(res, file, { cache: !file.endsWith('.html') });
});

if (!config.serverToken) console.warn('SERVER_TOKEN is empty — the dashboard and API will reject everyone until you set it.');
server.listen(config.serverPort, () => console.log(`notetaker dashboard on http://localhost:${config.serverPort}`));
