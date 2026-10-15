import type { Locator, Page } from 'playwright';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const log = (...a: unknown[]) => console.log(new Date().toISOString(), '[bot]', ...a);

export async function clickIfVisible(locator: Locator, timeout = 1500): Promise<boolean> {
  try {
    await locator.first().waitFor({ state: 'visible', timeout });
    await locator.first().click();
    return true;
  } catch {
    return false;
  }
}

/** True if any frame on the page shows text matching the pattern. */
export async function anyFrameHasText(page: Page, pattern: RegExp): Promise<boolean> {
  for (const frame of page.frames()) {
    if (await frame.getByText(pattern).first().isVisible().catch(() => false)) return true;
  }
  return false;
}
