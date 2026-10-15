// Writes meeting notes from a transcript using a Fireworks-hosted model
// (OpenAI-compatible chat completions API). Pick the model with FIREWORKS_MODEL.
import { config } from './config.js';

const FIREWORKS_URL = 'https://api.fireworks.ai/inference/v1/chat/completions';

export const SYSTEM = `You write meeting notes for a small startup team.
The transcript comes from automatic speech recognition with generic speaker labels ("Speaker 1", "Speaker 2").
Only replace a label with a real name when the transcript makes it clear (someone is addressed by name, introduces themselves, etc.); otherwise keep the label.
Be concrete and brief. Never invent decisions, owners or dates that are not in the transcript.

Return Markdown only, with no preamble. The first line is "# " followed by a 3–7 word title saying what the meeting was about (e.g. "# Q4 launch plan and hiring"), not the date or platform.
Then exactly these sections:
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

/**
 * Some models (reasoning models in particular) put their thinking inline as <think>…</think>
 * or wrap the answer in a ```markdown fence. Keep only the notes.
 */
export function cleanModelOutput(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  out = out.replace(/^[\s\S]*?<\/think>/i, ''); // closing tag without an opening one
  out = out.replace(/<think>[\s\S]*$/i, ''); // thinking that never finished (hit the token limit)
  const fenced = out.match(/^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fenced) out = fenced[1];
  // Drop any chatter before the "# Title" line.
  const start = out.search(/^#\s+\S/m);
  if (start > 0) out = out.slice(start);
  return out.trim();
}

export async function summarize(transcript: string, meta: { participants: string[]; startedAt: Date; durationMin: number }) {
  if (!config.fireworksKey) throw new Error('FIREWORKS_API_KEY is not set.');

  const header = [
    `Meeting date: ${meta.startedAt.toISOString().slice(0, 10)}`,
    `Duration: about ${meta.durationMin} minutes`,
    meta.participants.length ? `Names seen on screen: ${meta.participants.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  const res = await fetch(FIREWORKS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.fireworksKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model: config.fireworksModel,
      // Room for reasoning models to think before writing ~1–2k tokens of notes.
      max_tokens: 12000,
      temperature: 0.2, // stick close to what was said
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `${header}\n\n<transcript>\n${transcript}\n</transcript>` },
      ],
    }),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 500);
    throw new Error(`Fireworks ${res.status} for model ${config.fireworksModel}: ${detail}`);
  }
  const json: any = await res.json();
  const choice = json.choices?.[0];
  const notes = cleanModelOutput(String(choice?.message?.content ?? ''));
  if (!notes) {
    const why = choice?.finish_reason === 'length' ? ' (the model ran out of tokens; try a non-reasoning model)' : '';
    throw new Error(`Fireworks returned empty notes${why}.`);
  }
  return notes;
}
