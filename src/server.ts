// Tiny HTTP API so anyone on the team can send the bot into a call:
//   curl -X POST $HOST/join -H "Authorization: Bearer $SERVER_TOKEN" -d '{"url":"https://meet.google.com/abc-defg-hij"}'
//   curl -X POST $HOST/join -H "Authorization: Bearer $SERVER_TOKEN" -d '{"url":"https://zoom.us/j/1234567890?pwd=..."}'
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { runMeeting } from './pipeline.js';
import { detectPlatform } from './bot/platforms/index.js';

type Job = { id: string; url: string; platform: string; status: 'running' | 'done' | 'failed'; error?: string; summary?: string; startedAt: string };
const jobs = new Map<string, Job>();

function send(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10_000) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') return send(res, 200, { ok: true });
  if (!config.serverToken || req.headers.authorization !== `Bearer ${config.serverToken}`) {
    return send(res, 401, { error: 'unauthorized' });
  }

  if (req.method === 'POST' && req.url === '/join') {
    let url = '';
    let passcode: string | undefined;
    try {
      const body = JSON.parse(await readBody(req));
      url = String(body.url ?? '');
      passcode = body.passcode ? String(body.passcode) : undefined;
    } catch { /* fall through */ }
    const platform = url.startsWith('https://') ? detectPlatform(url) : null;
    if (!platform) {
      return send(res, 400, { error: 'body must be {"url":"<Google Meet or Zoom link>"} (optionally "passcode" for Zoom)' });
    }

    const job: Job = { id: randomUUID(), url, platform: platform.name, status: 'running', startedAt: new Date().toISOString() };
    jobs.set(job.id, job);
    runMeeting(url, { passcode })
      .then((r) => { job.status = 'done'; job.summary = r.summary; })
      .catch((e) => { job.status = 'failed'; job.error = String(e?.message ?? e); console.error(e); });
    return send(res, 202, { id: job.id, status: job.status });
  }

  if (req.method === 'GET' && req.url === '/jobs') return send(res, 200, [...jobs.values()]);
  const m = req.url?.match(/^\/jobs\/([\w-]+)$/);
  if (req.method === 'GET' && m) {
    const job = jobs.get(m[1]);
    return job ? send(res, 200, job) : send(res, 404, { error: 'not found' });
  }
  send(res, 404, { error: 'not found' });
});

if (!config.serverToken) console.warn('SERVER_TOKEN is empty — every request will be rejected until you set it.');
server.listen(config.serverPort, () => console.log(`notetaker listening on :${config.serverPort}`));
