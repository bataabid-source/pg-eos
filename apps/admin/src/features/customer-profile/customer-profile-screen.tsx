// WBS 1.9 — Customer 360 screen (doc 40 §D1 "profile" pattern, Master decision 8): an identity
// header strip + a "what's missing before go-live" readiness bar (always visible, above the tabs,
// not inside one) + Contracts/Finance/Profitability tabs (no audit tab, per brief Scope).
import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';

import type { Locale, TranslationKey } from '../../i18n/t';
import { SUPPORTED_LOCALES, directionOf, isLocale, t } from '../../i18n/t';
import { ReadinessChecklist } from '../../components/readiness-checklist';
import type { ReadinessItem as ReadinessRow } from '../../components/readiness-checklist';
import { EmptyState } from '../../components/empty-state';
import { ContractsTab } from './contracts-tab';
import { FinanceTab } from './finance-tab';
import { ProfitabilityTab } from './profitability-tab';
import { IdentityHeader } from './identity-header';
import type { CustomerProfileClient } from './mock-client';
import { CUSTOMER_PROFILE_QUERY_KEY, CUSTOMER_PROFILE_TABS, DEFAULT_CUSTOMER_PROFILE_TAB } from './constants';
import type { CustomerProfileTab } from './constants';
import type { ReadinessItemCode } from './contract';

export interface CustomerProfileScreenProps {
  client: CustomerProfileClient;
  accountId: string;
  // Controlled locale (same convention as DecisionInboxScreen — router.tsx's AppShell owns the
  // state when this screen is mounted under the shell).
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

const READINESS_ITEM_LABEL_KEY: Record<ReadinessItemCode, TranslationKey> = {
  cr_number: 'customer360.readiness.item.cr_number',
  credit_limit: 'customer360.readiness.item.credit_limit',
  segment: 'customer360.readiness.item.segment',
  payment_terms: 'customer360.readiness.item.payment_terms',
  priced_contract: 'customer360.readiness.item.priced_contract',
};

const TAB_LABEL_KEY: Record<CustomerProfileTab, TranslationKey> = {
  contracts: 'customer360.tabs.contracts',
  finance: 'customer360.tabs.finance',
  profitability: 'customer360.tabs.profitability',
};

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function ProfileContent({ client, accountId, locale: controlledLocale, onLocaleChange }: CustomerProfileScreenProps) {
  const [uncontrolledLocale, setUncontrolledLocale] = useState<Locale>('ar');
  const locale = controlledLocale ?? uncontrolledLocale;
  const setLocale = onLocaleChange ?? setUncontrolledLocale;
  const [activeTab, setActiveTab] = useState<CustomerProfileTab>(DEFAULT_CUSTOMER_PROFILE_TAB);

  useEffect(() => {
    document.documentElement.dir = directionOf(locale);
    document.documentElement.lang = locale;
  }, [locale]);

  const { data, isPending, isError } = useQuery({
    queryKey: [CUSTOMER_PROFILE_QUERY_KEY, accountId],
    queryFn: () => client.getCustomerProfile(accountId),
  });

  const readinessRows: ReadinessRow[] = useMemo(() => {
    if (!data) {
      return [];
    }
    return data.readiness.map((fact) => ({
      item: fact.item,
      label: t(locale, READINESS_ITEM_LABEL_KEY[fact.item]),
      status: t(locale, fact.present ? 'customer360.readiness.status.present' : 'customer360.readiness.status.missing'),
      present: fact.present,
      owner: t(locale, 'customer360.readiness.owner', { owner: fact.owner }),
    }));
  }, [data, locale]);

  return (
    <div dir={directionOf(locale)} lang={locale}>
      <header className="flex items-center justify-between gap-4 border-b border-border p-4">
        <h2 className="text-base font-semibold">{t(locale, 'customer360.readiness.title')}</h2>
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

      {isPending ? (
        <p data-testid="customer-profile-loading" className="p-4 text-sm text-muted-foreground">
          {t(locale, 'customer360.loading')}
        </p>
      ) : isError || !data ? (
        <EmptyState
          title={t(locale, 'customer360.error.title')}
          missing={t(locale, 'customer360.error.missing')}
          owner={t(locale, 'customer360.error.owner')}
        />
      ) : (
        <>
          <IdentityHeader identity={data.identity} locale={locale} />

          <ReadinessChecklist items={readinessRows} allClearLabel={t(locale, 'customer360.readiness.allClear')} />

          <div role="tablist" className="flex gap-2 border-b border-border p-4">
            {CUSTOMER_PROFILE_TABS.map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                data-testid={`${tab}-tab`}
                aria-selected={activeTab === tab}
                onClick={() => setActiveTab(tab)}
              >
                {t(locale, TAB_LABEL_KEY[tab])}
              </button>
            ))}
          </div>

          {activeTab === 'contracts' ? <ContractsTab contracts={data.contracts} locale={locale} /> : null}
          {activeTab === 'finance' ? <FinanceTab finance={data.finance} locale={locale} /> : null}
          {activeTab === 'profitability' ? <ProfitabilityTab locale={locale} /> : null}
        </>
      )}
    </div>
  );
}

export function CustomerProfileScreen(props: CustomerProfileScreenProps) {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <ProfileContent {...props} />
    </QueryClientProvider>
  );
}
