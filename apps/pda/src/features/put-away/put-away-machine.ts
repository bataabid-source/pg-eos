// WBS 2.16 part 2 — put-away screen state machine (XState v5): suggest a location, the worker
// confirms it by scanning the code; confirmed is terminal for the line.
import { assign, fromPromise, setup } from 'xstate';
import type { SuggestLocationInput } from '@pg-eos/contracts/wms/receive-inbound';

import type { TranslationKey } from '../../i18n/t';

export interface PutawaySuggestion {
  locationId: string;
  locationCode: string;
}

export interface PutawayContext {
  suggest: SuggestLocationInput;
  suggestion: PutawaySuggestion | null;
  scanned: string;
  errorKey: TranslationKey | null;
}

export type PutawayEvent =
  | { type: 'RETRY' }
  | { type: 'SUGGEST_CHANGED'; suggest: SuggestLocationInput }
  | { type: 'SCAN'; value: string }
  | { type: 'CONFIRM' };

export const putawayMachine = setup({
  types: {
    input: {} as { suggest: SuggestLocationInput },
    context: {} as PutawayContext,
    events: {} as PutawayEvent,
  },
  actors: {
    suggestLocation: fromPromise<PutawaySuggestion, SuggestLocationInput>(async () => {
      throw new Error('suggestLocation actor not provided');
    }),
    confirmPutaway: fromPromise<void, { locationId: string }>(async () => {
      throw new Error('confirmPutaway actor not provided');
    }),
  },
  actions: {
    signalOk: () => undefined,
    signalError: () => undefined,
    resetSuggestion: assign({ suggestion: () => null, errorKey: () => null }),
    applySuggest: assign({
      suggest: ({ context, event }) => (event.type === 'SUGGEST_CHANGED' ? event.suggest : context.suggest),
      suggestion: () => null,
      errorKey: () => null,
    }),
    setScanned: assign({
      scanned: ({ context, event }) => (event.type === 'SCAN' ? event.value : context.scanned),
    }),
  },
  guards: {
    suggestDiffers: ({ context, event }) =>
      event.type === 'SUGGEST_CHANGED' &&
      (event.suggest.skuId !== context.suggest.skuId ||
        event.suggest.qty !== context.suggest.qty ||
        event.suggest.warehouseId !== context.suggest.warehouseId),
    matches: ({ context }) => context.suggestion !== null && context.scanned === context.suggestion.locationCode,
  },
}).createMachine({
  id: 'putaway',
  context: ({ input }) => ({ suggest: input.suggest, suggestion: null, scanned: '', errorKey: null }),
  initial: 'suggesting',
  states: {
    suggesting: {
      on: { SUGGEST_CHANGED: { guard: 'suggestDiffers', target: 'suggesting', reenter: true, actions: 'applySuggest' } },
      invoke: {
        src: 'suggestLocation',
        input: ({ context }) => context.suggest,
        onDone: { target: 'ready', actions: assign({ suggestion: ({ event }) => event.output }) },
        onError: {
          target: 'unavailable',
          actions: ['signalError', assign({ errorKey: () => 'putaway.suggestion.unavailable' as const })],
        },
      },
    },
    unavailable: {
      on: {
        RETRY: { target: 'suggesting', actions: 'resetSuggestion' },
        SUGGEST_CHANGED: { guard: 'suggestDiffers', target: 'suggesting', reenter: true, actions: 'applySuggest' },
      },
    },
    ready: {
      on: {
        SUGGEST_CHANGED: { guard: 'suggestDiffers', target: 'suggesting', reenter: true, actions: 'applySuggest' },
        SCAN: { actions: 'setScanned' },
        CONFIRM: [
          { guard: 'matches', target: 'confirming', actions: assign({ errorKey: () => null }) },
          {
            actions: ['signalError', assign({ errorKey: () => 'putaway.error.wrongLocation' as const })],
          },
        ],
      },
    },
    confirming: {
      invoke: {
        src: 'confirmPutaway',
        input: ({ context }) => ({ locationId: context.suggestion?.locationId ?? '' }),
        onDone: { target: 'confirmed', actions: 'signalOk' },
        onError: {
          target: 'ready',
          actions: ['signalError', assign({ errorKey: () => 'pda.queue.saveFailed' as const })],
        },
      },
    },
    confirmed: { type: 'final' },
  },
});
