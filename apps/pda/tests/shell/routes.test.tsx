// WBS 2.16 part 1a — RED tests for the PDA shell's nine routes + "/" -> "/home" redirect.
//
// Master decision 1 (brief): nine routes, one shared PlaceholderScreen component per route,
// parameterized by an i18n key for its own title. `createRouter(initialPath)` follows
// apps/admin/src/router.tsx's own exported pattern verbatim (createMemoryHistory for tests).
//
// Required test hooks this file assumes pg-frontend implements (documented per apps/admin's own
// precedent, since pg-tester does not write router.tsx / placeholder-screen.tsx):
//   - `createRouter(initialPath?)` exported from '../../src/router', same signature as
//     apps/admin/src/router.tsx (createBrowserHistory when omitted, createMemoryHistory otherwise).
//   - nine routes at the exact path segments named in the brief's Master decision 1.
//   - each route renders PlaceholderScreen with the screen's own i18n title key so that
//     `t('ar', 'screen.<name>')` appears as visible text.
//   - the root route's own component sets `document.documentElement.dir` to the locale's
//     direction on mount (Master decision 4: `ar` default -> 'rtl').

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from '@tanstack/react-router';

import { createRouter } from '../../src/router';
import { t, SUPPORTED_LOCALES, directionOf, type Locale } from '../../src/i18n/t';

// One row per D4 screen (brief Master decision 1) — path segment + its own i18n title key.
const ROUTES: ReadonlyArray<{ path: string; key: Parameters<typeof t>[1] }> = [
  { path: '/home', key: 'screen.home' },
  { path: '/receive', key: 'screen.receive' },
  { path: '/put-away', key: 'screen.putAway' },
  { path: '/pick', key: 'screen.pick' },
  { path: '/check', key: 'screen.check' },
  { path: '/load', key: 'screen.load' },
  { path: '/count', key: 'screen.count' },
  { path: '/transfer-return', key: 'screen.transferReturn' },
  { path: '/lookup', key: 'screen.lookup' },
];

describe('PDA shell routing — nine D4 screens', () => {
  for (const { path, key } of ROUTES) {
    it(`renders its own screen title at "${path}"`, async () => {
      const router = createRouter(path);
      render(<RouterProvider router={router} />);

      expect(await screen.findByText(t('ar', key))).toBeVisible();
    });
  }

  it('every route renders a DIFFERENT title from every other route (no accidental sharing of one key)', async () => {
    const renderedTitles = new Set<string>();
    for (const { path, key } of ROUTES) {
      const router = createRouter(path);
      const { unmount } = render(<RouterProvider router={router} />);
      const expectedTitle = t('ar', key);
      expect(await screen.findByText(expectedTitle)).toBeVisible();
      renderedTitles.add(expectedTitle);
      unmount();
    }
    expect(renderedTitles.size).toBe(ROUTES.length);
  });

  it('"/" redirects to "/home" and renders the same title', async () => {
    const rootRouter = createRouter('/');
    const { unmount } = render(<RouterProvider router={rootRouter} />);
    expect(await screen.findByText(t('ar', 'screen.home'))).toBeVisible();
    unmount();

    const homeRouter = createRouter('/home');
    render(<RouterProvider router={homeRouter} />);
    expect(await screen.findByText(t('ar', 'screen.home'))).toBeVisible();
  });

  it('defaults to Arabic ("ar") with dir="rtl" on the document root once the shell mounts', async () => {
    render(<RouterProvider router={createRouter('/home')} />);
    expect(await screen.findByText(t('ar', 'screen.home'))).toBeVisible();
    expect(document.documentElement.dir).toBe('rtl');
  });

  // Round-1 review finding 1 (test half): a genuine locale-switching test — render the shell,
  // find the locale selector, change it to each non-default locale in turn, and assert BOTH
  // `document.documentElement.dir` AND `document.documentElement.lang` update correctly, AND that
  // the currently-rendered screen's own title text changes to that locale's own translation
  // (proving the switch re-renders the routed screen, not just the shell chrome).
  describe('locale switching via the shell\'s own selector', () => {
    const NON_DEFAULT_LOCALES = SUPPORTED_LOCALES.filter((locale) => locale !== 'ar');

    it.each(NON_DEFAULT_LOCALES)(
      'switching to "%s" updates dir, lang, and the rendered screen title',
      async (locale: Locale) => {
        const user = userEvent.setup();
        render(<RouterProvider router={createRouter('/home')} />);

        // Starting state: ar / rtl / Arabic title.
        expect(await screen.findByText(t('ar', 'screen.home'))).toBeVisible();
        expect(document.documentElement.dir).toBe('rtl');
        expect(document.documentElement.lang).toBe('ar');

        const select = screen.getByTestId('locale-select');
        await user.selectOptions(select, locale);

        expect(document.documentElement.dir).toBe(directionOf(locale));
        expect(document.documentElement.lang).toBe(locale);
        expect(await screen.findByText(t(locale, 'screen.home'))).toBeVisible();
      },
    );
  });
});
