// WBS 1.9 — Profitability tab (Master decision 5): a literal placeholder, never a fabricated
// revenue/cost/margin figure.
import type { Locale } from '../../i18n/t';
import { t } from '../../i18n/t';

export interface ProfitabilityTabProps {
  locale: Locale;
}

export function ProfitabilityTab({ locale }: ProfitabilityTabProps) {
  return (
    <div
      role="tabpanel"
      id="tab-panel-profitability"
      data-testid="tab-panel-profitability"
      className="p-4 text-sm"
    >
      <p data-testid="profitability-placeholder">{t(locale, 'customer360.profitability.placeholder')}</p>
    </div>
  );
}
