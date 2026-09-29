// WBS 2.16 part 2 — PDA put-away screen (doc 40 §D4): shows the suggested location, the worker
// confirms it by scanning the location code.
import { useEffect, useRef, useState } from 'react';
import type { ConfirmPutawayInput, SuggestLocationInput } from '@pg-eos/contracts/wms/receive-inbound';

import { enqueue as defaultEnqueue } from '../../offline-queue';
import { t, type Locale, type TranslationKey } from '../../i18n/t';
import type { ScanSignal } from '../receive/scan-signal';
import type { PutawayClient } from './client';

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

interface Suggestion {
  locationId: string;
  locationCode: string;
}

type Outcome = { kind: 'none' } | { kind: 'confirmed' } | { kind: 'wrongLocation' } | { kind: 'saveFailed' };

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
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [scanned, setScanned] = useState('');
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'none' });
  const inFlight = useRef(false);
  const signalRef = useRef(signal);
  signalRef.current = signal;

  useEffect(() => {
    let cancelled = false;
    client
      .suggestLocation(suggest)
      .then((result) => {
        if (!cancelled) {
          setSuggestion(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUnavailable(true);
          signalRef.current.error();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, suggest]);

  async function handleConfirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // a confirmed put-away is terminal for this line: the guard stays set after success.
    if (inFlight.current || suggestion === null) {
      return;
    }
    if (scanned !== suggestion.locationCode) {
      signal.error();
      setOutcome({ kind: 'wrongLocation' });
      return;
    }
    inFlight.current = true;
    setOutcome({ kind: 'none' });
    try {
      const command = {
        kind: 'confirm-putaway',
        idempotencyKey: newKey(),
        body: {
          orderId,
          lineId,
          toLocationId: suggestion.locationId,
          expectedVersion,
          correlationId: newCorrelationId(),
        },
        scannedAt: now().toISOString(),
      } satisfies ConfirmPutawayCommand;
      await enqueue(command);
      signal.ok();
      setOutcome({ kind: 'confirmed' });
    } catch {
      // enqueue rejected (storage failure): release the guard so the worker can confirm again.
      inFlight.current = false;
      signal.error();
      setOutcome({ kind: 'saveFailed' });
    }
  }

  const errorKey: TranslationKey | null = unavailable
    ? 'putaway.suggestion.unavailable'
    : outcome.kind === 'wrongLocation'
      ? 'putaway.error.wrongLocation'
      : outcome.kind === 'saveFailed'
        ? 'pda.queue.saveFailed'
        : null;

  return (
    <div data-testid="putaway-screen">
      <h1>{t(locale, 'screen.putAway')}</h1>
      {suggestion === null ? null : (
        <p data-testid="putaway-suggested">{t(locale, 'putaway.suggested', { location: suggestion.locationCode })}</p>
      )}
      <form onSubmit={handleConfirm}>
        <label>
          {t(locale, 'putaway.scan.label')}
          <input data-testid="putaway-location" type="text" value={scanned} onChange={(e) => setScanned(e.target.value)} />
        </label>
        <button type="submit" disabled={suggestion === null}>
          {t(locale, 'putaway.confirm')}
        </button>
      </form>
      {outcome.kind === 'confirmed' ? <p role="status">{t(locale, 'putaway.confirmed')}</p> : null}
      {errorKey === null ? null : (
        <p role="alert">{t(locale, errorKey, { location: suggestion?.locationCode ?? '' })}</p>
      )}
    </div>
  );
}
