// WBS 2.16 part 3 — PDA pick screen (doc 40 §D4): scan location, enter quantity; one step per
// screen; error signalled by sound+vibration and a message stating the next action. The client
// verdict decides; the screen never compares quantity or location itself.
import { useRef, useState } from 'react';
import { useMachine } from '@xstate/react';
import { fromPromise } from 'xstate';

import { enqueue as defaultEnqueue } from '../../offline-queue';
import { t, type Locale } from '../../i18n/t';
import type { ScanSignal } from '../receive/scan-signal';
import type { PickClient, PickScan } from './client';
import { submitPickScan } from './pick-queue';
import { pickMachine, type PickFieldName } from './pick-machine';

export interface PickScreenProps {
  client: PickClient;
  orderId: string;
  lineId: string;
  line: { skuCode: string; locationCode: string; qtyReserved: string };
  signal: ScanSignal;
  newKey: () => string;
  newCorrelationId: () => string;
  now: () => Date;
  locale?: Locale;
  enqueue?: (payload: unknown) => Promise<void>;
}

export function PickScreen({
  client,
  orderId,
  lineId,
  line,
  signal,
  newKey,
  newCorrelationId,
  now,
  locale: controlledLocale,
  enqueue = defaultEnqueue,
}: PickScreenProps) {
  const locale = controlledLocale ?? 'ar';
  const propsRef = useRef({ client, signal, newKey, newCorrelationId, now, enqueue });
  propsRef.current = { client, signal, newKey, newCorrelationId, now, enqueue };
  const [machine] = useState(() =>
    pickMachine.provide({
      actors: {
        submitScan: fromPromise(async ({ input }: { input: PickScan }) => submitPickScan(propsRef.current, input)),
      },
      actions: {
        signalOk: () => propsRef.current.signal.ok(),
        signalError: () => propsRef.current.signal.error(),
      },
    }),
  );
  const [state, send] = useMachine(machine, { input: { orderId, lineId } });
  const { fields, errorKey } = state.context;
  const field = (name: PickFieldName) => ({
    value: fields[name],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => send({ type: 'FIELD', name, value: e.target.value }),
  });

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    send({ type: 'SUBMIT' });
  }

  return (
    <div data-testid="pick-screen">
      <h1>{t(locale, 'screen.pick')}</h1>
      <p data-testid="pick-line">
        {t(locale, 'pick.line', { sku: line.skuCode, location: line.locationCode, qty: line.qtyReserved })}
      </p>
      <form onSubmit={handleSubmit}>
        <label>
          {t(locale, 'pick.location.label')}
          <input data-testid="pick-location" type="text" {...field('locationCode')} />
        </label>
        <label>
          {t(locale, 'pick.qty.label')}
          <input data-testid="pick-qty" type="text" inputMode="decimal" {...field('qtyActual')} />
        </label>
        <label>
          {t(locale, 'pick.reason.label')}
          <input data-testid="pick-reason" type="text" {...field('varianceReason')} />
        </label>
        <button data-testid="pick-submit" type="submit">
          {t(locale, 'pick.submit')}
        </button>
      </form>
      {state.matches('picked') ? (
        <p data-testid="pick-status" role="status">
          {t(locale, 'pick.picked')}
        </p>
      ) : null}
      {errorKey !== null ? (
        <p data-testid="pick-error" role="alert">
          {t(locale, errorKey)}
        </p>
      ) : null}
    </div>
  );
}
