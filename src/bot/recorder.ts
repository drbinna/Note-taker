import type { Frame, Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { launchBrowser } from './browser.js';
import { detectPlatform, type JoinOptions } from './platforms/index.js';
import { log, sleep } from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE_SCRIPT = path.join(here, 'audio-capture.js');

export interface RecordingResult {
  platform: string;
  audioPath: string;
  startedAt: Date;
  endedAt: Date;
  participants: string[];
  endReason: string;
}

/** Meeting apps may play audio from an iframe; record in whichever frame actually has sources. */
async function pickRecordingFrame(page: Page, waitMs: number): Promise<Frame> {
  const deadline = Date.now() + waitMs;
  while (true) {
    let best: { frame: Frame; n: number } | null = null;
    for (const frame of page.frames()) {
      const n = await frame.evaluate(() => (window as any).__notetaker?.sourceCount?.() ?? 0).catch(() => 0);
      if (n > 0 && (!best || n > best.n)) best = { frame, n };
    }
    if (best) {
      log(`recording in ${best.frame === page.mainFrame() ? 'main frame' : `frame ${best.frame.url().slice(0, 80)}`} (${best.n} audio source(s))`);
      return best.frame;
    }
    if (Date.now() > deadline) {
      log('no audio sources seen yet; recording in the main frame and hoping they show up');
      return page.mainFrame();
    }
    await sleep(1000);
  }
}

export async function recordMeeting(url: string, workDir: string, opts: JoinOptions = {}): Promise<RecordingResult> {
  const platform = detectPlatform(url);
  if (!platform) throw new Error(`Unsupported meeting link: ${url}`);

  fs.mkdirSync(workDir, { recursive: true });
  const audioPath = path.join(workDir, 'audio.webm');
  const out = fs.createWriteStream(audioPath);
  let bytes = 0;

  const browser = await launchBrowser();
  const { context } = browser;
  const participants = new Set<string>();
  let endReason = 'unknown';
  const startedAt = new Date();

  try {
    const origin = new URL(platform.browserUrl(url)).origin;
    await context.grantPermissions(['microphone', 'camera'], { origin }).catch(() => {});
    await context.exposeFunction('__notetakerChunk', (b64: string) => {
      const buf = Buffer.from(b64, 'base64');
      bytes += buf.length;
      out.write(buf);
    });
    await context.addInitScript({ content: `window.__notetakerMode = ${JSON.stringify(platform.captureMode)};` });
    await context.addInitScript({ path: CAPTURE_SCRIPT });

    const page = context.pages()[0] ?? (await context.newPage());
    await platform.join(page, url, opts);
    await platform.afterJoin?.(page);
    log(`${platform.name}: in the call`);

    const frame = await pickRecordingFrame(page, 30_000);
    await frame.evaluate(() => (window as any).__notetaker.start());
    log('recording');

    let aloneSince: number | null = null;
    const hardStop = Date.now() + config.maxDurationMs;

    while (true) {
      await sleep(5000);
      (await platform.participants(page)).forEach((n) => participants.add(n));

      if (!(await platform.inCall(page))) { endReason = 'call ended or bot removed'; break; }
      if (Date.now() > hardStop) { endReason = 'hit MAX_DURATION_MIN'; break; }

      if (await platform.isAlone(page)) {
        aloneSince ??= Date.now();
        if (Date.now() - aloneSince > config.aloneTimeoutMs) { endReason = 'everyone else left'; break; }
      } else {
        aloneSince = null;
      }
    }

    log('stopping:', endReason);
    await frame.evaluate(() => (window as any).__notetaker?.stop()).catch(() => {});
    await platform.leave(page).catch(() => {});
  } finally {
    await browser.close();
    await new Promise<void>((r) => out.end(() => r()));
  }

  log(`saved ${(bytes / 1024 / 1024).toFixed(1)} MB of audio to ${audioPath}`);
  if (bytes === 0) throw new Error('No audio was captured. Check that someone spoke and that the capture script loaded.');
  return { platform: platform.name, audioPath, startedAt, endedAt: new Date(), participants: [...participants], endReason };
}
