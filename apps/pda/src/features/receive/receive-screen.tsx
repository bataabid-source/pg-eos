// WBS 2.16 part 2 — PDA receive screen (doc 40 §D4): scan SKU, batch, expiry, qty; one step per
// screen; error signalled by sound+vibration and a message stating the next action.
import { useEffect, useRef, useState } from 'react';
import { useMachine } from '@xstate/react';
import { fromPromise } from 'xstate';

import { enqueue as defaultEnqueue } from '../../offline-queue';
import { t, type Locale } from '../../i18n/t';
import type { ReceiveClient, ReceiveScan } from './client';
import type { ScanSignal } from './scan-signal';
import { submitReceiveScan } from './scan-queue';
import { receiveMachine, type ReceiveFieldName } from './receive-machine';
import { Alert } from '../../ui/Alert';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { ScanField, type ScanFieldHandle } from '../../ui/ScanField';
import { Screen } from '../../ui/Screen';
import { Status } from '../../ui/Status';

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

  const skuRef = useRef<ScanFieldHandle>(null);
  const accepted = state.matches('accepted');
  useEffect(() => {
    if (accepted) {
      skuRef.current?.refocus();
    }
  }, [accepted]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    send({ type: 'SUBMIT' });
  }

  return (
    <Screen data-testid="receive-screen" title={t(locale, 'screen.receive')}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <ScanField ref={skuRef} label={t(locale, 'receive.sku.label')} data-testid="receive-sku" type="text" {...field('skuCode')} />
        <label className="flex flex-col gap-1 text-start">
          {t(locale, 'receive.batch.label')}
          <Input data-testid="receive-batch" type="text" {...field('batchNo')} />
        </label>
        <label className="flex flex-col gap-1 text-start">
          {t(locale, 'receive.expiry.label')}
          <Input data-testid="receive-expiry" type="text" {...field('expiryDate')} />
        </label>
        <label className="flex flex-col gap-1 text-start">
          {t(locale, 'receive.qty.label')}
          <Input data-testid="receive-qty" type="text" inputMode="decimal" {...field('qty')} />
        </label>
        <Button data-testid="receive-submit" type="submit">
          {t(locale, 'receive.submit')}
        </Button>
      </form>
      {accepted ? <Status data-testid="receive-status">{t(locale, 'receive.accepted')}</Status> : null}
      {errorKey !== null ? <Alert data-testid="receive-error">{t(locale, errorKey)}</Alert> : null}
    </Screen>
  );
}
