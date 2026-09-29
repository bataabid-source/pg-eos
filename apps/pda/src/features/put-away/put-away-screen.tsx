// WBS 2.16 part 2 — PDA put-away screen (doc 40 §D4): shows the suggested location, the worker
// confirms it by scanning the location code.
import { useEffect, useRef, useState } from 'react';
import { useMachine } from '@xstate/react';
import { fromPromise } from 'xstate';
import type { ConfirmPutawayInput, SuggestLocationInput } from '@pg-eos/contracts/wms/receive-inbound';

import { enqueue as defaultEnqueue } from '../../offline-queue';
import { t, type Locale } from '../../i18n/t';
import type { ScanSignal } from '../receive/scan-signal';
import type { PutawayClient } from './client';
import { putawayMachine } from './put-away-machine';

export interface ConfirmPutawayCommand {
  kind: 'confirm-putaway';
  idempotencyKey: string;
  body: ConfirmPutawayInput;
  scannedAt: string;
}

export interface PutawayScreenProps {
  client: PutawayClient;
  orderId: string;
  lineId: string;
  expectedVersion: number;
  suggest: SuggestLocationInput;
  signal: ScanSignal;
  newKey: () => string;
  newCorrelationId: () => string;
  now: () => Date;
  locale?: Locale;
  enqueue?: (payload: unknown) => Promise<void>;
}

export function PutawayScreen({
  client,
  orderId,
  lineId,
  expectedVersion,
  suggest,
  signal,
  newKey,
  newCorrelationId,
  now,
  locale: controlledLocale,
  enqueue = defaultEnqueue,
}: PutawayScreenProps) {
  const locale = controlledLocale ?? 'ar';
  const propsRef = useRef({ client, orderId, lineId, expectedVersion, signal, newKey, newCorrelationId, now, enqueue });
  propsRef.current = { client, orderId, lineId, expectedVersion, signal, newKey, newCorrelationId, now, enqueue };
  const [machine] = useState(() =>
    putawayMachine.provide({
      actors: {
        suggestLocation: fromPromise(async ({ input }: { input: SuggestLocationInput }) =>
          propsRef.current.client.suggestLocation(input),
        ),
        confirmPutaway: fromPromise(async ({ input }: { input: { locationId: string } }) => {
          const p = propsRef.current;
          const command = {
            kind: 'confirm-putaway',
            idempotencyKey: p.newKey(),
            body: {
              orderId: p.orderId,
              lineId: p.lineId,
              toLocationId: input.locationId,
              expectedVersion: p.expectedVersion,
              correlationId: p.newCorrelationId(),
            },
            scannedAt: p.now().toISOString(),
          } satisfies ConfirmPutawayCommand;
          await p.enqueue(command);
        }),
      },
      actions: {
        signalOk: () => propsRef.current.signal.ok(),
        signalError: () => propsRef.current.signal.error(),
      },
    }),
  );
  const [state, send] = useMachine(machine, { input: { suggest } });
  const { suggestion, scanned, errorKey } = state.context;

  const { skuId, qty, warehouseId } = suggest;
  useEffect(() => {
    send({ type: 'SUGGEST_CHANGED', suggest: { skuId, qty, warehouseId } });
  }, [send, skuId, qty, warehouseId]);

  function handleConfirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    send({ type: 'CONFIRM' });
  }

  return (
    <div data-testid="putaway-screen">
      <h1>{t(locale, 'screen.putAway')}</h1>
      {suggestion === null ? null : (
        <p data-testid="putaway-suggested">{t(locale, 'putaway.suggested', { location: suggestion.locationCode })}</p>
      )}
      <form onSubmit={handleConfirm}>
        <label>
          {t(locale, 'putaway.scan.label')}
          <input data-testid="putaway-location" type="text" value={scanned} onChange={(e) => send({ type: 'SCAN', value: e.target.value })} />
        </label>
        <button type="submit" disabled={suggestion === null}>
          {t(locale, 'putaway.confirm')}
        </button>
      </form>
      {state.matches('confirmed') ? <p role="status">{t(locale, 'putaway.confirmed')}</p> : null}
      {errorKey === null ? null : (
        <p role="alert">{t(locale, errorKey, { location: suggestion?.locationCode ?? '' })}</p>
      )}
      {state.matches('unavailable') ? (
        <button type="button" data-testid="putaway-retry" onClick={() => send({ type: 'RETRY' })}>
          {t(locale, 'putaway.retry')}
        </button>
      ) : null}
    </div>
  );
}
