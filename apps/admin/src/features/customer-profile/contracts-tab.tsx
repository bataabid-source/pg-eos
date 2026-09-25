// WBS 1.9 — Contracts tab (Master decision 3): every contract, across every entity, its
// price-list status. `status` is one of the seven values the DDL's own comment names
// (database/schema/01-Data-Model.sql: "draft · signed · active · suspended · expired · renewed ·
// terminated", sales.contracts) — translated, never rendered as the raw DB code (fix round 1,
// finding 9). A zero-contracts account shows EmptyState, not a blank panel (fix round 1, finding 10).
import { Card, CardContent } from '../../components/ui/card';
import { EmptyState } from '../../components/empty-state';
import type { Locale, TranslationKey } from '../../i18n/t';
import { t } from '../../i18n/t';
import type { CustomerProfileContract } from './contract';

export interface ContractsTabProps {
  contracts: CustomerProfileContract[];
  locale: Locale;
}

const CONTRACT_STATUS_KEY: Record<string, TranslationKey> = {
  draft: 'customer360.contracts.status.draft',
  signed: 'customer360.contracts.status.signed',
  active: 'customer360.contracts.status.active',
  suspended: 'customer360.contracts.status.suspended',
  expired: 'customer360.contracts.status.expired',
  renewed: 'customer360.contracts.status.renewed',
  terminated: 'customer360.contracts.status.terminated',
};

function statusLabel(status: string, locale: Locale): string {
  const key = CONTRACT_STATUS_KEY[status];
  // `status` is `text` in the DDL, not a CHECK-constrained enum — an unrecognized future value
  // falls back to the raw code rather than throwing (never a fabricated translation).
  return key ? t(locale, key) : status;
}

export function ContractsTab({ contracts, locale }: ContractsTabProps) {
  if (contracts.length === 0) {
    return (
      <div role="tabpanel" id="tab-panel-contracts" data-testid="tab-panel-contracts" className="p-4">
        <EmptyState
          title={t(locale, 'customer360.contracts.empty.title')}
          missing={t(locale, 'customer360.contracts.empty.missing')}
          owner={t(locale, 'customer360.contracts.empty.owner')}
        />
      </div>
    );
  }

  return (
    <div
      role="tabpanel"
      id="tab-panel-contracts"
      data-testid="tab-panel-contracts"
      className="flex flex-col gap-2 p-4"
    >
      {contracts.map((contract) => (
        <Card key={contract.contractId} data-testid="contract-row" data-contract-id={contract.contractId}>
          <CardContent className="flex items-center justify-between gap-4 text-sm">
            <span>{contract.entityCode}</span>
            <span>{statusLabel(contract.status, locale)}</span>
            <span>{contract.startDate}</span>
            <span>
              {contract.endDate !== null
                ? t(locale, 'customer360.contracts.endDate', { date: contract.endDate })
                : t(locale, 'customer360.contracts.endDate.none')}
            </span>
            <span>
              {contract.hasPriceList
                ? t(locale, 'customer360.contracts.hasPriceList')
                : t(locale, 'customer360.contracts.noPriceList')}
            </span>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
