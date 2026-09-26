// WBS 2.16 part 1a — the PDA shell's nine D4-screen routes + "/" -> "/home" redirect (brief
// Master decision 1), following apps/admin/src/router.tsx's own exported pattern verbatim
// (createRouter(initialPath) for test-friendly createMemoryHistory).
import { createContext, useContext, useEffect, useState } from 'react';
import {
  Outlet,
  createBrowserHistory,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter as createTanstackRouter,
  redirect,
  useNavigate,
} from '@tanstack/react-router';

import { PlaceholderScreen } from './features/placeholder-screen/placeholder-screen';
import { mockClient } from './features/otp-login/mock-client';
import { OtpLoginScreen } from './features/otp-login/otp-login-screen';
import {
  isFullscreenActive,
  registerContextMenuSuppression,
  registerFullscreenChange,
  requestKioskFullscreen,
} from './kiosk';
import { count as countQueue, queueStatus, subscribe as subscribeQueue } from './offline-queue';
import type { Locale, TranslationKey } from './i18n/t';
import { SUPPORTED_LOCALES, directionOf, isLocale, t } from './i18n/t';

// Shared locale, same pattern as apps/admin's own AppShell: the shell owns the single locale
// value, default 'ar' (Master decision 4 — no persisted locale preference this part).
interface LocaleState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}
const LocaleContext = createContext<LocaleState>({ locale: 'ar', setLocale: () => undefined });

function useShellLocale(): LocaleState {
  const [locale, setLocale] = useState<Locale>('ar');
  return { locale, setLocale };
}

const LOCALE_LABEL_KEY: Record<Locale, TranslationKey> = {
  ar: 'locale.name.ar',
  en: 'locale.name.en',
  hi: 'locale.name.hi',
  ur: 'locale.name.ur',
  bn: 'locale.name.bn',
  am: 'locale.name.am',
};

// fix round 1, finding 1: `data-queue-status` alone is not visible to a warehouse worker looking
// at the device — the badge needs an actual rendered colour. `'error'` (finding 2) is a fourth,
// visually distinct state for an IndexedDB failure, never returned by the pure `queueStatus()`
// (which only ever returns green/yellow/red, per its own doc 40 §D4 contract).
const QUEUE_STATUS_COLOR: Record<ReturnType<typeof queueStatus> | 'error', string> = {
  green: '#0a0',
  yellow: '#c90',
  red: '#c00',
  error: '#666',
};

function AppShell() {
  const shellLocale = useShellLocale();
  const { locale, setLocale } = shellLocale;
  // fix round 1, finding 4a: the "Enter kiosk mode" button is one-time — hidden once fullscreen
  // is active, shown again if fullscreen is exited (Esc, etc.), via a `fullscreenchange` listener.
  const [fullscreenActive, setFullscreenActive] = useState<boolean>(false);

  // Unsynced-queue badge (WBS 2.16 part 1a-2, brief scope "Unsynced counter" + Master decision 2):
  // initial count on mount, then re-fetched on every `offline-queue.ts` `subscribe()` change.
  const [unsyncedCount, setUnsyncedCount] = useState<number>(0);
  // fix round 1, finding 2: a distinct visual state for an IndexedDB failure (unavailable/blocked/
  // quota-exceeded) — the badge must not misreport "green/0" (all synced) when it actually could
  // not read the queue at all.
  const [queueReadFailed, setQueueReadFailed] = useState<boolean>(false);

  // Reactive dir/lang attributes on the document root (Master decision 4, fix round 1 finding 2:
  // BOTH dir and lang must be overridden at runtime, same as apps/admin's own precedent).
  useEffect(() => {
    document.documentElement.dir = directionOf(locale);
    document.documentElement.lang = locale;
  }, [locale]);

  // Context-menu suppression registered once on mount, removed on unmount (Master decision 2).
  useEffect(() => {
    return registerContextMenuSuppression();
  }, []);

  useEffect(() => {
    setFullscreenActive(isFullscreenActive());
    return registerFullscreenChange(setFullscreenActive);
  }, []);

  useEffect(() => {
    let cancelled = false;
    function refreshCount(): void {
      countQueue()
        .then((total) => {
          if (!cancelled) {
            setUnsyncedCount(total);
            setQueueReadFailed(false);
          }
        })
        .catch(() => {
          // `count()` only rejects on a genuine IndexedDB failure (unavailable in this browsing
          // context, blocked by another tab holding an upgrade lock, quota exceeded, etc.) — an
          // empty store resolves to 0 without throwing, it never lands here. Surface a distinct
          // visual state (finding 2) instead of silently keeping the last-known count, which would
          // misreport "green/0" (fully synced) while the real count is unknown.
          if (!cancelled) {
            setQueueReadFailed(true);
          }
        });
    }
    refreshCount();
    const unsubscribe = subscribeQueue(refreshCount);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return (
    <LocaleContext.Provider value={shellLocale}>
      <div>
        <header>
          <span>{t(locale, 'app.name')}</span>
          <label>
            <span className="sr-only">{t(locale, 'locale.select.label')}</span>
            <select
              data-testid="locale-select"
              value={locale}
              onChange={(event) => {
                const { value } = event.target;
                if (isLocale(value)) {
                  setLocale(value);
                }
              }}
            >
              {SUPPORTED_LOCALES.map((code) => (
                <option key={code} value={code}>
                  {t(locale, LOCALE_LABEL_KEY[code])}
                </option>
              ))}
            </select>
          </label>
          {fullscreenActive ? null : (
            <button type="button" onClick={requestKioskFullscreen}>
              {t(locale, 'kiosk.enter')}
            </button>
          )}
          <span
            data-testid="unsynced-queue-badge"
            data-queue-status={queueReadFailed ? 'error' : queueStatus(unsyncedCount)}
            style={{ color: QUEUE_STATUS_COLOR[queueReadFailed ? 'error' : queueStatus(unsyncedCount)] }}
          >
            {t(locale, 'queue.unsynced', { count: unsyncedCount })}
          </span>
        </header>
        <div>
          <Outlet />
        </div>
      </div>
    </LocaleContext.Provider>
  );
}

const rootRoute = createRootRoute({
  component: AppShell,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/home' });
  },
});

// One route per D4 screen (brief Master decision 1) — nine near-identical declarations sharing
// the same PlaceholderScreen component, parameterized by the screen's own i18n title key. Each
// reads the shell's own shared locale from LocaleContext (default 'ar').
function makePlaceholderRouteComponent(titleKey: Parameters<typeof PlaceholderScreen>[0]['titleKey']) {
  return function PlaceholderRouteComponent() {
    const { locale } = useContext(LocaleContext);
    return <PlaceholderScreen titleKey={titleKey} locale={locale} />;
  };
}

// WBS 2.16 part 1a-4 — the OTP login screen, wired with the mock client (no backend transport
// exists yet, same precedent as decision-inbox/platform). Master decision 1: this route is
// reachable and functional but does not gate the nine placeholder routes below — no session/shift
// concept exists yet to gate them with (recorded default, not a G-01).
function LoginRouteComponent() {
  const { locale } = useContext(LocaleContext);
  const navigate = useNavigate();
  return (
    <OtpLoginScreen
      client={mockClient}
      locale={locale}
      onLoginSuccess={() => {
        // Master decision 2: token/expiresAt are never persisted here — the screen already
        // discarded them once onLoginSuccess returns; only the navigation survives.
        void navigate({ to: '/home' });
      }}
    />
  );
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginRouteComponent,
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/home',
  component: makePlaceholderRouteComponent('screen.home'),
});

const receiveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/receive',
  component: makePlaceholderRouteComponent('screen.receive'),
});

const putAwayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/put-away',
  component: makePlaceholderRouteComponent('screen.putAway'),
});

const pickRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/pick',
  component: makePlaceholderRouteComponent('screen.pick'),
});

const checkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/check',
  component: makePlaceholderRouteComponent('screen.check'),
});

const loadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/load',
  component: makePlaceholderRouteComponent('screen.load'),
});

const countRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/count',
  component: makePlaceholderRouteComponent('screen.count'),
});

const transferReturnRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/transfer-return',
  component: makePlaceholderRouteComponent('screen.transferReturn'),
});

const lookupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/lookup',
  component: makePlaceholderRouteComponent('screen.lookup'),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  homeRoute,
  receiveRoute,
  putAwayRoute,
  pickRoute,
  checkRoute,
  loadRoute,
  countRoute,
  transferReturnRoute,
  lookupRoute,
]);

// `initialPath` drives an in-memory history (tests, no real browser navigation); omitted, the
// real app uses the actual browser history so the URL bar stays in sync.
export function createRouter(initialPath?: string) {
  const history =
    initialPath === undefined
      ? createBrowserHistory()
      : createMemoryHistory({ initialEntries: [initialPath] });

  return createTanstackRouter({ routeTree, history });
}
