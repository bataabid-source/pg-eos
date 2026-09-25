// WBS 1.9 — Finance tab (Master decision 4): creditLimit, creditHold, holdReason — exactly what
// WBS 1.8 already computes, no new figure. Amount formatted via Money (packages/domain-kit, named
// in the brief's Read list) — numeric(14,3) precision, never Number()/parseFloat() (fix round 1,
// finding 6).
import { Money } from '@pg-eos/domain-kit';

import type { Locale } from '../../i18n/t';
import { t } from '../../i18n/t';
import type { CustomerProfileFinance } from './contract';

export interface FinanceTabProps {
  finance: CustomerProfileFinance;
  locale: Locale;
}

// pg-reviewer round 2, finding R3: no local CURRENCY_CODE constant — Money.of(value).currency is
// the one source of truth for the currency code (packages/domain-kit/money.ts), never duplicated.
function formatCreditLimit(value: string | null, locale: Locale): string {
  if (value === null) {
    return t(locale, 'customer360.finance.creditLimit.notSet');
  }
  const amount = Money.of(value);
  return `${amount.toString()} ${amount.currency}`;
}

export function FinanceTab({ finance, locale }: FinanceTabProps) {
  return (
    <div
      role="tabpanel"
      id="tab-panel-finance"
      data-testid="tab-panel-finance"
      className="flex flex-col gap-2 p-4 text-sm"
    >
      <p data-testid="finance-credit-limit">
        {t(locale, 'customer360.finance.creditLimit', { amount: formatCreditLimit(finance.creditLimit, locale) })}
      </p>
      <p data-testid="finance-credit-hold">
        {t(
          locale,
          finance.creditHold ? 'customer360.finance.creditHold.active' : 'customer360.finance.creditHold.clear',
        )}
      </p>
      {finance.creditHold ? (
        <p data-testid="finance-hold-reason">
          {t(locale, 'customer360.finance.holdReason', { reason: finance.holdReason ?? '' })}
        </p>
      ) : null}
    </div>
  );
}
