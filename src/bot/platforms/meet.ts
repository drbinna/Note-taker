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
    const signedIn = !(await nameBox.first().isVisible({ timeout: 5000 }).catch(() => false));
    if (!signedIn) {
      log('meet: joining as guest (bot is not signed in to Google):', config.botName);
      await nameBox.first().fill(config.botName);
    } else {
      log('meet: joining with the signed-in Google account');
    }

    // Buttons read "Turn off ..." while the device is on.
    for (const device of ['microphone', 'camera']) {
      await clickIfVisible(page.locator(`[role="button"][aria-label*="Turn off ${device}" i], button[aria-label*="Turn off ${device}" i]`), 3000);
    }

    // Never "Switch here": when the bot uses the same Google account as someone already in the
    // call, that button moves their session to the bot and drops them from the meeting.
    // "Join here too" joins alongside them instead.
    const joinButton = page.getByRole('button', { name: /^(join here too|join now|ask to join|join anyway)$/i });
    await joinButton.first().waitFor({ state: 'visible', timeout: 30_000 });
    await joinButton.first().click();
    log('meet: requested to join; waiting to be admitted');

    const deadline = Date.now() + config.admitTimeoutMs;
    while (Date.now() < deadline) {
      if (await inCall(page)) return;
      const text = (await page.evaluate(() => document.body.innerText).catch(() => '')) || '';
      if (/you can't join this video call/i.test(text)) {
        // Meet's bot check rejects anonymous guests from server browsers before the host is asked.
        throw new Error(
          signedIn
            ? "Meet blocked the bot (\"You can't join this video call\"). The meeting may only allow invited users or people in your organization."
            : "Meet blocked the bot as an anonymous guest (\"You can't join this video call\"), so no admit request was sent. Sign the bot into a Google account (see README: Sign the bot into Google)."
        );
      }
      if (/someone in the call denied|denied your request/i.test(text)) throw new Error('Someone in the call denied the request to join.');
      if (/you've been removed/i.test(text)) throw new Error('The bot was removed from the call.');
      if (/no one responded/i.test(text)) throw new Error('No one in the call responded to the request to join.');
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
