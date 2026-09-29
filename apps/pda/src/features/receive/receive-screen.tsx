// WBS 2.16 part 2 — PDA receive screen (doc 40 §D4): scan SKU, batch, expiry, qty; one step per
// screen; error signalled by sound+vibration and a message stating the next action.
import { useEffect, useRef, useState } from 'react';

import { enqueue as defaultEnqueue } from '../../offline-queue';
import { t, type Locale, type TranslationKey } from '../../i18n/t';
import type { ReceiveClient, ReceiveRefusalCode } from './client';
import type { ScanSignal } from './scan-signal';
import { submitReceiveScan, type SubmitResult } from './scan-queue';

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

const REFUSAL_KEY: Record<ReceiveRefusalCode, TranslationKey> = {
  lineNotFound: 'receive.refused.lineNotFound',
  skuClientMismatch: 'receive.refused.skuClientMismatch',
  lineAlreadyReceived: 'receive.refused.lineAlreadyReceived',
};

function resultKey(result: Exclude<SubmitResult, { status: 'accepted' }>): TranslationKey {
  if (result.status === 'refused') {
    return REFUSAL_KEY[result.code];
  }
  return result.status === 'invalid' ? 'receive.refused.invalidInput' : 'receive.offline.retry';
}

type Outcome = { kind: 'none' } | { kind: 'accepted' } | { kind: 'error'; key: TranslationKey };

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
  const [skuCode, setSkuCode] = useState('');
  const [batchNo, setBatchNo] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [qty, setQty] = useState('');
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'none' });
  const pending = useRef(false);

  // Release after the render with cleared fields commits; only for 'accepted' so the in-flight
  // 'none' render does not drop the lock early.
  useEffect(() => {
    if (outcome.kind === 'accepted') {
      pending.current = false;
    }
  }, [outcome]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) {
      return;
    }
    pending.current = true;
    setOutcome({ kind: 'none' });
    let accepted = false;
    try {
      const result = await submitReceiveScan(
        { client, newKey, newCorrelationId, now, enqueue },
        { orderId, skuCode, batchNo, expiryDate, qty },
      );
      if (result.status === 'accepted') {
        signal.ok();
        // Clear the fields so a re-tap cannot enqueue the same physical scan again under a fresh Idempotency-Key.
        setSkuCode('');
        setBatchNo('');
        setExpiryDate('');
        setQty('');
        accepted = true;
        setOutcome({ kind: 'accepted' });
      } else {
        signal.error();
        setOutcome({ kind: 'error', key: resultKey(result) });
      }
    } catch {
      // enqueue rejected (storage failure): never silent, never a success signal.
      signal.error();
      setOutcome({ kind: 'error', key: 'pda.queue.saveFailed' });
    } finally {
      // On accept the lock is released by the outcome effect, after the cleared fields are committed.
      if (!accepted) {
        pending.current = false;
      }
    }
  }

  return (
    <div data-testid="receive-screen">
      <h1>{t(locale, 'screen.receive')}</h1>
      <form onSubmit={handleSubmit}>
        <label>
          {t(locale, 'receive.sku.label')}
          <input data-testid="receive-sku" type="text" value={skuCode} onChange={(e) => setSkuCode(e.target.value)} />
        </label>
        <label>
          {t(locale, 'receive.batch.label')}
          <input data-testid="receive-batch" type="text" value={batchNo} onChange={(e) => setBatchNo(e.target.value)} />
        </label>
        <label>
          {t(locale, 'receive.expiry.label')}
          <input
            data-testid="receive-expiry"
            type="text"
            value={expiryDate}
            onChange={(e) => setExpiryDate(e.target.value)}
          />
        </label>
        <label>
          {t(locale, 'receive.qty.label')}
          <input data-testid="receive-qty" type="text" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
        <button data-testid="receive-submit" type="submit">
          {t(locale, 'receive.submit')}
        </button>
      </form>
      {outcome.kind === 'accepted' ? (
        <p data-testid="receive-status" role="status">
          {t(locale, 'receive.accepted')}
        </p>
      ) : null}
      {outcome.kind === 'error' ? (
        <p data-testid="receive-error" role="alert">
          {t(locale, outcome.key)}
        </p>
      ) : null}
    </div>
  );
}
