import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

const SYSTEM = `You write meeting notes for a small startup team.
The transcript comes from automatic speech recognition with generic speaker labels ("Speaker 1", "Speaker 2").
Only replace a label with a real name when the transcript makes it clear (someone is addressed by name, introduces themselves, etc.); otherwise keep the label.
Be concrete and brief. Never invent decisions, owners or dates that are not in the transcript.

Return Markdown with exactly these sections:
## TL;DR
2–4 sentences.
## Decisions
Bullets. "None recorded." if there are none.
## Action items
"- [ ] Owner: task (due date if stated)". "None recorded." if there are none.
## Open questions
Bullets, or "None."
## Discussion notes
Short bullets grouped by topic, with [hh:mm:ss] timestamps for key moments.`;

export async function summarize(transcript: string, meta: { participants: string[]; startedAt: Date; durationMin: number }) {
  if (!config.anthropicKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  const client = new Anthropic({ apiKey: config.anthropicKey });

  const header = [
    `Meeting date: ${meta.startedAt.toISOString().slice(0, 10)}`,
    `Duration: about ${meta.durationMin} minutes`,
    meta.participants.length ? `Names seen on screen: ${meta.participants.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  const msg = await client.messages.create({
    model: config.claudeModel,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: 'user', content: `${header}\n\n<transcript>\n${transcript}\n</transcript>` }],
  });

  return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
}
