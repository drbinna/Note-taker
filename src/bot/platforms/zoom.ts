import type { Frame, Locator, Page } from 'playwright';
import { config } from '../../config.js';
import { anyFrameHasText, clickIfVisible, log, sleep } from '../util.js';
import type { Platform } from './types.js';

/** Parses zoom.us/j/123?pwd=..., zoom.us/wc/join/123, company.zoom.us/j/..., zoom.us/my/... */
export function parseZoomUrl(raw: string): { host: string; id: string; pwd?: string } {
  const u = new URL(raw);
  const id =
    u.pathname.match(/\/(?:j|wc\/join|wc|s|w)\/(\d{9,11})/)?.[1] ??
    u.pathname.match(/\/wc\/(\d{9,11})\/join/)?.[1] ??
    u.searchParams.get('confno') ??
    '';
  if (!id) throw new Error(`Could not find a Zoom meeting number in ${raw}`);
  // Plain zoom.us links run the web client on app.zoom.us; vanity domains (acme.zoom.us) keep their host so SSO still works.
  const host = /^(www\.)?zoom\.us$/i.test(u.hostname) || /^us\d+web\.zoom\.us$/i.test(u.hostname) ? 'app.zoom.us' : u.hostname;
  return { host, id, pwd: u.searchParams.get('pwd') ?? undefined };
}

export function zoomWebClientUrl(raw: string): string {
  const { host, id, pwd } = parseZoomUrl(raw);
  const q = new URLSearchParams();
  if (pwd) q.set('pwd', pwd);
  const qs = q.toString();
  return `https://${host}/wc/join/${id}${qs ? `?${qs}` : ''}`;
}

/** Zoom renders the meeting inside an iframe on some hosts; search the top page and every frame. */
async function find(page: Page, pick: (f: Page | Frame) => Locator): Promise<Locator | null> {
  for (const f of [page, ...page.frames()]) {
    const loc = pick(f).first();
    if (await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

async function clickAnywhere(page: Page, pick: (f: Page | Frame) => Locator) {
  const loc = await find(page, pick);
  if (!loc) return false;
  await loc.click().catch(() => {});
  return true;
}

const leaveButton = (f: Page | Frame) => f.locator('button[aria-label="Leave"], button[aria-label^="Leave" i]').or(f.getByRole('button', { name: /^leave$/i }));

async function inCall(page: Page) {
  return (await find(page, leaveButton)) !== null;
}

const ENDED = /meeting has been ended|ended by (the )?host|you have been removed|removed you from the meeting|this meeting has ended/i;
const REFUSED = /meeting passcode is wrong|invalid meeting id|this meeting (link|id) is not valid|only authenticated users can join|you can't join this meeting/i;

export const zoom: Platform = {
  name: 'zoom',
  captureMode: 'webrtc+webaudio',

  browserUrl: zoomWebClientUrl,

  meetingId: (url) => {
    try { return `zoom-${parseZoomUrl(url).id}`; } catch { return 'zoom'; }
  },

  async join(page, url, opts) {
    const target = zoomWebClientUrl(url);
    log('zoom: opening web client', target);
    await page.goto(target, { waitUntil: 'domcontentloaded' });

    // Cookie banner: take the privacy-preserving choice when offered.
    await clickIfVisible(page.getByRole('button', { name: /^(reject all|decline|reject)( cookies)?$/i }), 3000);

    // Pre-join screen: name, optional passcode, mute mic + stop video.
    const deadline = Date.now() + 30_000;
    let nameBox: Locator | null = null;
    while (!nameBox && Date.now() < deadline) {
      nameBox = await find(page, (f) => f.locator('#input-for-name, input[placeholder*="name" i], input[aria-label*="name" i]'));
      if (!nameBox) {
        if (await anyFrameHasText(page, REFUSED)) throw new Error('Zoom refused the join (bad link, passcode, or sign-in required).');
        await sleep(1000);
      }
    }
    if (nameBox) await nameBox.fill(config.botName);

    const pwdBox = await find(page, (f) => f.locator('#input-for-pwd, input[type="password"]'));
    if (pwdBox && opts.passcode) await pwdBox.fill(opts.passcode);

    await clickAnywhere(page, (f) => f.locator('button[aria-label="Mute"], button[aria-label*="mute my microphone" i]'));
    await clickAnywhere(page, (f) => f.locator('button[aria-label="Stop Video"], button[aria-label*="stop my video" i]'));

    const joined = await clickAnywhere(page, (f) => f.getByRole('button', { name: /^join$/i }));
    if (!joined) throw new Error('Could not find Zoom\'s Join button. The web client UI may have changed.');
    // Some accounts show a terms dialog the first time.
    await sleep(1500);
    await clickAnywhere(page, (f) => f.getByRole('button', { name: /^(i agree|agree)$/i }));
    log('zoom: requested to join; waiting (waiting room or host not started)');

    const admitBy = Date.now() + config.admitTimeoutMs;
    while (Date.now() < admitBy) {
      if (await inCall(page)) return;
      if (await anyFrameHasText(page, REFUSED)) throw new Error('Zoom refused the join (bad link, passcode, or sign-in required).');
      if (await anyFrameHasText(page, ENDED)) throw new Error('The Zoom meeting ended or the bot was removed before being admitted.');
      await sleep(2000);
    }
    throw new Error('Zoom did not admit the bot before ADMIT_TIMEOUT_MIN.');
  },

  /** Zoom sends no audio until the participant joins "computer audio". */
  async afterJoin(page) {
    for (let i = 0; i < 10; i++) {
      if (await clickAnywhere(page, (f) => f.getByRole('button', { name: /join audio by computer/i }))) break;
      // The footer button opens the audio dialog when the auto-prompt didn't appear.
      await clickAnywhere(page, (f) => f.locator('button[aria-label*="join audio" i]'));
      await sleep(1500);
    }
    await sleep(1500);
    await clickAnywhere(page, (f) => f.locator('button[aria-label*="mute my microphone" i]'));
    log('zoom: computer audio joined');
  },

  async inCall(page) {
    if (await anyFrameHasText(page, ENDED)) return false;
    return inCall(page);
  },

  async isAlone(page) {
    // Footer button label looks like "open the participants list pane,[3] particpants" (Zoom's own typo).
    const btn = await find(page, (f) => f.locator('button[aria-label*="participants" i], button[aria-label*="particpants" i]'));
    const label = (await btn?.getAttribute('aria-label').catch(() => null)) ?? '';
    const count = Number(label.match(/\[(\d+)\]/)?.[1] ?? label.match(/(\d+)/)?.[1] ?? NaN);
    if (Number.isFinite(count)) return count <= 1;
    return anyFrameHasText(page, /you are the only (one|participant)/i);
  },

  async participants(page) {
    const names = new Set<string>();
    for (const f of page.frames()) {
      const found = await f
        .evaluate(() =>
          [...document.querySelectorAll('[class*="avatar-name"], [class*="display-name"], [class*="video-tile-name"]')]
            .map((e) => (e as HTMLElement).innerText.trim())
            .filter((s) => s.length > 1 && s.length < 60)
        )
        .catch(() => [] as string[]);
      found.forEach((n) => names.add(n));
    }
    names.delete(config.botName);
    return [...names];
  },

  async leave(page) {
    if (await clickAnywhere(page, leaveButton)) {
      await sleep(800);
      await clickAnywhere(page, (f) => f.getByRole('button', { name: /^leave meeting$/i }));
    }
  },
};
