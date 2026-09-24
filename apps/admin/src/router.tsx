// WBS 0.19 — the one route this shell needs: "/inbox", with "/" redirecting to it (Master
// decision 7 — "the inbox IS the home page", doc 29 §6-2). `createRouter(initialPath)` is
// exported so tests can drive navigation without a real browser history (createMemoryHistory).
import { createContext, useContext, useState } from 'react';
import {
  Link,
  Outlet,
  createBrowserHistory,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter as createTanstackRouter,
  redirect,
} from '@tanstack/react-router';

import { DecisionInboxScreen } from './features/decision-inbox/decision-inbox-screen';
import { mockClient } from './features/decision-inbox/mock-client';
import type { Locale } from './i18n/t';
import { t } from './i18n/t';

// No session/login exists yet (0.17 deferred) — the role the inbox is filtered by has no other
// source until then (brief scope default, Master decision 4). 'SYSADMIN' is a seeded role code
// (13B:546ff) and this task's own WBS owner — 'operations' is not a seeded platform role.
export const DEFAULT_ROLE = 'SYSADMIN';

// Shared locale (fix round 2, finding 2): the shell's own strings (app name, nav label) and
// DecisionInboxScreen's selector must read/write ONE locale value — otherwise switching locale in
// the screen leaves the shell's chrome in Arabic. AppShell owns the state; the /inbox route reads
// it via this context and passes it to DecisionInboxScreen as a controlled `locale`/`onLocaleChange`.
interface LocaleState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}
// Default value is only a type-safety fallback — AppShell (below) always provides a real one via
// LocaleContext.Provider before InboxRouteComponent ever renders.
const LocaleContext = createContext<LocaleState>({ locale: 'ar', setLocale: () => undefined });

function useShellLocale(): LocaleState {
  const [locale, setLocale] = useState<Locale>('ar');
  return { locale, setLocale };
}

// Minimal nav shell (brief scope default: "no other admin screens exist yet to link to") — app
// name + a static "Decision Inbox" nav item, `aria-current="page"` when it is the active route
// (fix round 1, finding 5). The root route's own component, so `Link`'s active-match state is
// available without a circular import against App.tsx.
function AppShell() {
  const shellLocale = useShellLocale();
  const { locale } = shellLocale;

  return (
    <LocaleContext.Provider value={shellLocale}>
      <div>
        <header className="flex items-center gap-6 border-b border-border bg-card px-4 py-2">
          <span className="text-base font-bold">{t(locale, 'app.name')}</span>
          <nav>
            <Link to="/inbox" activeProps={{ 'aria-current': 'page' }}>
              {t(locale, 'nav.inbox')}
            </Link>
          </nav>
        </header>
        <div>
          <Outlet />
        </div>
      </div>
    </LocaleContext.Provider>
  );
}

function InboxRouteComponent() {
  const { locale, setLocale } = useContext(LocaleContext);
  return (
    <DecisionInboxScreen
      client={mockClient}
      role={DEFAULT_ROLE}
      locale={locale}
      onLocaleChange={setLocale}
    />
  );
}

const rootRoute = createRootRoute({
  component: AppShell,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/inbox' });
  },
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox',
  component: InboxRouteComponent,
});

const routeTree = rootRoute.addChildren([indexRoute, inboxRoute]);

// `initialPath` drives an in-memory history (tests, no real browser navigation); omitted, the
// real app uses the actual browser history so the URL bar stays in sync.
export function createRouter(initialPath?: string) {
  const history =
    initialPath === undefined
      ? createBrowserHistory()
      : createMemoryHistory({ initialEntries: [initialPath] });

  return createTanstackRouter({ routeTree, history });
}
