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
import { render, screen } from '@testing-library/react';
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
});
