# Meet Notetaker

A self-hosted notetaker bot for **Google Meet and Zoom**. It joins a call as a participant, records everyone's audio, and when the call ends it produces a speaker-labelled transcript and a Claude-written summary (TL;DR, decisions, action items, open questions). It can also post the summary to Slack.

```
Meet / Zoom link ──▶ pick platform adapter ──▶ Chrome (Playwright) joins the call
                 ──▶ in-page hook mixes all remote audio ──▶ MediaRecorder ──▶ audio.webm
                 ──▶ Deepgram (diarized) ──▶ transcript.txt ──▶ Claude ──▶ summary.md ──▶ Slack
```

## Quick start (your laptop)

```bash
npm install
npx playwright install chromium
cp .env.example .env          # add DEEPGRAM_API_KEY and ANTHROPIC_API_KEY
npm run login                 # sign in to the bot's Google account in the window, then close it

npm run join -- https://meet.google.com/abc-defg-hij
npm run join -- "https://zoom.us/j/1234567890?pwd=AbCdEf"          # quote Zoom links (the ? and &)
npm run join -- https://zoom.us/j/1234567890 --passcode 123456      # Zoom link with no pwd= in it
```

Admit "Goblin Notetaker" when it knocks. When everyone else leaves (or the call ends), the bot leaves and writes everything to `meetings/<timestamp>_<meeting id>/`:

| File | What it is |
|---|---|
| `audio.webm` | Opus recording of everyone except the bot |
| `transcript.txt` | `[hh:mm:ss] Speaker N: …` lines |
| `summary.md` | The notes |
| `meta.json` | Platform, start and end times, names seen on screen, why it stopped |

Re-summarize a recording (for example after tweaking the prompt in `src/summarize.ts`):

```bash
npm run process -- meetings/<folder>/audio.webm
```

## Accounts

**Google Meet:** create a Google account just for the bot (for example `notes@yourdomain`) and sign in once with `npm run login`. Signed-in bots get through far more reliably than guests: many Workspace meetings block or delay anonymous guests, and Google is quicker to flag them.

**Zoom:** the bot joins through Zoom's web client as a guest by default, so most meetings need no account. If a meeting is set to "only authenticated users can join", sign the bot into a Zoom account once with `npm run login -- zoom`.

Both sessions live in `.bot-profile/`. Treat that folder like a password and keep it out of git (it's already in `.gitignore`).

## Zoom specifics

- Any normal Zoom link works: `zoom.us/j/…`, `us05web.zoom.us/j/…`, company links like `acme.zoom.us/j/…`, and web-client links. The bot rewrites them to Zoom's in-browser client (`/wc/join/<id>`), so the "Open Zoom app?" prompt never appears.
- The meeting must allow joining from a browser. That's Zoom's default, but an account admin can turn it off ("Show a Join from your browser link"). If it's off, the bot can't join.
- After it's admitted, the bot clicks **Join Audio by Computer**, because Zoom sends no audio until a participant does. It then mutes itself.
- It waits through waiting rooms and "host hasn't started" screens for up to `ADMIT_TIMEOUT_MIN`.
- It leaves when the participant count drops to just itself, when the host ends the meeting, or when it's removed.

## Run it for the team (server)

`npm start` (after `npm run build`), or `npm run dev`, starts a small API:

```bash
curl -X POST http://HOST:8080/join \
  -H "Authorization: Bearer $SERVER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://meet.google.com/abc-defg-hij"}'

# Zoom; "passcode" is only needed when the link has no pwd=
curl -X POST http://HOST:8080/join \
  -H "Authorization: Bearer $SERVER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://zoom.us/j/1234567890","passcode":"123456"}'

curl -H "Authorization: Bearer $SERVER_TOKEN" http://HOST:8080/jobs
```

Each `/join` starts its own browser on a temporary copy of the bot's login profile, so several meetings can run at once. Budget roughly 1 vCPU and 1 GB of RAM per concurrent meeting.

## Deploy on Fly.io

The bot needs a long-running machine with a (virtual) display, so serverless hosts like Vercel won't work. Fly runs the Dockerfile as an always-on machine. The included `fly.toml` uses the Dallas region with 2 shared CPUs and 2 GB RAM (about two meetings at once), plus a volume at `/data` for the bot's login and the saved notes. It also **turns off Fly's idle auto-stop**, which would otherwise shut the machine down mid-meeting, since a bot in a call gets no web traffic.

### First deploy

```bash
# 1. Install flyctl (https://fly.io/docs/flyctl/install/) and log in
fly auth login

# 2. Pick a unique app name and put it in fly.toml (app = "..."), then create the app
fly apps create goblin-notetaker

# 3. Storage for the bot's login + meeting notes
fly volumes create notetaker_data --region dfw --size 3

# 4. Secrets (never commit these)
fly secrets set \
  DEEPGRAM_API_KEY=... \
  ANTHROPIC_API_KEY=... \
  SERVER_TOKEN=$(openssl rand -hex 24) \
  SLACK_WEBHOOK_URL=...            # optional

# 5. Build and deploy
fly deploy
```

Check it's up with `curl https://goblin-notetaker.fly.dev/health`. To see the `SERVER_TOKEN` you generated, run `fly ssh console -C 'printenv SERVER_TOKEN'`, and share it with your team.

### Sign the bot into Google (once)

Zoom works without this, and so do Meet calls that allow guests. Signing in makes Meet much more reliable. The server has no screen, so you drive its Chrome from your own:

```bash
# Terminal 1: open Chrome on the server
fly ssh console
cd /app && xvfb-run -a node dist/scripts/remote-login.js        # add "zoom" for a Zoom account

# Terminal 2: tunnel to it
fly proxy 9223
```

Then, in your own Chrome:

1. Open `chrome://inspect` and click **Configure…**.
2. Add `localhost:9223`.
3. Click **inspect** under the page that appears. You'll get a live, clickable view of the server's browser.
4. Sign in to the bot's Google account there.
5. Go back to terminal 1 and press **Ctrl+C**. The login is saved to `/data/profile` and survives deploys.

The DevTools port is only reachable through `fly proxy` on your authenticated Fly account. It's never exposed publicly.

### Auto-deploy from GitHub

`.github/workflows/fly-deploy.yml` runs the typecheck and tests on every push to `main`, then deploys. To turn it on:

1. Run `fly tokens create deploy`.
2. Save the output as a repository secret named `FLY_API_TOKEN` (GitHub → Settings → Secrets and variables → Actions).

Until that secret exists, the workflow runs the tests and skips the deploy.

### Useful commands

```bash
fly logs                                   # watch the bot join, record, summarize
fly ssh console -C "ls /data/meetings"     # list saved meetings
fly ssh sftp get /data/meetings/<folder>/summary.md
fly scale memory 4096                      # more simultaneous meetings
```

## Other hosts

Any always-on Docker host works (a VPS, Railway, and so on):

```bash
docker build -t meet-notetaker .
docker run -d -p 8080:8080 --shm-size=1g --env-file .env -v notetaker-data:/data meet-notetaker
```

## Configuration

All settings are in `.env`; see `.env.example`. The useful ones:

- `BOT_NAME`: the display name used when joining as a guest
- `ALONE_TIMEOUT_SEC`: how long the bot waits alone before leaving (default 60)
- `ADMIT_TIMEOUT_MIN`: how long it waits in the lobby or waiting room (default 10)
- `MAX_DURATION_MIN`: a hard cap so a stuck bot can't run forever (default 180)
- `CHROME_CHANNEL=chrome`: use installed Google Chrome instead of Playwright's Chromium. Meet is less likely to flag it, and Zoom's web client is happiest in real Chrome.
- `SLACK_WEBHOOK_URL`: a Slack Incoming Webhook for summaries

## How it's organised

```
src/bot/platforms/meet.ts    Meet adapter: join flow, end/alone detection, names
src/bot/platforms/zoom.ts    Zoom adapter: link → web client, passcode, computer audio, waiting room
src/bot/platforms/index.ts   detectPlatform(url) picks the adapter
src/bot/recorder.ts          shared: launch browser, inject hook, record, watch for the end
src/bot/audio-capture.js     the in-page audio hook
src/pipeline.ts              transcribe → summarize → save → Slack
```

To add another platform (Teams, Webex), write one more adapter that implements the `Platform` interface in `src/bot/platforms/types.ts`, and add its hostname to `detectPlatform`.

## How the audio capture works

`src/bot/audio-capture.js` runs in every frame before the meeting app's own scripts. It catches incoming audio two ways:

1. **WebRTC.** It wraps `RTCPeerConnection`, so every incoming audio track is mixed in. Meet delivers audio this way.
2. **WebAudio** (on for Zoom). It wraps `AudioNode.connect`, so anything the app sends to its speakers through an `AudioContext` is copied into a tap. This works no matter how Zoom decodes audio internally.

If the same speech arrives both ways, the WebRTC copy is muted while the tap has sound, so voices aren't doubled. The recorder runs in whichever frame actually holds the audio, since Zoom sometimes runs the meeting inside an iframe.

The mix is encoded as 32 kbps Opus and sent to Node every 5 seconds, so a crash only loses the last few seconds. The bot's own microphone is a looped silent WAV and is muted before joining. No PulseAudio or virtual sound card is needed.

### Tests

```bash
npm test                              # unit tests: transcript formatting, link parsing
npx tsx test/capture.integration.ts   # audio hook: WebRTC, WebAudio-in-iframe, no-doubling (needs ffmpeg)
```

## Known limits and next steps

- **The meeting UIs change.** Joining and end-of-call detection rely on button labels ("Join now", "Leave call", "Join Audio by Computer", "Leave") and similar markers. When Google or Zoom changes them, update the selectors in that platform's adapter file. This is the main maintenance cost of a self-built bot.
- **English UI only** for now, because selectors match English labels. Set the bot accounts' language to English.
- **Speaker names** are "Speaker 1, 2…" from diarization. Claude replaces them with real names only when the conversation makes it obvious.
- **Calendar auto-join** isn't built yet. The natural next step is to poll the bot account's calendar and call `runMeeting()` a minute before each event that has a Meet or Zoom link.
- **Zoom's official route.** Zoom expects bots to use its Meeting SDK, which requires registering an app with Zoom. The web-client approach here needs no approval but is less officially supported. If you ever ship this to customers, move the Zoom adapter to the Meeting SDK.
- **Consent and terms.** The bot shows up as a visible participant, but tell your team it records, and say so in any meeting with outside guests. Recording-consent laws vary by state and country. Automated joining may also conflict with Google's and Zoom's terms, so use it for your own team's meetings.
