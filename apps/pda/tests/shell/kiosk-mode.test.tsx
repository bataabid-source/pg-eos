// WBS 2.16 part 1a — RED tests for kiosk mode (brief Master decision 2).
//
// Covers: the "Enter kiosk mode" button (i18n key `kiosk.enter`) is rendered in the app shell;
// clicking it calls `document.documentElement.requestFullscreen()` (a user-gesture-gated call,
// never auto-invoked on mount — most browsers reject a bare `requestFullscreen()` from
// `useEffect`); a `contextmenu` event dispatched on `document` has its default action prevented
// (context-menu suppression, the "shared industrial device" hardening doc 40 names).
//
// `requestFullscreen` does not exist on jsdom's Element prototype by default, so it is stubbed
// with a spy before each test — this tests THIS APP'S OWN click-handler wiring (it calls the API),
// not the browser's actual fullscreen behavior, which jsdom cannot provide (brief's own carve-out:
// "if requestFullscreen cannot be meaningfully tested in jsdom ... skip only that specific
// sub-assertion" — here it CAN be tested via a spy, so it is not skipped).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from '@tanstack/react-router';

import { createRouter } from '../../src/router';
import { t } from '../../src/i18n/t';

describe('PDA shell — kiosk mode', () => {
  let requestFullscreenSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    requestFullscreenSpy = vi.fn().mockResolvedValue(undefined);
    // jsdom has no native Fullscreen API — stub the one element the button targets.
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      value: requestFullscreenSpy,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore to keep documentElement clean for other test files in the same run.
    delete (document.documentElement as unknown as Record<string, unknown>).requestFullscreen;
    // Restore `document.fullscreenElement` too (set by the fullscreenchange test below) — moved
    // here from inside the test body so it always runs, even if an assertion in that test throws
    // partway through, preventing state from leaking into later tests.
    delete (document as unknown as Record<string, unknown>).fullscreenElement;
  });

  it('renders a one-time "Enter kiosk mode" button in the app shell', async () => {
    render(<RouterProvider router={createRouter('/home')} />);

    expect(
      await screen.findByRole('button', { name: t('ar', 'kiosk.enter') }),
    ).toBeVisible();
  });

  it('does NOT call requestFullscreen on mount (must be user-gesture-gated, not auto-invoked)', async () => {
    render(<RouterProvider router={createRouter('/home')} />);
    await screen.findByRole('button', { name: t('ar', 'kiosk.enter') });

    expect(requestFullscreenSpy).not.toHaveBeenCalled();
  });

  it('clicking the "Enter kiosk mode" button calls document.documentElement.requestFullscreen()', async () => {
    const user = userEvent.setup();
    render(<RouterProvider router={createRouter('/home')} />);

    const button = await screen.findByRole('button', { name: t('ar', 'kiosk.enter') });
    await user.click(button);

    expect(requestFullscreenSpy).toHaveBeenCalledTimes(1);
  });

  it('suppresses the native context menu: a "contextmenu" event dispatched on document has its default action prevented', async () => {
    render(<RouterProvider router={createRouter('/home')} />);
    await screen.findByText(t('ar', 'screen.home'));

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('removes the "contextmenu" listener on unmount (no leaked global listener)', async () => {
    const { unmount } = render(<RouterProvider router={createRouter('/home')} />);
    await screen.findByText(t('ar', 'screen.home'));
    unmount();

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  // WBS 2.16 part 1a-2 — deferred kiosk-mode test-coverage gap (round-2 finding), added here
  // per the brief: two NEW tests appended after the five above, which are left untouched.

  it('hides the "Enter kiosk mode" button once fullscreenchange reports fullscreenElement, and reappears once it reports falsy again (Esc)', async () => {
    render(<RouterProvider router={createRouter('/home')} />);
    await screen.findByRole('button', { name: t('ar', 'kiosk.enter') });

    // Simulate the browser entering fullscreen: `kiosk.ts`'s `registerFullscreenChange` re-reads
    // `document.fullscreenElement` via `isFullscreenActive()` on every `fullscreenchange` event.
    Object.defineProperty(document, 'fullscreenElement', {
      value: document.documentElement,
      configurable: true,
    });
    document.dispatchEvent(new Event('fullscreenchange'));

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: t('ar', 'kiosk.enter') }),
      ).not.toBeInTheDocument();
    });

    // Simulate exiting fullscreen (Esc): fullscreenElement reports falsy again.
    Object.defineProperty(document, 'fullscreenElement', {
      value: null,
      configurable: true,
    });
    document.dispatchEvent(new Event('fullscreenchange'));

    expect(await screen.findByRole('button', { name: t('ar', 'kiosk.enter') })).toBeVisible();
  });

  it('swallows a rejected requestFullscreen() promise — no unhandled rejection, the button stays visible after the click', async () => {
    const rejectingSpy = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      value: rejectingSpy,
      configurable: true,
      writable: true,
    });

    const user = userEvent.setup();
    render(<RouterProvider router={createRouter('/home')} />);
    const button = await screen.findByRole('button', { name: t('ar', 'kiosk.enter') });

    await user.click(button);
    // Flush the microtask queue so a rejected promise's own `.catch()` (kiosk.ts's) has run
    // before the assertion — an unswallowed rejection would surface as an unhandled rejection
    // and fail this test run regardless of the assertions below.
    await Promise.resolve();
    await Promise.resolve();

    expect(rejectingSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: t('ar', 'kiosk.enter') })).toBeVisible();
  });
});
