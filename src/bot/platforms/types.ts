import type { Page } from 'playwright';

/** Which audio paths the in-page hook should listen to. */
export type CaptureMode = 'webrtc' | 'webrtc+webaudio';

export interface JoinOptions {
  /** Raw numeric passcode for Zoom meetings whose link has no pwd= token. */
  passcode?: string;
}

export interface Platform {
  name: 'meet' | 'zoom';
  captureMode: CaptureMode;
  /** URL the browser should actually open (e.g. Zoom's web client instead of the app launcher). */
  browserUrl(url: string): string;
  /** Short id used in folder names. */
  meetingId(url: string): string;
  /** Opens the pre-join screen, mutes, joins, and resolves once the bot is in the call. Throws if refused. */
  join(page: Page, url: string, opts: JoinOptions): Promise<void>;
  /** Called once after join (e.g. Zoom's "Join Audio by Computer"). */
  afterJoin?(page: Page): Promise<void>;
  inCall(page: Page): Promise<boolean>;
  /** True when nobody but the bot is left. */
  isAlone(page: Page): Promise<boolean>;
  participants(page: Page): Promise<string[]>;
  leave(page: Page): Promise<void>;
}
