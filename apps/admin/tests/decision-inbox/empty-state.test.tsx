// WBS 0.19 — RED tests for the generic EmptyState component.
// Design choice: EmptyState is rendered directly with props (no client/router needed) —
// it is a pure presentational component per Deliver: apps/admin/src/components/empty-state.tsx.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from '../../src/components/empty-state';

describe('EmptyState component', () => {
  it('renders the given title, missing text and owner text, all three visible', () => {
    const title = 'لا يوجد ما يحتاج قرارك الآن';
    const missing = 'لا قرارات مفتوحة';
    const owner = 'العمليات';

    render(<EmptyState title={title} missing={missing} owner={owner} />);

    expect(screen.getByText(title)).toBeVisible();
    expect(screen.getByText(missing)).toBeVisible();
    expect(screen.getByText(owner)).toBeVisible();
  });
});
