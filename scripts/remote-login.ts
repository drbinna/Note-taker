// Sign the bot in on a server with no screen (Fly.io).
// Starts Chrome on the server with the bot's real profile and exposes its DevTools on
// port 9223 (private network only). From your laptop:
//   fly proxy 9223                      # in one terminal
//   open chrome://inspect in your own Chrome → Configure… → add localhost:9223 → "inspect"
// You get a live, clickable view of the server's Chrome: sign in there, then press Ctrl+C
// in the `fly ssh console` session running this script so the login is saved.
//
//   node dist/scripts/remote-login.js          → Google (for Meet)
//   node dist/scripts/remote-login.js zoom     → Zoom (optional)
import net from 'node:net';
import { launchBrowser } from '../src/bot/browser.js';
import { config } from '../src/config.js';

const CHROME_PORT = 9222;
const RELAY_PORT = Number(process.env.DEVTOOLS_RELAY_PORT ?? 9223);
const TIMEOUT_MIN = 20;
const target = process.argv[2] === 'zoom' ? 'https://zoom.us/signin' : 'https://accounts.google.com/';

config.headless = false;
const browser = await launchBrowser({
  profile: 'shared',
  manualSignals: true,
  // Newer Chrome rejects DevTools viewers from other origins unless allowed; the port is only
  // reachable through `fly proxy` on the private network.
  extraArgs: [`--remote-debugging-port=${CHROME_PORT}`, '--remote-allow-origins=*'],
});
const page = browser.context.pages()[0] ?? (await browser.context.newPage());
await page.goto(target);

// Chrome only listens on 127.0.0.1; relay it to the machine's private network so `fly proxy` can reach it.
const relay = net.createServer((client) => {
  const upstream = net.connect(CHROME_PORT, '127.0.0.1');
  client.pipe(upstream).pipe(client);
  const end = () => { client.destroy(); upstream.destroy(); };
  client.on('error', end);
  upstream.on('error', end);
});
// Fly's private network is IPv6, so listen on :: when possible; fall back to IPv4 elsewhere.
function listen(host: string) {
  relay.once('error', (err: NodeJS.ErrnoException) => {
    if (host === '::' && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')) return listen('0.0.0.0');
    console.error('DevTools relay failed:', err.message);
    void finish('Relay error.');
  });
  relay.listen(RELAY_PORT, host, printInstructions);
}
listen('::');

/** Direct link to a live, clickable view of the sign-in page (served by the server's Chrome). */
async function viewerLink(): Promise<string> {
  try {
    const targets: any[] = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`)).json();
    const t = targets.find((x) => x.type === 'page' && !String(x.url).startsWith('chrome'));
    if (t) return `http://localhost:${RELAY_PORT}/devtools/inspector.html?ws=localhost:${RELAY_PORT}/devtools/page/${t.id}`;
  } catch { /* fall back to chrome://inspect */ }
  return `chrome://inspect  →  Configure…  →  add localhost:${RELAY_PORT}  →  "inspect"`;
}

async function printInstructions() {
  console.log(`
Chrome is open on the server at ${target}

On your laptop:
  1. Run (and leave running):  fly proxy ${RELAY_PORT} -a <your-app>
  2. Open this in Chrome:      ${await viewerLink()}
  3. Sign in to the bot's account in the page shown on the left.
  4. Come back here and press Ctrl+C to save the login.
(Gives up after ${TIMEOUT_MIN} minutes.)`);
}

let finished = false;
async function finish(reason: string) {
  if (finished) return;
  finished = true;
  console.log(`\n${reason} Saving profile to ${config.profileDir}…`);
  relay.close();
  await browser.close();
  console.log('Done. New meetings will use this login.');
  process.exit(0);
}

process.on('SIGINT', () => void finish('Stopping.'));
process.on('SIGTERM', () => void finish('Stopping.'));
browser.context.on('close', () => void finish('Browser closed.'));
setTimeout(() => void finish('Timed out.'), TIMEOUT_MIN * 60_000);
