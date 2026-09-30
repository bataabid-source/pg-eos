// WBS 2.16 part 1a-4 — PDA OTP login screen. Two-step form (request -> verify), plain
// useState/async handlers (brief: no @tanstack/react-query this slice — pda has no such
// dependency and a two-step form needs no query cache).
//
// Controlled-locale pattern mirrors apps/admin/src/features/decision-inbox/decision-inbox-screen
// .tsx's own `DecisionInboxScreenProps`: `locale`/`onLocaleChange` are optional, the screen falls
// back to its own 'ar'-default state when omitted.
//
// Master decision 2: token/expiresAt are never persisted here — held in local component state
// only long enough to hand them to `onLoginSuccess`, called exactly once on a successful verify.
// Master decision 3: every `verifyOtpCode` rejection (any message/shape) renders the SAME
// `login.error.invalidCode` string — never derived from the rejection itself.
import { useState } from 'react';

import type { OtpLoginClient } from './client';
import { t, type Locale } from '../../i18n/t';
import { Alert } from '../../ui/Alert';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Screen } from '../../ui/Screen';
import { Status } from '../../ui/Status';

export interface OtpLoginScreenProps {
  client: OtpLoginClient;
  locale?: Locale;
  onLocaleChange?: (locale: Locale) => void;
  onLoginSuccess: (result: { token: string; expiresAt: string }) => void;
}

type Step = 'request' | 'verify' | 'success';

// `onLocaleChange` is accepted for interface parity with the controlled-locale pattern (brief
// target shape) but this screen never renders its own locale selector — the shell (AppShell in
// router.tsx) owns that control and passes the resulting `locale` down as a prop.
export function OtpLoginScreen({
  client,
  locale: controlledLocale,
  onLoginSuccess,
}: OtpLoginScreenProps) {
  const locale = controlledLocale ?? 'ar';

  const [step, setStep] = useState<Step>('request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [expiresInMinutes, setExpiresInMinutes] = useState<number | null>(null);
  const [requestError, setRequestError] = useState(false);
  const [verifyError, setVerifyError] = useState(false);
  const [requestPending, setRequestPending] = useState(false);
  const [verifyPending, setVerifyPending] = useState(false);

  async function handleRequestSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRequestError(false);
    setRequestPending(true);
    try {
      const result = await client.requestOtpCode(email);
      setExpiresInMinutes(result.expiresInMinutes);
      setStep('verify');
    } catch {
      setRequestError(true);
    } finally {
      setRequestPending(false);
    }
  }

  async function handleVerifySubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setVerifyError(false);
    setVerifyPending(true);
    let result: { token: string; expiresAt: string } | undefined;
    try {
      result = await client.verifyOtpCode(email, code);
    } catch {
      setVerifyError(true);
    } finally {
      setVerifyPending(false);
    }
    if (result) {
      setStep('success');
      onLoginSuccess(result);
    }
  }

  return (
    <Screen title={t(locale, 'login.title')}>
      {step === 'request' ? (
        <form onSubmit={handleRequestSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-start">
            {t(locale, 'login.email.label')}
            <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <Button type="submit" disabled={requestPending}>
            {t(locale, 'login.email.submit')}
          </Button>
        </form>
      ) : (
        <>
          {expiresInMinutes !== null ? <p>{t(locale, 'login.requestSent', { minutes: expiresInMinutes })}</p> : null}
          <form onSubmit={handleVerifySubmit} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-start">
              {t(locale, 'login.code.label')}
              <Input
                type="text"
                value={code}
                disabled={step !== 'verify'}
                onChange={(event) => setCode(event.target.value)}
              />
            </label>
            <Button type="submit" disabled={verifyPending || step !== 'verify'}>
              {t(locale, 'login.code.submit')}
            </Button>
          </form>
        </>
      )}

      {requestError ? <Alert>{t(locale, 'login.error.requestFailed')}</Alert> : null}
      {verifyError ? <Alert>{t(locale, 'login.error.invalidCode')}</Alert> : null}
      {step === 'success' ? <Status>{t(locale, 'login.success')}</Status> : null}
    </Screen>
  );
}
