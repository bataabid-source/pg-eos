// WBS 0.19 — RED tests for the Decision Inbox screen (first-ever frontend slice, lane 1).
//
// Design choices (stated per brief instruction to record a call where the brief leaves one open):
// 1. `DecisionInboxScreen` is rendered DIRECTLY with `{ client, role }` props for every test except
//    the "/" -> "/inbox" redirect test (scenario 8), which needs an actual router. That one imports
//    `createRouter` from `../../src/router` and wraps it in TanStack Router's `RouterProvider`.
//    This keeps 10 of 11 tests decoupled from routing internals.
// 2. The locale switch (scenarios 9 and would-be-10) is exercised on the directly-rendered
//    `DecisionInboxScreen`, because Master decision 6/9 places the header (and its locale <select>)
//    inside the inbox screen's own header bar, not a separate App shell chrome.
// 3. The third "rejecting" DecisionsClient fixture (scenario 10, error path) is declared inline
//    below as `rejectingClient`, per the brief's explicit permission, rather than requiring
//    pg-frontend to export a third fixture from mock-client.ts.
//
// Required test hooks this file assumes pg-frontend implements on the DOM (documented in the
// tester's report to the Master, since pg-tester does not write mock-client.ts / decision-card.tsx):
//   - each card:            data-testid="decision-card"  and  data-item-id={item.id}
//   - financial impact line: data-testid="financial-impact" (present only when financialImpact != null)
//   - each action button:   data-testid="decision-action-disabled" (three per card), aria-disabled="true"
//     AND the native `disabled` attribute (pg-reviewer fix round 1)
//   - urgency accent marker: data-testid="urgency-accent" (present only when urgency is 'urgent'/'high')
//   - locale selector:      data-testid="locale-select" (a native <select>, values are locale codes)
//   - i18n keys used by this file: inbox.header.title, inbox.header.count, inbox.empty.missing,
//     inbox.empty.owner, inbox.error.missing, inbox.error.owner, inbox.action.approve,
//     inbox.action.reject, inbox.action.details (report-only requirement; values come from
//     ar.json / en.json, never hardcoded here).
//
// pg-reviewer fix round 1: ROLE is the real seeded SYSADMIN role code (13B:546ff), not a made-up
// 'operations' string. The sort-order test now asserts a LITERAL expected id array (derived from
// the fixture's own known facts: impact + urgency per id, quoted below) instead of recomputing the
// production comparator in the test — so it only passes if the screen genuinely sorts, independent
// of whatever physical order pg-frontend lists the fixture array in.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from '@tanstack/react-router';

import { DecisionInboxScreen } from '../../src/features/decision-inbox/decision-inbox-screen';
import { mockClient, emptyMockClient } from '../../src/features/decision-inbox/mock-client';
import type { DecisionsClient } from '../../src/features/decision-inbox/client';
import { createRouter } from '../../src/router';
import { t } from '../../src/i18n/t';

const ROLE = 'SYSADMIN';

// Literal expected sort order for the populated mock-client fixture (Master decision 5: financial
// impact desc, nulls last, then urgency rank urgent > high > normal > everything else). Facts, as
// currently seeded in mock-client.ts:
//   1111... impact 1500.250, urgent   -> highest impact, urgent wins the tie over 2222
//   2222... impact 1500.250, normal   -> ties 1111 on impact, ranks after it
//   3333... impact 500.000,  high     -> next highest impact
//   4444... impact null,     normal   -> nulls last
const EXPECTED_SORTED_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];

// Rejects deliberately, to exercise the inline error EmptyState path (scenario 10).
const rejectingClient: DecisionsClient = {
  listOpenDecisions: () => Promise.reject(new Error('network unavailable')),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DecisionInboxScreen', () => {
  it('renders the header with the role and the open-item count', async () => {
    const items = await mockClient.listOpenDecisions(ROLE);
    render(<DecisionInboxScreen client={mockClient} role={ROLE} />);

    expect(await screen.findByText(t('ar', 'inbox.header.title', { role: ROLE }))).toBeVisible();
    expect(
      await screen.findByText(t('ar', 'inbox.header.count', { n: items.length })),
    ).toBeVisible();
  });

  it('renders one card per open decision, ordered by financialImpact desc then urgency rank', async () => {
    const items = await mockClient.listOpenDecisions(ROLE);
    render(<DecisionInboxScreen client={mockClient} role={ROLE} />);

    const cards = await screen.findAllByTestId('decision-card');
    expect(cards).toHaveLength(items.length);

    const renderedOrder = cards.map((card) => card.getAttribute('data-item-id'));
    expect(renderedOrder).toEqual(EXPECTED_SORTED_IDS);
  });

  it('shows the financial impact formatted as "N.NNN KWD" when present, and omits the line when null', async () => {
    const items = await mockClient.listOpenDecisions(ROLE);
    render(<DecisionInboxScreen client={mockClient} role={ROLE} />);

    const cards = await screen.findAllByTestId('decision-card');
    expect(cards).toHaveLength(items.length);

    for (const item of items) {
      const target = cards.find((c) => c.getAttribute('data-item-id') === item.id);
      if (!target) throw new Error(`card not found for item ${item.id}`);

      if (item.financialImpact !== null) {
        const impactLine = within(target).getByTestId('financial-impact');
        expect(impactLine.textContent?.trim()).toMatch(/^\d+\.\d{3} KWD$/);
      } else {
        expect(within(target).queryByTestId('financial-impact')).toBeNull();
      }
    }
  });

  it('gives every item exactly three disabled action buttons (اعتماد / رفض / التفاصيل)', async () => {
    const items = await mockClient.listOpenDecisions(ROLE);
    render(<DecisionInboxScreen client={mockClient} role={ROLE} />);

    const cards = await screen.findAllByTestId('decision-card');
    expect(cards).toHaveLength(items.length);

    for (const card of cards) {
      const buttons = within(card).getAllByTestId('decision-action-disabled');
      expect(buttons).toHaveLength(3);
      for (const button of buttons) {
        expect(button).toHaveAttribute('aria-disabled', 'true');
        expect(button).toBeDisabled();
      }
    }
  });

  it("applies the urgency-based accent only to items whose urgency is 'urgent' or 'high'", async () => {
    const items = await mockClient.listOpenDecisions(ROLE);
    render(<DecisionInboxScreen client={mockClient} role={ROLE} />);

    const cards = await screen.findAllByTestId('decision-card');
    for (const item of items) {
      const card = cards.find((c) => c.getAttribute('data-item-id') === item.id);
      if (!card) throw new Error(`card not found for item ${item.id}`);

      if (item.urgency === 'urgent' || item.urgency === 'high') {
        expect(within(card).getByTestId('urgency-accent')).toBeVisible();
      } else {
        expect(within(card).queryByTestId('urgency-accent')).toBeNull();
      }
    }
  });

  it('given the empty mock client: renders the EmptyState component with the missing-data text and an owner value, and renders NO decision cards', async () => {
    render(<DecisionInboxScreen client={emptyMockClient} role={ROLE} />);

    await waitFor(() => {
      expect(screen.getByText(t('ar', 'inbox.empty.missing'))).toBeVisible();
    });
    expect(screen.queryAllByTestId('decision-card')).toHaveLength(0);
    expect(screen.getByText(t('ar', 'inbox.empty.owner', { role: ROLE }))).toBeVisible();
  });

  it("the empty state's two required facts (missing + owner) are both present as visible text", async () => {
    render(<DecisionInboxScreen client={emptyMockClient} role={ROLE} />);

    const missingText = t('ar', 'inbox.empty.missing');
    const ownerText = t('ar', 'inbox.empty.owner', { role: ROLE });

    await waitFor(() => {
      expect(screen.getByText(missingText)).toBeVisible();
    });
    expect(screen.getByText(ownerText)).toBeVisible();
  });

  it('default route "/" renders the same content as "/inbox" (redirect)', async () => {
    const rootRouter = createRouter('/');
    const { unmount } = render(<RouterProvider router={rootRouter} />);
    const rootCards = await screen.findAllByTestId('decision-card');
    const rootIds = rootCards.map((c) => c.getAttribute('data-item-id')).sort();
    unmount();

    const inboxRouter = createRouter('/inbox');
    render(<RouterProvider router={inboxRouter} />);
    const inboxCards = await screen.findAllByTestId('decision-card');
    const inboxIds = inboxCards.map((c) => c.getAttribute('data-item-id')).sort();

    expect(rootIds).toEqual(inboxIds);
  });

  it('switching the locale selector to "en" replaces the visible Arabic strings with their English i18n counterparts and flips the root dir attribute to "ltr"', async () => {
    // Rendered through the router (not DecisionInboxScreen directly) so the app shell's nav
    // (router.tsx's AppShell) is present too — pg-reviewer round 2: the shell's `nav.inbox`
    // label must also switch language once locale state is lifted above the screen.
    const user = userEvent.setup();
    const items = await mockClient.listOpenDecisions(ROLE);
    render(<RouterProvider router={createRouter('/inbox')} />);

    const arTitle = t('ar', 'inbox.header.title', { role: ROLE });
    const arCount = t('ar', 'inbox.header.count', { n: items.length });
    expect(await screen.findByText(arTitle)).toBeVisible();
    expect(await screen.findByText(arCount)).toBeVisible();

    const selector = screen.getByTestId('locale-select');
    await user.selectOptions(selector, 'en');

    const enTitle = t('en', 'inbox.header.title', { role: ROLE });
    const enCount = t('en', 'inbox.header.count', { n: items.length });
    expect(await screen.findByText(enTitle)).toBeVisible();
    expect(await screen.findByText(enCount)).toBeVisible();
    expect(screen.queryByText(arTitle)).toBeNull();
    expect(screen.queryByText(arCount)).toBeNull();

    // At least one action button now shows its English label, not the Arabic one.
    const enActionLabels = [
      t('en', 'inbox.action.approve'),
      t('en', 'inbox.action.reject'),
      t('en', 'inbox.action.details'),
    ];
    const arActionLabels = [
      t('ar', 'inbox.action.approve'),
      t('ar', 'inbox.action.reject'),
      t('ar', 'inbox.action.details'),
    ];
    const firstCard = (await screen.findAllByTestId('decision-card'))[0];
    if (!firstCard) throw new Error('no card rendered');
    const buttonTexts = within(firstCard)
      .getAllByTestId('decision-action-disabled')
      .map((button) => button.textContent?.trim());
    expect(buttonTexts.some((text) => enActionLabels.includes(text ?? ''))).toBe(true);
    expect(buttonTexts.some((text) => arActionLabels.includes(text ?? ''))).toBe(false);

    // The app shell's nav label (AppShell in router.tsx) switches language too — the locale
    // state is shared, not scoped to the inbox screen alone.
    const nav = screen.getByRole('navigation');
    expect(within(nav).getByText(t('en', 'nav.inbox'))).toBeVisible();
    expect(within(nav).queryByText(t('ar', 'nav.inbox'))).toBeNull();

    expect(document.documentElement.dir).toBe('ltr');
  });

  it('switching the locale selector back to "ar" flips the root dir attribute back to "rtl"', async () => {
    const user = userEvent.setup();
    render(<DecisionInboxScreen client={mockClient} role={ROLE} />);

    const selector = screen.getByTestId('locale-select');
    await user.selectOptions(selector, 'en');
    await waitFor(() => {
      expect(document.documentElement.dir).toBe('ltr');
    });

    await user.selectOptions(selector, 'ar');
    await waitFor(() => {
      expect(document.documentElement.dir).toBe('rtl');
    });
    expect(await screen.findByText(t('ar', 'inbox.header.title', { role: ROLE }))).toBeVisible();
  });

  it('a client that rejects (simulated) renders the inline error EmptyState variant, never throws to the console', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(<DecisionInboxScreen client={rejectingClient} role={ROLE} />);

    await waitFor(() => {
      expect(screen.getByText(t('ar', 'inbox.error.missing'))).toBeVisible();
    });
    expect(screen.getByText(t('ar', 'inbox.error.owner'))).toBeVisible();
    expect(screen.queryAllByTestId('decision-card')).toHaveLength(0);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
