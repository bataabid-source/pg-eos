// WBS 2.16 part 2 — putawayMachine (XState v5) behind the put-away screen.
import { createActor, fromPromise, waitFor } from 'xstate';
import { describe, expect, it, vi } from 'vitest';
import type { SuggestLocationInput } from '@pg-eos/contracts/wms/receive-inbound';

import { putawayMachine } from '../../src/features/put-away/put-away-machine';

const ONCE = 1;
const TWICE = 2;
const SUGGEST_A = {
  skuId: '00000000-0000-4000-8000-000000000001',
  qty: '5',
  warehouseId: '00000000-0000-4000-8000-000000000002',
} as SuggestLocationInput;
const SUGGEST_B = { ...SUGGEST_A, qty: '7' } as SuggestLocationInput;
const LOCATION = { locationId: 'loc-1', locationCode: 'A-01-01' };

interface Impl {
  suggest?: (input: SuggestLocationInput) => Promise<typeof LOCATION>;
  confirm?: (input: { locationId: string }) => Promise<void>;
}

function setup(impl: Impl = {}) {
  const suggestLocation = vi.fn(impl.suggest ?? (async () => LOCATION));
  const confirmPutaway = vi.fn(impl.confirm ?? (async () => undefined));
  const signalOk = vi.fn();
  const signalError = vi.fn();
  const actor = createActor(
    putawayMachine.provide({
      actors: {
        suggestLocation: fromPromise(async ({ input }: { input: SuggestLocationInput }) => suggestLocation(input)),
        confirmPutaway: fromPromise(async ({ input }: { input: { locationId: string } }) => confirmPutaway(input)),
      },
      actions: { signalOk, signalError },
    }),
    { input: { suggest: SUGGEST_A } },
  );
  actor.start();
  return { actor, suggestLocation, confirmPutaway, signalOk, signalError };
}

async function ready(impl: Impl = {}) {
  const s = setup(impl);
  await waitFor(s.actor, (x) => x.value === 'ready');
  return s;
}

describe('putawayMachine', () => {
  it('starts suggesting, invoking suggestLocation with context.suggest', async () => {
    const { actor, suggestLocation } = setup();
    expect(actor.getSnapshot().value).toBe('suggesting');
    expect(suggestLocation).toHaveBeenCalledWith(SUGGEST_A);
    const snap = await waitFor(actor, (s) => s.value === 'ready');
    expect(snap.context.suggestion).toEqual(LOCATION);
    expect(snap.context.scanned).toBe('');
    expect(snap.context.errorKey).toBeNull();
  });

  it('suggest rejecting -> unavailable, errorKey set, signalError once', async () => {
    const { actor, signalError } = setup({
      suggest: async () => {
        throw new Error('down');
      },
    });
    const snap = await waitFor(actor, (s) => s.value === 'unavailable');
    expect(snap.context.errorKey).toBe('putaway.suggestion.unavailable');
    expect(signalError).toHaveBeenCalledTimes(ONCE);
  });

  it('RETRY from unavailable -> suggesting, errorKey cleared, suggestLocation invoked again', async () => {
    let calls = 0;
    const { actor, suggestLocation } = setup({
      suggest: async () => {
        calls += 1;
        if (calls === ONCE) {
          throw new Error('down');
        }
        return LOCATION;
      },
    });
    await waitFor(actor, (s) => s.value === 'unavailable');
    actor.send({ type: 'RETRY' });
    expect(actor.getSnapshot().value).toBe('suggesting');
    expect(actor.getSnapshot().context.errorKey).toBeNull();
    await waitFor(actor, (s) => s.value === 'ready');
    expect(suggestLocation).toHaveBeenCalledTimes(TWICE);
  });

  it('SUGGEST_CHANGED from ready -> suggesting with the new input, suggestion and errorKey cleared', async () => {
    const { actor, suggestLocation } = await ready();
    actor.send({ type: 'SUGGEST_CHANGED', suggest: SUGGEST_B });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe('suggesting');
    expect(snap.context.suggest).toEqual(SUGGEST_B);
    expect(snap.context.suggestion).toBeNull();
    expect(snap.context.errorKey).toBeNull();
    expect(suggestLocation).toHaveBeenLastCalledWith(SUGGEST_B);
    await waitFor(actor, (s) => s.value === 'ready');
  });

  it('SUGGEST_CHANGED from suggesting and from unavailable re-suggests with the new input', async () => {
    const a = setup();
    a.actor.send({ type: 'SUGGEST_CHANGED', suggest: SUGGEST_B });
    expect(a.actor.getSnapshot().value).toBe('suggesting');
    expect(a.suggestLocation).toHaveBeenLastCalledWith(SUGGEST_B);

    const b = setup({
      suggest: async () => {
        throw new Error('down');
      },
    });
    await waitFor(b.actor, (s) => s.value === 'unavailable');
    b.actor.send({ type: 'SUGGEST_CHANGED', suggest: SUGGEST_B });
    expect(b.actor.getSnapshot().value).toBe('suggesting');
    expect(b.actor.getSnapshot().context.errorKey).toBeNull();
    expect(b.suggestLocation).toHaveBeenLastCalledWith(SUGGEST_B);
  });

  it('SCAN sets scanned in ready', async () => {
    const { actor } = await ready();
    actor.send({ type: 'SCAN', value: 'A-01' });
    expect(actor.getSnapshot().context.scanned).toBe('A-01');
  });

  it('CONFIRM with a wrong code stays ready, wrongLocation, signalError once, no confirmPutaway', async () => {
    const { actor, confirmPutaway, signalError, signalOk } = await ready();
    actor.send({ type: 'SCAN', value: 'WRONG' });
    actor.send({ type: 'CONFIRM' });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe('ready');
    expect(snap.context.errorKey).toBe('putaway.error.wrongLocation');
    expect(signalError).toHaveBeenCalledTimes(ONCE);
    expect(signalOk).not.toHaveBeenCalled();
    expect(confirmPutaway).not.toHaveBeenCalled();
  });

  it('CONFIRM with the matching code -> confirming -> confirmed, confirmPutaway once, signalOk once', async () => {
    const { actor, confirmPutaway, signalOk, signalError } = await ready();
    actor.send({ type: 'SCAN', value: LOCATION.locationCode });
    actor.send({ type: 'CONFIRM' });
    expect(actor.getSnapshot().value).toBe('confirming');
    const snap = await waitFor(actor, (s) => s.value === 'confirmed');
    expect(confirmPutaway).toHaveBeenCalledTimes(ONCE);
    expect(confirmPutaway).toHaveBeenCalledWith({ locationId: LOCATION.locationId });
    expect(snap.context.errorKey).toBeNull();
    expect(signalOk).toHaveBeenCalledTimes(ONCE);
    expect(signalError).not.toHaveBeenCalled();
    expect(snap.status).toBe('done');
  });

  it('a matching CONFIRM clears an earlier wrongLocation error', async () => {
    const { actor } = await ready();
    actor.send({ type: 'SCAN', value: 'WRONG' });
    actor.send({ type: 'CONFIRM' });
    actor.send({ type: 'SCAN', value: LOCATION.locationCode });
    actor.send({ type: 'CONFIRM' });
    const snap = await waitFor(actor, (s) => s.value === 'confirmed');
    expect(snap.context.errorKey).toBeNull();
  });

  it('confirmPutaway rejecting -> ready with saveFailed, signalError once; a later CONFIRM can retry', async () => {
    let calls = 0;
    const { actor, confirmPutaway, signalError, signalOk } = await ready({
      confirm: async () => {
        calls += 1;
        if (calls === ONCE) {
          throw new Error('storage');
        }
      },
    });
    actor.send({ type: 'SCAN', value: LOCATION.locationCode });
    actor.send({ type: 'CONFIRM' });
    const failed = await waitFor(actor, (s) => s.value === 'ready');
    expect(failed.context.errorKey).toBe('pda.queue.saveFailed');
    expect(signalError).toHaveBeenCalledTimes(ONCE);
    actor.send({ type: 'CONFIRM' });
    await waitFor(actor, (s) => s.value === 'confirmed');
    expect(confirmPutaway).toHaveBeenCalledTimes(TWICE);
    expect(signalOk).toHaveBeenCalledTimes(ONCE);
  });

  it('confirmed ignores CONFIRM and SUGGEST_CHANGED', async () => {
    const { actor, confirmPutaway, suggestLocation } = await ready();
    actor.send({ type: 'SCAN', value: LOCATION.locationCode });
    actor.send({ type: 'CONFIRM' });
    await waitFor(actor, (s) => s.value === 'confirmed');
    actor.send({ type: 'CONFIRM' });
    actor.send({ type: 'SUGGEST_CHANGED', suggest: SUGGEST_B });
    expect(actor.getSnapshot().value).toBe('confirmed');
    expect(confirmPutaway).toHaveBeenCalledTimes(ONCE);
    expect(suggestLocation).toHaveBeenCalledTimes(ONCE);
  });

  it('SUGGEST_CHANGED while confirming is ignored: confirm still completes, no new suggest', async () => {
    let release: () => void = () => undefined;
    const { actor, suggestLocation, confirmPutaway, signalOk } = await ready({
      confirm: () => new Promise<void>((resolve) => (release = resolve)),
    });
    actor.send({ type: 'SCAN', value: LOCATION.locationCode });
    actor.send({ type: 'CONFIRM' });
    expect(actor.getSnapshot().value).toBe('confirming');
    actor.send({ type: 'SUGGEST_CHANGED', suggest: SUGGEST_B });
    expect(actor.getSnapshot().value).toBe('confirming');
    release();
    await waitFor(actor, (s) => s.value === 'confirmed');
    expect(signalOk).toHaveBeenCalledTimes(ONCE);
    expect(confirmPutaway).toHaveBeenCalledTimes(ONCE);
    expect(suggestLocation).toHaveBeenCalledTimes(ONCE);
  });

  it('SUGGEST_CHANGED with an equal suggest is ignored in suggesting, ready and unavailable', async () => {
    const EQUAL = { ...SUGGEST_A } as SuggestLocationInput;

    const a = setup();
    a.actor.send({ type: 'SUGGEST_CHANGED', suggest: EQUAL });
    expect(a.actor.getSnapshot().value).toBe('suggesting');
    await waitFor(a.actor, (s) => s.value === 'ready');
    expect(a.suggestLocation).toHaveBeenCalledTimes(ONCE);

    a.actor.send({ type: 'SUGGEST_CHANGED', suggest: EQUAL });
    expect(a.actor.getSnapshot().value).toBe('ready');
    expect(a.actor.getSnapshot().context.suggestion).toEqual(LOCATION);
    expect(a.suggestLocation).toHaveBeenCalledTimes(ONCE);

    const b = setup({
      suggest: async () => {
        throw new Error('down');
      },
    });
    await waitFor(b.actor, (s) => s.value === 'unavailable');
    b.actor.send({ type: 'SUGGEST_CHANGED', suggest: EQUAL });
    expect(b.actor.getSnapshot().value).toBe('unavailable');
    expect(b.actor.getSnapshot().context.errorKey).toBe('putaway.suggestion.unavailable');
    expect(b.suggestLocation).toHaveBeenCalledTimes(ONCE);
  });
});
