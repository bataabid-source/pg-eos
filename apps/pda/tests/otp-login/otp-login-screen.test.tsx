// WBS 2.16 part 1a-4 — RED tests for the PDA OTP login screen (brief `Deliver` list, Scenario
// section). pg-frontend does not exist yet: `../../src/features/otp-login/client`,
// `../../src/features/otp-login/otp-login-screen` are written by pg-frontend against the exact
// shape documented below; this file's own import will fail (module not found) until it does — the
// intended RED reason.
//
// TARGET SHAPE pg-frontend builds to (not re-derived elsewhere, brief §Deliver + Master decisions
// 1-4 restated as an unambiguous contract for the builder):
//
//   apps/pda/src/features/otp-login/client.ts
//     export interface OtpLoginClient {
//       requestOtpCode(email: string): Promise<{ expiresInMinutes: number }>;
//       verifyOtpCode(email: string, code: string): Promise<{ token: string; expiresAt: string }>;
//       // verifyOtpCode REJECTS with a plain Error (any message) on every non-success outcome —
//       // the screen must render ONE uniform `login.error.invalidCode` string regardless of the
//       // rejection's message/shape (Master decision 3): it must never branch on it.
//     }
//
//   apps/pda/src/features/otp-login/otp-login-screen.tsx
//     export interface OtpLoginScreenProps {
//       client: OtpLoginClient;
//       // Controlled locale, same optional-controlled pattern as
//       // apps/admin/src/features/decision-inbox/decision-inbox-screen.tsx's own
//       // `DecisionInboxScreenProps` (omitted -> the screen manages its own 'ar'-default state).
//       locale?: Locale;
//       onLocaleChange?: (locale: Locale) => void;
//       // Called once with the verified session on a successful verifyOtpCode (Master decision 2:
//       // the token/expiresAt are NEVER persisted by the screen itself — the caller, e.g. the
//       // future router wiring, decides what to do with them, including navigating to "/home").
//       onLoginSuccess: (result: { token: string; expiresAt: string }) => void;
//     }
//
//   Two-step form, plain useState/async handlers (brief: no @tanstack/react-query this slice):
//     Step 1 ("request"): an email `<input>` — accessible name resolves to
//       `t(locale, 'login.email.label')` — and a submit control whose accessible name resolves to
//       `t(locale, 'login.email.submit')`. Submitting calls `client.requestOtpCode(email)`.
//       - On resolve: renders `t(locale, 'login.requestSent', { minutes: expiresInMinutes })` and
//         reveals step 2 (the code field), per doc 40 §D4 scenario line "code sent, expires in N
//         minutes ... reveals the code field".
//       - On reject: renders `t(locale, 'login.error.requestFailed')` and the email step stays
//         submittable again (retry: the worker can resubmit without reloading the screen).
//     Step 2 ("verify"), visible only after a successful request: a code `<input>` — accessible
//       name resolves to `t(locale, 'login.code.label')` — and a submit control whose accessible
//       name resolves to `t(locale, 'login.code.submit')`. Submitting calls
//       `client.verifyOtpCode(email, code)`.
//       - On resolve: renders `t(locale, 'login.success')` and calls
//         `onLoginSuccess({ token, expiresAt })` exactly once with the resolved value.
//       - On reject (ANY reason): renders `t(locale, 'login.error.invalidCode')` — the SAME text
//         for every rejection, never derived from the rejection's own message.
//
// Locale: the screen renders `login.title` visibly (the scenario's own "login screen" heading),
// resolved through the six-locale `t()` mechanism exactly like every other PDA screen.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { OtpLoginScreen } from '../../src/features/otp-login/otp-login-screen';
import type { OtpLoginClient } from '../../src/features/otp-login/client';
import { t, SUPPORTED_LOCALES, type Locale } from '../../src/i18n/t';

const EMAIL = 'picker@warehouse.example';
const CODE = '123456';

function makeClient(overrides: Partial<OtpLoginClient> = {}): OtpLoginClient {
  return {
    requestOtpCode: vi.fn().mockResolvedValue({ expiresInMinutes: 5 }),
    verifyOtpCode: vi.fn().mockResolvedValue({ token: 'tok-abc', expiresAt: '2026-09-26T12:00:00Z' }),
    ...overrides,
  };
}

async function requestCode(user: ReturnType<typeof userEvent.setup>, locale: Locale = 'ar') {
  const emailInput = screen.getByLabelText(t(locale, 'login.email.label'));
  await user.type(emailInput, EMAIL);
  await user.click(screen.getByRole('button', { name: t(locale, 'login.email.submit') }));
}

describe('PDA OTP login screen — request then verify (doc 40 §D4 scenario)', () => {
  it('requests a code, shows "code sent, expires in N minutes", then verifies it and reports success', async () => {
    const user = userEvent.setup();
    const client = makeClient({
      requestOtpCode: vi.fn().mockResolvedValue({ expiresInMinutes: 5 }),
      verifyOtpCode: vi
        .fn()
        .mockResolvedValue({ token: 'tok-abc', expiresAt: '2026-09-26T12:00:00Z' }),
    });
    const onLoginSuccess = vi.fn();

    render(<OtpLoginScreen client={client} locale="ar" onLoginSuccess={onLoginSuccess} />);

    expect(screen.getByText(t('ar', 'login.title'))).toBeVisible();

    await requestCode(user);

    expect(client.requestOtpCode).toHaveBeenCalledExactlyOnceWith(EMAIL);
    expect(
      await screen.findByText(t('ar', 'login.requestSent', { minutes: 5 })),
    ).toBeVisible();

    const codeInput = screen.getByLabelText(t('ar', 'login.code.label'));
    await user.type(codeInput, CODE);
    await user.click(screen.getByRole('button', { name: t('ar', 'login.code.submit') }));

    expect(client.verifyOtpCode).toHaveBeenCalledExactlyOnceWith(EMAIL, CODE);
    expect(await screen.findByText(t('ar', 'login.success'))).toBeVisible();
    expect(onLoginSuccess).toHaveBeenCalledExactlyOnceWith({
      token: 'tok-abc',
      expiresAt: '2026-09-26T12:00:00Z',
    });
  });

  it('never persists the token/expiresAt itself — only reports them through onLoginSuccess', async () => {
    // fix round 1, finding 6: Master decision 2 says "never written to localStorage/IndexedDB" —
    // the original assertion only checked localStorage. This test does not mount the router/
    // AppShell (only the bare `<OtpLoginScreen>`, same as every other test in this file), so
    // `apps/pda/src/offline-queue.ts` (the only IndexedDB user in this app, opened by AppShell's
    // own queue-count effect in router.tsx) is never touched here — `indexedDB.databases()` is
    // therefore expected to come back empty, proving the screen itself opens no database of its
    // own, not merely that some OTHER code happened to clean up after itself.
    const user = userEvent.setup();
    const client = makeClient();
    const onLoginSuccess = vi.fn();

    // Guard against any stray IndexedDB database left behind by a previous test in this same
    // module (isolation belt-and-braces; does not weaken the assertion below — if a database is
    // genuinely (re)created by the screen under test, it will still be present afterwards).
    for (const info of await indexedDB.databases()) {
      if (info.name !== undefined) {
        await new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase(info.name as string);
          request.onsuccess = () => resolve();
          request.onerror = () => resolve();
          request.onblocked = () => resolve();
        });
      }
    }

    render(<OtpLoginScreen client={client} locale="ar" onLoginSuccess={onLoginSuccess} />);
    await requestCode(user);
    await screen.findByText(t('ar', 'login.requestSent', { minutes: 5 }));
    await user.type(screen.getByLabelText(t('ar', 'login.code.label')), CODE);
    await user.click(screen.getByRole('button', { name: t('ar', 'login.code.submit') }));

    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalledTimes(1));
    expect(window.localStorage.getItem('token')).toBeNull();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(await indexedDB.databases()).toEqual([]);
  });

  describe('an invalid or expired code is rejected — one uniform error, never distinguishing why', () => {
    it.each([
      ['a plain wrong-code rejection', new Error('the email and code did not verify.')],
      ['a differently-shaped rejection (e.g. expired/replay)', new Error('replay detected')],
    ])('%s renders the exact same login.error.invalidCode text', async (_label, rejection) => {
      const user = userEvent.setup();
      const client = makeClient({ verifyOtpCode: vi.fn().mockRejectedValue(rejection) });
      const onLoginSuccess = vi.fn();

      render(<OtpLoginScreen client={client} locale="ar" onLoginSuccess={onLoginSuccess} />);
      await requestCode(user);
      await screen.findByText(t('ar', 'login.requestSent', { minutes: 5 }));
      await user.type(screen.getByLabelText(t('ar', 'login.code.label')), 'whatever');
      await user.click(screen.getByRole('button', { name: t('ar', 'login.code.submit') }));

      expect(await screen.findByText(t('ar', 'login.error.invalidCode'))).toBeVisible();
      expect(onLoginSuccess).not.toHaveBeenCalled();
    });

    it('renders the SAME invalidCode text for both rejection shapes above (no case-specific message ever appears)', async () => {
      const user = userEvent.setup();
      const client = makeClient({
        verifyOtpCode: vi.fn().mockRejectedValue(new Error('replay detected')),
      });
      render(<OtpLoginScreen client={client} locale="ar" onLoginSuccess={vi.fn()} />);
      await requestCode(user);
      await screen.findByText(t('ar', 'login.requestSent', { minutes: 5 }));
      await user.type(screen.getByLabelText(t('ar', 'login.code.label')), 'whatever');
      await user.click(screen.getByRole('button', { name: t('ar', 'login.code.submit') }));

      expect(await screen.findByText(t('ar', 'login.error.invalidCode'))).toBeVisible();
      expect(screen.queryByText('replay detected')).not.toBeInTheDocument();
    });
  });

  describe('the request step fails at the network/client layer', () => {
    it('shows a request-failed error and lets the worker retry the request', async () => {
      const user = userEvent.setup();
      const requestOtpCode = vi
        .fn()
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce({ expiresInMinutes: 5 });
      const client = makeClient({ requestOtpCode });

      render(<OtpLoginScreen client={client} locale="ar" onLoginSuccess={vi.fn()} />);

      const emailInput = screen.getByLabelText(t('ar', 'login.email.label'));
      await user.type(emailInput, EMAIL);
      await user.click(screen.getByRole('button', { name: t('ar', 'login.email.submit') }));

      expect(await screen.findByText(t('ar', 'login.error.requestFailed'))).toBeVisible();
      // Retry: the same submit control is still present and usable — no code step was revealed.
      expect(screen.queryByLabelText(t('ar', 'login.code.label'))).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: t('ar', 'login.email.submit') }));

      expect(requestOtpCode).toHaveBeenCalledTimes(2);
      expect(
        await screen.findByText(t('ar', 'login.requestSent', { minutes: 5 })),
      ).toBeVisible();
    });
  });

  describe('the six-locale contract still holds (ar authored first, five others resolve identically)', () => {
    it.each(SUPPORTED_LOCALES)(
      'every new i18n key resolves for locale "%s" (title, labels, submit controls all render)',
      async (locale) => {
        const client = makeClient();
        render(<OtpLoginScreen client={client} locale={locale} onLoginSuccess={vi.fn()} />);

        expect(screen.getByText(t(locale, 'login.title'))).toBeVisible();
        expect(screen.getByLabelText(t(locale, 'login.email.label'))).toBeVisible();
        expect(
          screen.getByRole('button', { name: t(locale, 'login.email.submit') }),
        ).toBeVisible();
      },
    );

    it.each(SUPPORTED_LOCALES)(
      'locale "%s" shows the request-sent message with the interpolated minute count after requesting',
      async (locale) => {
        const user = userEvent.setup();
        const client = makeClient({
          requestOtpCode: vi.fn().mockResolvedValue({ expiresInMinutes: 7 }),
        });
        render(<OtpLoginScreen client={client} locale={locale} onLoginSuccess={vi.fn()} />);

        await requestCode(user, locale);

        expect(
          await screen.findByText(t(locale, 'login.requestSent', { minutes: 7 })),
        ).toBeVisible();
        expect(screen.getByLabelText(t(locale, 'login.code.label'))).toBeVisible();
      },
    );
  });
});
