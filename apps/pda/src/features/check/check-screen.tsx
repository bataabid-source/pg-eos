// WBS 2.16 part 3 — PDA check screen (doc 40 §D4): scan the order to check; checker != picker is
// the server's rule, shown here as the client's refusal with the next action. One step per screen.
import { useRef, useState } from 'react';
import { useMachine } from '@xstate/react';
import { fromPromise } from 'xstate';

import { enqueue as defaultEnqueue } from '../../offline-queue';
import { t, type Locale } from '../../i18n/t';
import type { ScanSignal } from '../receive/scan-signal';
import type { CheckClient, CheckScan } from './client';
import { submitCheckScan } from './check-queue';
import { checkMachine } from './check-machine';

export interface CheckScreenProps {
  client: CheckClient;
  checkerId: string;
  signal: ScanSignal;
  newKey: () => string;
  newCorrelationId: () => string;
  now: () => Date;
  locale?: Locale;
  enqueue?: (payload: unknown) => Promise<void>;
}

export function CheckScreen({
  client,
  checkerId,
  signal,
  newKey,
  newCorrelationId,
  now,
  locale: controlledLocale,
  enqueue = defaultEnqueue,
}: CheckScreenProps) {
  const locale = controlledLocale ?? 'ar';
  const propsRef = useRef({ client, signal, newKey, newCorrelationId, now, enqueue });
  propsRef.current = { client, signal, newKey, newCorrelationId, now, enqueue };
  const [machine] = useState(() =>
    checkMachine.provide({
      actors: {
        submitScan: fromPromise(async ({ input }: { input: CheckScan }) => submitCheckScan(propsRef.current, input)),
      },
      actions: {
        signalOk: () => propsRef.current.signal.ok(),
        signalError: () => propsRef.current.signal.error(),
      },
    }),
  );
  const [state, send] = useMachine(machine, { input: { checkerId } });
  const { orderCode, errorKey } = state.context;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    send({ type: 'SUBMIT' });
  }

  return (
    <div data-testid="check-screen">
      <h1>{t(locale, 'screen.check')}</h1>
      <form onSubmit={handleSubmit}>
        <label>
          {t(locale, 'check.scan.label')}
          <input
            data-testid="check-order"
            type="text"
            value={orderCode}
            onChange={(e) => send({ type: 'SCAN', value: e.target.value })}
          />
        </label>
        <button data-testid="check-submit" type="submit">
          {t(locale, 'check.submit')}
        </button>
      </form>
      {state.matches('checked') ? (
        <p data-testid="check-status" role="status">
          {t(locale, 'check.checked')}
        </p>
      ) : null}
      {errorKey !== null ? (
        <p data-testid="check-error" role="alert">
          {t(locale, errorKey)}
        </p>
      ) : null}
    </div>
  );
}
