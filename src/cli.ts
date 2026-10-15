import { runMeeting, processAudio } from './pipeline.js';
import { detectPlatform } from './bot/platforms/index.js';

const [cmd, arg, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

async function main() {
  if (cmd === 'join' && arg) {
    if (!detectPlatform(arg)) throw new Error(`Not a Google Meet or Zoom link: ${arg}`);
    return void (await runMeeting(arg, { passcode: flag('passcode') }));
  }
  if (cmd === 'process' && arg) return void (await processAudio(arg));
  console.log(`Usage:
  npm run join -- https://meet.google.com/abc-defg-hij             join, record, summarize
  npm run join -- "https://zoom.us/j/1234567890?pwd=..."           same, for Zoom
  npm run join -- https://zoom.us/j/1234567890 --passcode 123456   Zoom link without pwd=
  npm run process -- meetings/<folder>/audio.webm                  re-run transcription + summary`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
