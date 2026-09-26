// WBS 2.16 part 1a-2 — RED tests for the unsynced-queue badge in `AppShell` (brief scope item
// "Unsynced counter" + Master decision 2).
//
// Badge contract chosen here by pg-tester (pg-frontend must match this exactly, per the task
// brief — "pg-frontend will match whatever you choose"):
//   - `data-testid="unsynced-queue-badge"` on the badge element itself (next to the kiosk-mode
//     button in the header, per the brief's own scope wording).
//   - `data-queue-status` attribute on that SAME element holds `queueStatus(count)`: one of
//     'green' | 'yellow' | 'red' (doc 40 §D4 thresholds) — an explicit, testable proxy for the
//     badge's colour, since jsdom/RTL do not assert computed CSS colours.
//   - the badge's own text content is `t(locale, 'queue.unsynced', { count })`.
//
// `apps/pda/src/offline-queue.ts` and the badge itself do not exist yet — this whole file is RED
// (import resolution failure + missing testid) until pg-frontend builds both.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RouterProvider } from '@tanstack/react-router';

import { createRouter } from '../../src/router';
import { enqueue } from '../../src/offline-queue';
import { t } from '../../src/i18n/t';

beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('pda-offline-queue');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
});

describe('PDA shell — unsynced queue badge (doc 40 §D4: green 0 / yellow 1-20 / red > 20)', () => {
  it('shows green with count 0 before any entry is enqueued', async () => {
    render(<RouterProvider router={createRouter('/home')} />);

    const badge = await screen.findByTestId('unsynced-queue-badge');
    expect(badge).toHaveAttribute('data-queue-status', 'green');
    expect(badge).toHaveTextContent(t('ar', 'queue.unsynced', { count: 0 }));
  });

  it('shows yellow once one entry is enqueued (lower boundary, n=1)', async () => {
    render(<RouterProvider router={createRouter('/home')} />);
    await screen.findByTestId('unsynced-queue-badge');

    await enqueue({ scan: 'A' });

    await waitFor(() => {
      expect(screen.getByTestId('unsynced-queue-badge')).toHaveAttribute(
        'data-queue-status',
        'yellow',
      );
    });
    // Exact match — `toHaveTextContent` does substring matching, so a count-1 string would also
    // spuriously match a real rendered count of e.g. 10-19 (which all contain "1").
    expect(screen.getByTestId('unsynced-queue-badge').textContent).toBe(
      t('ar', 'queue.unsynced', { count: 1 }),
    );
  });

  it('shows red once the queue crosses 20 entries (n=21, doc 40 §D4 boundary)', async () => {
    render(<RouterProvider router={createRouter('/home')} />);
    await screen.findByTestId('unsynced-queue-badge');

    await Promise.all(
      Array.from({ length: 21 }, (_, index) => enqueue({ scan: `entry-${index}` })),
    );

    await waitFor(() => {
      expect(screen.getByTestId('unsynced-queue-badge')).toHaveAttribute(
        'data-queue-status',
        'red',
      );
    });
    // Exact match — see the n=1 case above for why `toHaveTextContent` substring matching is
    // unsafe here.
    expect(screen.getByTestId('unsynced-queue-badge').textContent).toBe(
      t('ar', 'queue.unsynced', { count: 21 }),
    );
  });
});
