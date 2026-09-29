// tests/scenarios/pda/shell.spec.ts — X part 5e, project `pda` (page fixture, baseURL = the Vite dev
// server). router.tsx has no redirect to /login, so the spec goes straight to it. Elements are located
// by role only (lane 1 is changing these screens); no copy text is asserted.

import { expect, test } from '@playwright/test';

const LOGIN_PATH = '/login';
const EXPECTED_DIR = 'rtl';
const SUPPORTED_LOCALES = ['ar', 'en', 'hi', 'ur', 'bn', 'am'];
const ROLE_TEXTBOX = 'textbox';
const ROLE_BUTTON = 'button';

test.describe('PDA login screen', () => {
  test('the PDA login screen loads in Chromium with dir rtl and one of the six locales as lang', async ({
    page,
  }) => {
    await page.goto(LOGIN_PATH);

    const html = page.locator('html');
    await expect(html).toHaveAttribute('dir', EXPECTED_DIR);
    const lang = await html.getAttribute('lang');
    expect(SUPPORTED_LOCALES).toContain(lang);

    await expect(page.getByRole(ROLE_TEXTBOX).first()).toBeVisible();
    await expect(page.getByRole(ROLE_BUTTON).first()).toBeVisible();
  });
});
