// Checks the in-page capture hook without Google or Zoom involved.
// Run: npx tsx test/capture.integration.ts   (needs ffmpeg for the loudness check)
//
//  meet-webrtc        two local RTCPeerConnections send a tone (how Meet delivers audio)
//  zoom-webaudio      an iframe plays a tone through AudioContext -> speakers (WebAudio path)
//  zoom-both-no-echo  remote WebRTC tone that is ALSO played through WebAudio; must not be doubled
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE = path.join(here, '..', 'src/bot/audio-capture.js');

const LOOPBACK = `async (alsoPlayViaWebAudio) => {
  const a = new RTCPeerConnection(), b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  const ac = new AudioContext();
  const osc = ac.createOscillator(); const g = ac.createGain(); g.gain.value = 0.25;
  const dst = ac.createMediaStreamDestination();
  osc.connect(g); g.connect(dst); osc.start();
  dst.stream.getTracks().forEach((t) => a.addTrack(t, dst.stream));
  b.ontrack = (e) => {
    if (!alsoPlayViaWebAudio) return;
    const el = new Audio(); el.muted = true; el.srcObject = new MediaStream([e.track]); el.play();
    const player = new AudioContext();
    player.createMediaStreamSource(new MediaStream([e.track])).connect(player.destination);
    window.__keepPlayer = player;
  };
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
  await new Promise((r) => setTimeout(r, 1500));
  window.__keep = { a, b, ac };
}`;

const IFRAME_TONE = `<script>
  const ac = new AudioContext();
  const osc = ac.createOscillator(); const g = ac.createGain(); g.gain.value = 0.25;
  osc.connect(g); g.connect(ac.destination); osc.start();
</script>`;

async function run(name: string, mode: string, setup: (page: import('playwright').Page) => Promise<void>) {
  const chunks: Buffer[] = [];
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext();
  await context.exposeFunction('__notetakerChunk', (b64: string) => { chunks.push(Buffer.from(b64, 'base64')); });
  await context.addInitScript({ content: `window.__notetakerMode = ${JSON.stringify(mode)};` });
  await context.addInitScript({ path: CAPTURE });
  const page = await context.newPage();
  await setup(page);
  await page.waitForTimeout(1500);

  // Same frame-picking rule as the recorder: most audio sources wins.
  let best = page.mainFrame(); let bestN = -1;
  for (const f of page.frames()) {
    const n = await f.evaluate(() => (window as any).__notetaker?.sourceCount?.() ?? 0).catch(() => 0);
    if (n > bestN) { best = f; bestN = n; }
  }
  await best.evaluate(() => (window as any).__notetaker.start());
  await page.waitForTimeout(6000);
  await best.evaluate(() => (window as any).__notetaker.stop());
  await browser.close();

  const file = path.join(os.tmpdir(), `capture-${name}.webm`);
  fs.writeFileSync(file, Buffer.concat(chunks));
  const ff = execFileSync('sh', ['-c', `ffmpeg -v info -i "${file}" -af volumedetect -f null - 2>&1 || true`], { encoding: 'utf8' });
  const mean = Number(ff.match(/mean_volume: (-?[\d.]+) dB/)?.[1] ?? NaN);
  return { name, frame: best === page.mainFrame() ? 'main' : 'iframe', sources: bestN, bytes: fs.statSync(file).size, meanDb: mean };
}

const results = [
  await run('meet-webrtc', 'webrtc', (p) => p.setContent('<p>meet</p>').then(() => p.evaluate(`(${LOOPBACK})(false)`))),
  await run('zoom-webaudio', 'webrtc+webaudio', (p) => p.setContent(`<iframe srcdoc="${IFRAME_TONE.replace(/"/g, '&quot;')}"></iframe>`)),
  await run('zoom-both-no-echo', 'webrtc+webaudio', (p) => p.setContent('<p>zoom</p>').then(() => p.evaluate(`(${LOOPBACK})(true)`))),
];
console.table(results);

const [rtc, wa, both] = results;
const ok =
  rtc.meanDb > -40 &&
  wa.meanDb > -40 && wa.frame === 'iframe' &&
  both.meanDb > -40 && both.meanDb - rtc.meanDb < 3; // doubling would be ~ +6 dB
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
