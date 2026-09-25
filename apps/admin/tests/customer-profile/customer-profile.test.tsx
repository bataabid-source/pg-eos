// apps/admin/tests/customer-profile/customer-profile.test.tsx — WBS 1.9, UI track (lane 1).
//
// Component tests (Vitest + Testing Library), one `it` per scenario in the brief's UI-track
// Gherkin (8 scenarios, docs/notes/slice-briefs/_slice-1.9.brief.md). Pattern copied from
// apps/admin/tests/decision-inbox/decision-inbox.test.tsx (mockClient fixture, DOM test-id
// conventions, locale-switch-via-shared-context pattern from router.tsx).
//
// ============================================================================================
// EXACT NAMES THIS FILE BINDS TO (pg-frontend implements exactly these — brief instruction).
// ============================================================================================
//
// Components / exports:
//   apps/admin/src/features/customer-profile/customer-profile-screen.tsx
//     -> export function CustomerProfileScreen(props: CustomerProfileScreenProps)
//     CustomerProfileScreenProps { client: CustomerProfileClient; accountId: string;
//                                  locale?: Locale; onLocaleChange?: (locale: Locale) => void }
//   apps/admin/src/features/customer-profile/mock-client.ts
//     -> export const mockClient: CustomerProfileClient          (demo data, SOME gaps open)
//     -> export const readyMockClient: CustomerProfileClient     (demo data, ALL gaps closed)
//     -> export type CustomerProfileClient = { getCustomerProfile(accountId: string): Promise<CustomerProfileResult> }
//        [DEFAULT — no separate client.ts file: the Deliver list for this slice names no
//        client.ts (unlike decision-inbox's), so the port type lives in mock-client.ts, the one
//        file that needs to reference it, exactly mirroring decision-inbox's DecisionsClient shape
//        but without a dedicated file]
//   apps/admin/src/features/customer-profile/constants.ts
//     -> export const DEMO_ACCOUNT_ID: string                    (the fixed demo accountId, Master decision 9)
//   apps/admin/src/features/customer-profile/contract.ts
//     -> re-exports (does NOT redeclare) CustomerProfileResultSchema / CustomerProfileResult from
//        '@pg-eos/contracts/sales/customer-profile' (Master decision 7, literal)
//   apps/admin/src/components/readiness-checklist.tsx
//     -> export function ReadinessChecklist(props: { items: ReadinessItem[] })  [DEFAULT props shape]
//   apps/admin/src/router.tsx — extended with:
//     -> route "/customers/:accountId" rendering CustomerProfileScreen
//     -> one new nav <Link to="/customers/$accountId" params={{ accountId: DEMO_ACCOUNT_ID }}>
//        labeled t(locale, 'nav.customer360'), aria-current="page" when active (Master decision 9)
//
// DOM test-ids this file requires (pg-tester's own call, per brief instruction to be explicit):
//   identity-name, identity-code, identity-segment            (identity header strip)
//   readiness-checklist                                        (wrapper, always rendered)
//   readiness-item + data-item={item} + data-present={"true"|"false"}   (one per readiness item, 5 total)
//   readiness-status                                           (inside a readiness-item, pg-reviewer fix round 2 finding 5 —
//                                                                 visible translated present/missing text)
//   readiness-owner                                            (inside a readiness-item, present ONLY when data-present="false")
//   readiness-all-clear                                        (rendered ADDITIONALLY when every item is present — scenario 3)
//   contracts-tab, finance-tab, profitability-tab              (tab trigger buttons; aria-selected reflects active tab)
//   tab-panel-contracts, tab-panel-finance, tab-panel-profitability  (only the ACTIVE panel is present in the DOM)
//   contract-row + data-contract-id={contractId}               (one per contract, inside tab-panel-contracts)
//   finance-credit-limit, finance-credit-hold                  (inside tab-panel-finance, always present)
//   finance-hold-reason                                        (inside tab-panel-finance, present ONLY when creditHold is true)
//   profitability-placeholder                                  (inside tab-panel-profitability)
//   locale-select                                              (native <select>, same convention as decision-inbox)
//
// i18n keys used by this file (report-only requirement; values come from ar.json/en.json, never
// hardcoded here — CLAUDE.md AGENT CONSTRAINTS "No embedded UI strings — i18n"):
//   nav.customer360, customer360.readiness.owner ({owner}), customer360.readiness.allClear,
//   customer360.readiness.status.present, customer360.readiness.status.missing,
//   customer360.tabs.contracts, customer360.tabs.finance, customer360.tabs.profitability,
//   customer360.contracts.hasPriceList, customer360.contracts.noPriceList,
//   customer360.finance.holdReason ({reason}), customer360.profitability.placeholder.
//
// ============================================================================================
// DEMO FIXTURE FACTS — pg-frontend implements mock-client.ts with EXACTLY these literal values
// (pg-tester's dictated fixture, since no mock-client.ts exists yet for this brand-new slice —
// unlike decision-inbox, which already existed when its own tests were last touched).
// ============================================================================================
//   DEMO_ACCOUNT_ID = '55555555-5555-4555-8555-555555555555'
//   mockClient (SOME gaps open — used by the default "/customers/:accountId" route):
//     identity: { accountId: DEMO_ACCOUNT_ID, code: 'ACC-360-DEMO', nameAr: 'شركة ديمو للتجارة',
//                 nameEn: 'Demo Trading Co.', segmentCode: 'SEG-A', segmentNameAr: 'استراتيجي',
//                 ownerUserId: null, ownerNameAr: null }
//     contracts: [
//       { contractId: 'aaaaaaaa-0000-4000-8000-000000000001', entityCode: 'PST', status: 'active',
//         startDate: '2026-01-01', endDate: null, hasPriceList: true },
//       { contractId: 'aaaaaaaa-0000-4000-8000-000000000002', entityCode: 'PDL', status: 'draft',
//         startDate: '2025-06-01', endDate: null, hasPriceList: false },
//     ]
//     readiness: [
//       { item: 'cr_number', present: true, owner: 'CFO' },
//       { item: 'credit_limit', present: true, owner: 'CFO' },
//       { item: 'segment', present: true, owner: 'CFO' },
//       { item: 'payment_terms', present: false, owner: 'CFO' },
//       { item: 'priced_contract', present: true, owner: 'CFO' },
//     ]
//     finance: { creditLimit: '5000.000', creditHold: true, holdReason: 'overdue' }
//     profitability: { available: false }
//   readyMockClient (ALL gaps closed — scenario 3 only):
//     identical identity/contracts, EXCEPT:
//     readiness: every item present: true
//     finance: { creditLimit: '5000.000', creditHold: false, holdReason: null }
//     profitability: { available: false }

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from '@tanstack/react-router';

import { CustomerProfileScreen } from '../../src/features/customer-profile/customer-profile-screen';
import { mockClient, readyMockClient } from '../../src/features/customer-profile/mock-client';
import { DEMO_ACCOUNT_ID } from '../../src/features/customer-profile/constants';
import { createRouter } from '../../src/router';
import { t } from '../../src/i18n/t';

afterEach(() => {
  // no global mocks used in this file — kept for symmetry with decision-inbox.test.tsx.
});

describe('CustomerProfileScreen', () => {
  it("renders the identity header with the account's name, code and segment", async () => {
    const profile = await mockClient.getCustomerProfile(DEMO_ACCOUNT_ID);
    render(<CustomerProfileScreen client={mockClient} accountId={DEMO_ACCOUNT_ID} />);

    expect(await screen.findByTestId('identity-name')).toHaveTextContent(profile.identity.nameAr);
    expect(screen.getByTestId('identity-code')).toHaveTextContent(profile.identity.code);
    expect(screen.getByTestId('identity-segment')).toHaveTextContent(profile.identity.segmentNameAr ?? '');
  });

  it('renders every readiness item with its status and owner "CFO" when missing', async () => {
    const profile = await mockClient.getCustomerProfile(DEMO_ACCOUNT_ID);
    render(<CustomerProfileScreen client={mockClient} accountId={DEMO_ACCOUNT_ID} />);

    const items = await screen.findAllByTestId('readiness-item');
    expect(items).toHaveLength(profile.readiness.length);

    for (const fact of profile.readiness) {
      const row = items.find((el) => el.getAttribute('data-item') === fact.item);
      if (!row) throw new Error(`readiness-item not found for "${fact.item}"`);
      expect(row.getAttribute('data-present')).toBe(String(fact.present));

      // pg-reviewer fix round 2, R2: the hidden data-present attribute alone doesn't prove the
      // VISIBLE status text is correct — assert the translated readiness-status element too,
      // never a hardcoded string (CLAUDE.md AGENT CONSTRAINTS: no embedded UI strings — i18n).
      const statusKey = fact.present ? 'customer360.readiness.status.present' : 'customer360.readiness.status.missing';
      expect(within(row).getByTestId('readiness-status')).toHaveTextContent(t('ar', statusKey));

      if (!fact.present) {
        expect(within(row).getByTestId('readiness-owner')).toHaveTextContent(fact.owner);
      } else {
        expect(within(row).queryByTestId('readiness-owner')).toBeNull();
      }
    }
  });

  it('given every readiness item is present, shows a clear "ready" message and never a blank readiness bar', async () => {
    render(<CustomerProfileScreen client={readyMockClient} accountId={DEMO_ACCOUNT_ID} />);

    const checklist = await screen.findByTestId('readiness-checklist');
    expect(checklist).toBeVisible();
    expect(await screen.findByTestId('readiness-all-clear')).toHaveTextContent(t('ar', 'customer360.readiness.allClear'));

    const items = await screen.findAllByTestId('readiness-item');
    expect(items).toHaveLength(5);
    for (const item of items) {
      expect(item.getAttribute('data-present')).toBe('true');
    }
  });

  it('the Contracts tab lists every contract with its entity code and price-list status', async () => {
    const profile = await mockClient.getCustomerProfile(DEMO_ACCOUNT_ID);
    render(<CustomerProfileScreen client={mockClient} accountId={DEMO_ACCOUNT_ID} />);

    const rows = await screen.findAllByTestId('contract-row');
    expect(rows).toHaveLength(profile.contracts.length);

    for (const contract of profile.contracts) {
      const row = rows.find((el) => el.getAttribute('data-contract-id') === contract.contractId);
      if (!row) throw new Error(`contract-row not found for ${contract.contractId}`);
      expect(row).toHaveTextContent(contract.entityCode);
      const expectedPriceListText = contract.hasPriceList
        ? t('ar', 'customer360.contracts.hasPriceList')
        : t('ar', 'customer360.contracts.noPriceList');
      expect(row).toHaveTextContent(expectedPriceListText);
    }
  });

  it('the Finance tab shows credit limit, hold state and reason when held', async () => {
    const profile = await mockClient.getCustomerProfile(DEMO_ACCOUNT_ID);
    const user = userEvent.setup();
    const held = render(<CustomerProfileScreen client={mockClient} accountId={DEMO_ACCOUNT_ID} />);

    await user.click(await screen.findByTestId('finance-tab'));

    const panel = await screen.findByTestId('tab-panel-finance');
    expect(within(panel).getByTestId('finance-credit-limit')).toHaveTextContent(profile.finance.creditLimit ?? '');
    expect(within(panel).getByTestId('finance-credit-hold')).toBeVisible();
    expect(within(panel).getByTestId('finance-hold-reason')).toHaveTextContent(
      t('ar', 'customer360.finance.holdReason', { reason: profile.finance.holdReason ?? '' }),
    );
    held.unmount();

    // pg-reviewer fix round 1, finding 12: folded into this scenario (no matching Gherkin entry
    // for a separate "omits hold-reason when not on hold" `it`) — the ready fixture (no active
    // hold) must NOT render the hold-reason line at all.
    render(<CustomerProfileScreen client={readyMockClient} accountId={DEMO_ACCOUNT_ID} />);
    await user.click(await screen.findByTestId('finance-tab'));
    const readyPanel = await screen.findByTestId('tab-panel-finance');
    expect(within(readyPanel).queryByTestId('finance-hold-reason')).toBeNull();
  });

  it('the Profitability tab shows the placeholder copy, never a fabricated number', async () => {
    render(<CustomerProfileScreen client={mockClient} accountId={DEMO_ACCOUNT_ID} />);

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('profitability-tab'));

    const panel = await screen.findByTestId('tab-panel-profitability');
    expect(within(panel).getByTestId('profitability-placeholder')).toHaveTextContent(
      t('ar', 'customer360.profitability.placeholder'),
    );
    // Never a fabricated revenue/cost/margin figure anywhere in this panel.
    expect(panel.textContent).not.toMatch(/\d+\.\d{3}\s*KWD/);
  });

  it('switching locale updates the whole screen, including the readiness owner labels', async () => {
    const user = userEvent.setup();
    const profile = await mockClient.getCustomerProfile(DEMO_ACCOUNT_ID);
    render(<CustomerProfileScreen client={mockClient} accountId={DEMO_ACCOUNT_ID} />);

    expect(await screen.findByTestId('identity-name')).toHaveTextContent(profile.identity.nameAr);

    const selector = screen.getByTestId('locale-select');
    await user.selectOptions(selector, 'en');

    await waitFor(() => {
      expect(screen.getByTestId('identity-name')).toHaveTextContent(profile.identity.nameEn ?? '');
    });

    // pg-reviewer fix round 1, finding 13: assert the FULL translated owner string (not merely
    // that it contains "CFO", which is true in Arabic too and would pass even if the switch never
    // happened) — this only passes if the "en" locale template actually rendered.
    const missingItem = profile.readiness.find((r) => !r.present);
    if (!missingItem) throw new Error('demo fixture must contain at least one missing readiness item');
    const items = await screen.findAllByTestId('readiness-item');
    const row = items.find((el) => el.getAttribute('data-item') === missingItem.item);
    if (!row) throw new Error(`readiness-item not found for "${missingItem.item}"`);
    const enOwnerText = t('en', 'customer360.readiness.owner', { owner: missingItem.owner });
    const arOwnerText = t('ar', 'customer360.readiness.owner', { owner: missingItem.owner });
    expect(within(row).getByTestId('readiness-owner')).toHaveTextContent(enOwnerText);
    expect(within(row).queryByText(arOwnerText)).toBeNull();
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('the nav item for Customer 360 is present and marks itself current when the route is active', async () => {
    render(<RouterProvider router={createRouter(`/customers/${DEMO_ACCOUNT_ID}`)} />);

    const nav = await screen.findByRole('navigation');
    const link = within(nav).getByText(t('ar', 'nav.customer360'));
    await waitFor(() => {
      expect(link.closest('a')).toHaveAttribute('aria-current', 'page');
    });
  });
});
