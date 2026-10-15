import { chromium, type BrowserContext } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';

/** One second of silent 16-bit mono WAV; Chrome loops it as the fake mic so the bot never beeps. */
function silentWav(file: string) {
  if (fs.existsSync(file)) return;
  const rate = 16000;
  const data = Buffer.alloc(rate * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

// Lock files and caches that must not be copied between Chrome instances.
const SKIP = new Set(['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'GrShaderCache', 'ShaderCache', 'Crashpad']);

/**
 * Chrome locks its profile folder, so two meetings can't share one. Each meeting gets a
 * throwaway copy of the bot's signed-in profile instead.
 */
function copyProfile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notetaker-profile-'));
  if (fs.existsSync(config.profileDir)) {
    fs.cpSync(config.profileDir, dir, {
      recursive: true,
      filter: (src) => !SKIP.has(path.basename(src)),
    });
  }
  return dir;
}

export interface LaunchOptions {
  /** 'copy' (default) for meetings; 'shared' writes to the real profile (used by the login scripts). */
  profile?: 'copy' | 'shared';
  extraArgs?: string[];
  /** Let the caller handle Ctrl+C so Chrome shuts down cleanly and writes cookies to disk. */
  manualSignals?: boolean;
}

export interface Browser {
  context: BrowserContext;
  /** Closes the browser and deletes the temporary profile copy, if any. */
  close(): Promise<void>;
}

/** Launches Chrome with the bot's profile (keeps Google / Zoom sign-ins). */
export async function launchBrowser(opts: LaunchOptions = {}): Promise<Browser> {
  fs.mkdirSync(config.profileDir, { recursive: true });
  const silence = path.join(config.profileDir, 'silence.wav');
  silentWav(silence);

  const userDataDir = opts.profile === 'shared' ? config.profileDir : copyProfile();
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: config.headless,
    channel: config.chromeChannel,
    viewport: { width: 1280, height: 720 },
    ignoreDefaultArgs: ['--enable-automation'],
    ...(opts.manualSignals ? { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false } : {}),
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${silence}`,
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      ...(opts.extraArgs ?? []),
    ],
  });

  return {
    context,
    async close() {
      await context.close().catch(() => {});
      if (userDataDir !== config.profileDir) fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}
