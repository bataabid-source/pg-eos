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
  useParams,
} from '@tanstack/react-router';

import { DecisionInboxScreen } from './features/decision-inbox/decision-inbox-screen';
import { mockClient } from './features/decision-inbox/mock-client';
import { CustomerProfileScreen } from './features/customer-profile/customer-profile-screen';
import { mockClient as customerProfileMockClient } from './features/customer-profile/mock-client';
import { DEMO_ACCOUNT_ID } from './features/customer-profile/constants';
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
            <Link
              to="/customers/$accountId"
              params={{ accountId: DEMO_ACCOUNT_ID }}
              activeProps={{ 'aria-current': 'page' }}
            >
              {t(locale, 'nav.customer360')}
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

// Fix round 1, finding 11: the URL's `:accountId` was previously ignored — the screen always
// loaded `DEMO_ACCOUNT_ID` regardless of what the route matched. `useParams({ strict: false })`
// reads the actual matched param (works regardless of declaration order against the route object
// below); `DEMO_ACCOUNT_ID` remains only the DEFENSIVE fallback for a genuinely empty param, which
// the route's own path segment should never produce — no customer search/list exists this slice
// (Master decision 9), so in practice this is always the one demo account the fixed nav link
// targets, but the plumbing now honors the URL rather than hard-coding it.
function CustomerProfileRouteComponent() {
  const { locale, setLocale } = useContext(LocaleContext);
  const params = useParams({ strict: false });
  const accountId = params.accountId ?? DEMO_ACCOUNT_ID;
  return (
    <CustomerProfileScreen
      client={customerProfileMockClient}
      accountId={accountId}
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

const customerProfileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/customers/$accountId',
  component: CustomerProfileRouteComponent,
});

const routeTree = rootRoute.addChildren([indexRoute, inboxRoute, customerProfileRoute]);

// `initialPath` drives an in-memory history (tests, no real browser navigation); omitted, the
// real app uses the actual browser history so the URL bar stays in sync.
export function createRouter(initialPath?: string) {
  const history =
    initialPath === undefined
      ? createBrowserHistory()
      : createMemoryHistory({ initialEntries: [initialPath] });

  return createTanstackRouter({ routeTree, history });
}
