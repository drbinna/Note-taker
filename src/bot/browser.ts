import { chromium, type BrowserContext } from 'playwright';
import fs from 'node:fs';
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

/** Launches Chrome with the bot's persistent profile (keeps Google / Zoom sign-ins). */
export async function launchBrowser(): Promise<BrowserContext> {
  fs.mkdirSync(config.profileDir, { recursive: true });
  const silence = path.join(config.profileDir, 'silence.wav');
  silentWav(silence);
  return chromium.launchPersistentContext(config.profileDir, {
    headless: config.headless,
    channel: config.chromeChannel,
    viewport: { width: 1280, height: 720 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${silence}`,
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled',
    ],
  });
}
