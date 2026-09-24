// WBS 0.19 — Decision Inbox screen (doc 40 §D1: "home for every role"). Renders its own header,
// locale selector and content region — no separate App chrome (pg-tester's documented design
// choice, decision-inbox.test.tsx header comment #2).
import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Money } from '@pg-eos/domain-kit';

import { EmptyState } from '../../components/empty-state';
import type { Locale, TranslationKey } from '../../i18n/t';
import { SUPPORTED_LOCALES, directionOf, isLocale, t } from '../../i18n/t';
import type { DecisionsClient } from './client';
import { DECISION_INBOX_QUERY_KEY, UNKNOWN_URGENCY_RANK, URGENCY_RANK } from './constants';
import { DecisionCard } from './decision-card';
import type { DecisionItem } from './contract';

export interface DecisionInboxScreenProps {
  client: DecisionsClient;
  role: string;
  // Controlled locale (fix round 2, finding 2): when the screen is mounted under `AppShell`
  // (router.tsx), the shell owns the locale so its own nav strings re-render with the screen's
  // selector — pass `locale`/`onLocaleChange` in that case. Omitted (e.g. the component tests
  // that render `DecisionInboxScreen` directly with no shell), the screen manages its own state.
  locale?: Locale;
  onLocaleChange?: (locale: Locale) => void;
}

const LOCALE_LABEL_KEY: Record<Locale, TranslationKey> = {
  ar: 'locale.name.ar',
  en: 'locale.name.en',
  hi: 'locale.name.hi',
  ur: 'locale.name.ur',
  bn: 'locale.name.bn',
  am: 'locale.name.am',
};

function rankOf(urgency: string): number {
  return URGENCY_RANK[urgency] ?? UNKNOWN_URGENCY_RANK;
}

// financialImpact desc (nulls last), then fixed urgency rank (this brief's Master decision 5) —
// mirrors the DB index (assigned_role, status, urgency, financial_impact desc) client-side.
// Compared via Money (packages/domain-kit) — numeric(14,3) precision requires exact decimal
// comparison, never Number()/parseFloat(), which can silently lose or round digits.
function compareImpact(a: DecisionItem, b: DecisionItem): number {
  if (a.financialImpact === null && b.financialImpact === null) {
    return 0;
  }
  if (a.financialImpact === null) {
    return 1;
  }
  if (b.financialImpact === null) {
    return -1;
  }
  return -Money.of(a.financialImpact).compare(Money.of(b.financialImpact));
}

function sortDecisions(items: readonly DecisionItem[]): DecisionItem[] {
  return [...items].sort((a, b) => {
    const impactOrder = compareImpact(a, b);
    if (impactOrder !== 0) {
      return impactOrder;
    }
    return rankOf(a.urgency) - rankOf(b.urgency);
  });
}

// One QueryClient per screen instance — DecisionInboxScreen owns its own provider so it can be
// rendered directly in tests without an external wrapper (pg-tester's design choice).
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function InboxContent({
  client,
  role,
  locale: controlledLocale,
  onLocaleChange,
}: DecisionInboxScreenProps) {
  const [uncontrolledLocale, setUncontrolledLocale] = useState<Locale>('ar');
  const locale = controlledLocale ?? uncontrolledLocale;
  const setLocale = onLocaleChange ?? setUncontrolledLocale;

  useEffect(() => {
    document.documentElement.dir = directionOf(locale);
    document.documentElement.lang = locale;
  }, [locale]);

  const { data, isError, isPending } = useQuery({
    queryKey: [DECISION_INBOX_QUERY_KEY, role],
    queryFn: () => client.listOpenDecisions(role),
  });

  const items = useMemo(() => (data ? sortDecisions(data) : []), [data]);

  return (
    <div dir={directionOf(locale)} lang={locale}>
      <header className="flex items-center justify-between gap-4 border-b border-border p-4">
        <div>
          <h1 className="text-lg font-bold">{t(locale, 'inbox.header.title', { role })}</h1>
          {!isError && !isPending ? (
            <p className="text-sm text-muted-foreground">
              {t(locale, 'inbox.header.count', { n: items.length })}
            </p>
          ) : null}
        </div>
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
      </header>
      <main className="flex flex-col gap-4 p-4">
        {isPending ? null : isError ? (
          <EmptyState
            title={t(locale, 'inbox.error.title')}
            missing={t(locale, 'inbox.error.missing')}
            owner={t(locale, 'inbox.error.owner')}
          />
        ) : items.length === 0 ? (
          <EmptyState
            title={t(locale, 'inbox.empty.title')}
            missing={t(locale, 'inbox.empty.missing')}
            owner={t(locale, 'inbox.empty.owner', { role })}
          />
        ) : (
          items.map((item) => <DecisionCard key={item.id} item={item} locale={locale} />)
        )}
      </main>
    </div>
  );
}

export function DecisionInboxScreen(props: DecisionInboxScreenProps) {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <InboxContent {...props} />
    </QueryClientProvider>
  );
}
