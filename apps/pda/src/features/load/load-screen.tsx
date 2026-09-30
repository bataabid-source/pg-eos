// WBS 2.16 part 3 — PDA load screen (doc 40 §D4): scan the packed order to load. The client
// verdict decides; the screen never re-implements a server rule. One step per screen.
import { useRef, useState } from 'react';
import { useMachine } from '@xstate/react';
import { fromPromise } from 'xstate';

import { enqueue as defaultEnqueue } from '../../offline-queue';
import { t, type Locale } from '../../i18n/t';
import type { ScanSignal } from '../receive/scan-signal';
import type { LoadClient, LoadScan } from './client';
import { submitLoadScan } from './load-queue';
import { loadMachine } from './load-machine';

export interface LoadScreenProps {
  client: LoadClient;
  signal: ScanSignal;
  newKey: () => string;
  newCorrelationId: () => string;
  now: () => Date;
  locale?: Locale;
  enqueue?: (payload: unknown) => Promise<void>;
}

export function LoadScreen({
  client,
  signal,
  newKey,
  newCorrelationId,
  now,
  locale: controlledLocale,
  enqueue = defaultEnqueue,
}: LoadScreenProps) {
  const locale = controlledLocale ?? 'ar';
  const propsRef = useRef({ client, signal, newKey, newCorrelationId, now, enqueue });
  propsRef.current = { client, signal, newKey, newCorrelationId, now, enqueue };
  const [machine] = useState(() =>
    loadMachine.provide({
      actors: {
        submitScan: fromPromise(async ({ input }: { input: LoadScan }) => submitLoadScan(propsRef.current, input)),
      },
      actions: {
        signalOk: () => propsRef.current.signal.ok(),
        signalError: () => propsRef.current.signal.error(),
      },
    }),
  );
  const [state, send] = useMachine(machine, { input: {} });
  const { orderCode, errorKey } = state.context;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    send({ type: 'SUBMIT' });
  }

  return (
    <div data-testid="load-screen">
      <h1>{t(locale, 'screen.load')}</h1>
      <form onSubmit={handleSubmit}>
        <label>
          {t(locale, 'load.scan.label')}
          <input
            data-testid="load-order"
            type="text"
            value={orderCode}
            onChange={(e) => send({ type: 'SCAN', value: e.target.value })}
          />
        </label>
        <button data-testid="load-submit" type="submit">
          {t(locale, 'load.submit')}
        </button>
      </form>
      {state.matches('loaded') ? (
        <p data-testid="load-status" role="status">
          {t(locale, 'load.loaded')}
        </p>
      ) : null}
      {errorKey !== null ? (
        <p data-testid="load-error" role="alert">
          {t(locale, errorKey)}
        </p>
      ) : null}
    </div>
  );
}
