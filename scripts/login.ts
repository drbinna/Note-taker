// One-time setup on your own computer: opens a visible Chrome window using the bot's
// profile so you can sign in yourself. The session is saved in PROFILE_DIR.
//   npm run login          → Google account (for Meet)
//   npm run login -- zoom  → Zoom account (optional; only for meetings that require sign-in)
// On Fly.io (no screen) use scripts/remote-login.ts instead; see README.
import { launchBrowser } from '../src/bot/browser.js';
import { config } from '../src/config.js';

const target = process.argv[2] === 'zoom' ? 'https://zoom.us/signin' : 'https://accounts.google.com/';
config.headless = false;
const browser = await launchBrowser({ profile: 'shared', manualSignals: true });
const page = browser.context.pages()[0] ?? (await browser.context.newPage());
await page.goto(target);
console.log(`Sign in to the bot's account in the window, then close it (or press Ctrl+C). Profile: ${config.profileDir}`);
await new Promise<void>((resolve) => {
  browser.context.on('close', () => resolve());
  process.on('SIGINT', () => void browser.close().then(resolve));
});
console.log('Saved. You can now run: npm run join -- <meeting link>');
process.exit(0);
