// WBS 2.16 part 2 — PDA receive screen (doc 40 §D4): scan SKU, batch, expiry, qty; one step per
// screen; error signalled by sound+vibration and a message stating the next action.
import { useRef, useState } from 'react';
import { useMachine } from '@xstate/react';
import { fromPromise } from 'xstate';

import { enqueue as defaultEnqueue } from '../../offline-queue';
import { t, type Locale } from '../../i18n/t';
import type { ReceiveClient, ReceiveScan } from './client';
import type { ScanSignal } from './scan-signal';
import { submitReceiveScan } from './scan-queue';
import { receiveMachine, type ReceiveFieldName } from './receive-machine';

export interface ReceiveScreenProps {
  client: ReceiveClient;
  orderId: string;
  signal: ScanSignal;
  newKey: () => string;
  newCorrelationId: () => string;
  now: () => Date;
  locale?: Locale;
  enqueue?: (payload: unknown) => Promise<void>;
}

export function ReceiveScreen({
  client,
  orderId,
  signal,
  newKey,
  newCorrelationId,
  now,
  locale: controlledLocale,
  enqueue = defaultEnqueue,
}: ReceiveScreenProps) {
  const locale = controlledLocale ?? 'ar';
  const propsRef = useRef({ orderId, client, signal, newKey, newCorrelationId, now, enqueue });
  propsRef.current = { orderId, client, signal, newKey, newCorrelationId, now, enqueue };
  const [machine] = useState(() =>
    receiveMachine.provide({
      actors: {
        submitScan: fromPromise(async ({ input }: { input: ReceiveScan }) => submitReceiveScan(propsRef.current, { ...input, orderId: propsRef.current.orderId })),
      },
      actions: {
        signalOk: () => propsRef.current.signal.ok(),
        signalError: () => propsRef.current.signal.error(),
      },
    }),
  );
  const [state, send] = useMachine(machine, { input: { orderId } });
  const { fields, errorKey } = state.context;
  const field = (name: ReceiveFieldName) => ({
    value: fields[name],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => send({ type: 'FIELD', name, value: e.target.value }),
  });

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    send({ type: 'SUBMIT' });
  }

  return (
    <div data-testid="receive-screen">
      <h1>{t(locale, 'screen.receive')}</h1>
      <form onSubmit={handleSubmit}>
        <label>
          {t(locale, 'receive.sku.label')}
          <input data-testid="receive-sku" type="text" {...field('skuCode')} />
        </label>
        <label>
          {t(locale, 'receive.batch.label')}
          <input data-testid="receive-batch" type="text" {...field('batchNo')} />
        </label>
        <label>
          {t(locale, 'receive.expiry.label')}
          <input
            data-testid="receive-expiry"
            type="text"
            {...field('expiryDate')}
          />
        </label>
        <label>
          {t(locale, 'receive.qty.label')}
          <input data-testid="receive-qty" type="text" inputMode="decimal" {...field('qty')} />
        </label>
        <button data-testid="receive-submit" type="submit">
          {t(locale, 'receive.submit')}
        </button>
      </form>
      {state.matches('accepted') ? (
        <p data-testid="receive-status" role="status">
          {t(locale, 'receive.accepted')}
        </p>
      ) : null}
      {errorKey !== null ? (
        <p data-testid="receive-error" role="alert">
          {t(locale, errorKey)}
        </p>
      ) : null}
    </div>
  );
}
