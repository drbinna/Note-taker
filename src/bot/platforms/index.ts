import { meet } from './meet.js';
import { zoom } from './zoom.js';
import type { Platform } from './types.js';

export type { Platform, CaptureMode, JoinOptions } from './types.js';

/** Picks the adapter for a meeting link, or null if it isn't a supported platform. */
export function detectPlatform(url: string): Platform | null {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  if (host === 'meet.google.com') return meet;
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) return zoom;
  return null;
}
