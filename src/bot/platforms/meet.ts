import type { Page } from 'playwright';
import { config } from '../../config.js';
import { clickIfVisible, log, sleep } from '../util.js';
import type { Platform } from './types.js';

async function inCall(page: Page) {
  return page.getByRole('button', { name: /leave call/i }).first().isVisible().catch(() => false);
}

export const meet: Platform = {
  name: 'meet',
  captureMode: 'webrtc',

  browserUrl: (url) => url,

  meetingId: (url) => url.match(/meet\.google\.com\/([a-z0-9-]+)/i)?.[1] ?? 'meet',

  async join(page, url) {
    log('meet: opening', url);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await clickIfVisible(page.getByRole('button', { name: /^(got it|dismiss)$/i }), 2000);

    // Guest flow (not signed in): Meet asks for a name.
    const nameBox = page.locator('input[aria-label="Your name"], input[placeholder="Your name"]');
    if (await nameBox.first().isVisible({ timeout: 5000 }).catch(() => false)) {
      log('meet: joining as guest:', config.botName);
      await nameBox.first().fill(config.botName);
    }

    // Buttons read "Turn off ..." while the device is on.
    for (const device of ['microphone', 'camera']) {
      await clickIfVisible(page.locator(`[role="button"][aria-label*="Turn off ${device}" i], button[aria-label*="Turn off ${device}" i]`), 3000);
    }

    const joinButton = page.getByRole('button', { name: /^(join now|ask to join|join anyway|switch here)$/i });
    await joinButton.first().waitFor({ state: 'visible', timeout: 30_000 });
    await joinButton.first().click();
    log('meet: requested to join; waiting to be admitted');

    const deadline = Date.now() + config.admitTimeoutMs;
    while (Date.now() < deadline) {
      if (await inCall(page)) return;
      const blocked = await page
        .getByText(/you can't join this video call|someone in the call denied|you've been removed|no one responded/i)
        .first().isVisible().catch(() => false);
      if (blocked) throw new Error('Meet refused entry (denied, removed or blocked for guests).');
      await sleep(2000);
    }
    throw new Error('Nobody admitted the bot before ADMIT_TIMEOUT_MIN.');
  },

  inCall,

  async isAlone(page) {
    const tiles = await page
      .evaluate(() => new Set([...document.querySelectorAll('[data-participant-id]')].map((e) => e.getAttribute('data-participant-id'))).size)
      .catch(() => 0);
    if (tiles <= 1) return true;
    return page.getByText(/you're the only one here/i).first().isVisible().catch(() => false);
  },

  async participants(page) {
    return page
      .evaluate(() => {
        const names = new Set<string>();
        document.querySelectorAll('[data-participant-id]').forEach((el) => {
          const line = (el as HTMLElement).innerText?.split('\n').map((s) => s.trim()).find((s) => s.length > 1 && s.length < 60);
          if (line) names.add(line);
        });
        return [...names];
      })
      .catch(() => [] as string[]);
  },

  async leave(page) {
    await clickIfVisible(page.getByRole('button', { name: /leave call/i }), 1000);
  },
};
