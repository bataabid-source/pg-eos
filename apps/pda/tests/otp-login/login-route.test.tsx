// WBS 2.16 part 1a-4 — fix round 1, finding 1 (routed coverage missing).
//
// Scenario 1 (brief) ends "the app navigates to /home" — nothing in
// tests/otp-login/otp-login-screen.test.tsx exercises that: it renders `<OtpLoginScreen>` in
// isolation, never through the real `/login` route, `LoginRouteComponent`, the real `mockClient`
// wiring, or the `navigate({ to: '/home' })` call in apps/pda/src/router.tsx (~lines 190-215).
//
// This file follows tests/shell/routes.test.tsx's own `createRouter(path)` + `RouterProvider`
// pattern verbatim, against the REAL mock client (no fake/stub client injected here — the point is
// to prove the actual wiring, including the fixed fixture code `'123456'` from
// apps/pda/src/features/otp-login/mock-client.ts, which pg-tester is not allowed to read/import
// directly per the brief's Write ONLY scope, but is exercised transitively through the route).
//
// Every visible string is resolved through `t()`, never hardcoded, since pg-frontend is concurrently
// rewording `login.error.invalidCode` (and possibly other keys) for other round-1 findings.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from '@tanstack/react-router';

import { createRouter } from '../../src/router';
import { t } from '../../src/i18n/t';

const EMAIL = 'picker@warehouse.example';
const FIXTURE_CODE = '123456';

describe('PDA "/login" route — real router + mockClient wiring (fix round 1, finding 1)', () => {
  it('renders the login screen title at "/login"', async () => {
    const router = createRouter('/login');
    render(<RouterProvider router={router} />);

    expect(await screen.findByText(t('ar', 'login.title'))).toBeVisible();
  });

  it('requesting then verifying the real fixture code navigates to "/home"', async () => {
    const user = userEvent.setup();
    const router = createRouter('/login');
    render(<RouterProvider router={router} />);

    await screen.findByText(t('ar', 'login.title'));

    const emailInput = screen.getByLabelText(t('ar', 'login.email.label'));
    await user.type(emailInput, EMAIL);
    await user.click(screen.getByRole('button', { name: t('ar', 'login.email.submit') }));

    const codeInput = await screen.findByLabelText(t('ar', 'login.code.label'));
    await user.type(codeInput, FIXTURE_CODE);
    await user.click(screen.getByRole('button', { name: t('ar', 'login.code.submit') }));

    expect(await screen.findByText(t('ar', 'screen.home'))).toBeVisible();
  });

  it('a wrong code through the real mockClient shows the uniform invalid-code error and stays on "/login"', async () => {
    const user = userEvent.setup();
    const router = createRouter('/login');
    render(<RouterProvider router={router} />);

    await screen.findByText(t('ar', 'login.title'));

    const emailInput = screen.getByLabelText(t('ar', 'login.email.label'));
    await user.type(emailInput, EMAIL);
    await user.click(screen.getByRole('button', { name: t('ar', 'login.email.submit') }));

    const codeInput = await screen.findByLabelText(t('ar', 'login.code.label'));
    await user.type(codeInput, '000000');
    await user.click(screen.getByRole('button', { name: t('ar', 'login.code.submit') }));

    expect(await screen.findByText(t('ar', 'login.error.invalidCode'))).toBeVisible();
    // Navigation never happened — the app stays on "/login".
    expect(screen.queryByText(t('ar', 'screen.home'))).not.toBeInTheDocument();
  });
});
