// One-time setup: opens a visible Chrome window using the bot's profile so you can
// sign in yourself. The session is saved in PROFILE_DIR and reused on every join.
//   npm run login          → Google account (for Meet)
//   npm run login -- zoom  → Zoom account (optional; only needed for meetings that require sign-in)
import { launchBrowser } from '../src/bot/browser.js';
import { config } from '../src/config.js';

const target = process.argv[2] === 'zoom' ? 'https://zoom.us/signin' : 'https://accounts.google.com/';
config.headless = false;
const context = await launchBrowser();
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(target);
console.log(`Sign in to the bot's account in the window, then close it. Profile: ${config.profileDir}`);
await new Promise<void>((resolve) => context.on('close', () => resolve()));
console.log('Saved. You can now run: npm run join -- <meeting link>');
