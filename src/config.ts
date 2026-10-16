import 'dotenv/config';
import path from 'node:path';

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number(v) : fallback;
}

export const config = {
  botName: process.env.BOT_NAME ?? 'Lantern Notetaker',
  // Chrome profile the bot reuses, so it stays signed in to its Google account.
  profileDir: path.resolve(process.env.PROFILE_DIR ?? '.bot-profile'),
  outputDir: path.resolve(process.env.OUTPUT_DIR ?? 'meetings'),
  // 'chrome' uses installed Google Chrome (harder for Meet to flag); leave empty for Playwright Chromium.
  chromeChannel: process.env.CHROME_CHANNEL || undefined,
  headless: process.env.HEADLESS === 'true',

  admitTimeoutMs: num('ADMIT_TIMEOUT_MIN', 10) * 60_000,
  aloneTimeoutMs: num('ALONE_TIMEOUT_SEC', 60) * 1000,
  maxDurationMs: num('MAX_DURATION_MIN', 180) * 60_000,

  // Transcripts: Deepgram (Fireworks retired its audio API in June 2026).
  deepgramKey: process.env.DEEPGRAM_API_KEY ?? '',
  deepgramModel: process.env.DEEPGRAM_MODEL || 'nova-3',
  deepgramUrl: process.env.DEEPGRAM_URL || 'https://api.deepgram.com/v1/listen',
  // Comma-separated names and terms Deepgram should recognise (people, product, company).
  deepgramKeyterms: (process.env.DEEPGRAM_KEYTERMS ?? 'Lantern,Lantern Notetaker,Obi')
    .split(',').map((s) => s.trim()).filter(Boolean),

  // Notes: written by a Fireworks-hosted model.
  fireworksKey: process.env.FIREWORKS_API_KEY ?? '',
  fireworksModel: process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/deepseek-v4p1-flash',

  slackWebhook: process.env.SLACK_WEBHOOK_URL ?? '',
  serverPort: num('PORT', 8080),
  // Optional. Empty = the dashboard is open to anyone with the link; set it to require an access code.
  serverToken: process.env.SERVER_TOKEN ?? '',
};
