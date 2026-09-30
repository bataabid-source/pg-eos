// WBS 2.16 part 3 — load screen state machine (XState v5). An accepted load clears the scan in
// the same transition and ends the machine, so a re-tap cannot enqueue the same load twice.
import { assign, fromPromise, setup } from 'xstate';

import type { TranslationKey } from '../../i18n/t';
import type { LoadRefusalCode, LoadScan } from './client';
import type { LoadSubmitResult } from './load-queue';

export const REFUSAL_KEY: Record<LoadRefusalCode, TranslationKey> = {
  orderNotPacked: 'load.refused.orderNotPacked',
  orderNotFound: 'load.refused.orderNotFound',
};

export const STATUS_KEY: Record<'invalid' | 'offline' | 'failed', TranslationKey> = {
  invalid: 'load.refused.invalidInput',
  offline: 'load.offline.retry',
  failed: 'load.error.unexpected',
};

const SAVE_FAILED_KEY: TranslationKey = 'pda.queue.saveFailed';

export interface LoadContext {
  orderCode: string;
  errorKey: TranslationKey | null;
}

export type LoadEvent = { type: 'SCAN'; value: string } | { type: 'SUBMIT' };

type Refused = Exclude<LoadSubmitResult, { status: 'accepted' }>;

function keyOf(result: Refused): TranslationKey {
  const byStatus: Record<Refused['status'], () => TranslationKey> = {
    refused: () => (result.status === 'refused' ? REFUSAL_KEY[result.code] : SAVE_FAILED_KEY),
    invalid: () => STATUS_KEY.invalid,
    offline: () => STATUS_KEY.offline,
    failed: () => STATUS_KEY.failed,
  };
  return byStatus[result.status]();
}

export const loadMachine = setup({
  types: {
    input: {} as { unused?: never },
    context: {} as LoadContext,
    events: {} as LoadEvent,
  },
  actors: {
    submitScan: fromPromise<LoadSubmitResult, LoadScan>(async () => {
      throw new Error('submitScan actor not provided');
    }),
  },
  actions: {
    signalOk: () => undefined,
    signalError: () => undefined,
    setScan: assign({
      orderCode: ({ context, event }) => (event.type === 'SCAN' ? event.value : context.orderCode),
    }),
  },
}).createMachine({
  id: 'load',
  context: () => ({ orderCode: '', errorKey: null }),
  initial: 'ready',
  states: {
    ready: { on: { SCAN: { actions: 'setScan' }, SUBMIT: 'submitting' } },
    submitting: {
      entry: assign({ errorKey: () => null }),
      invoke: {
        src: 'submitScan',
        input: ({ context }) => ({ orderCode: context.orderCode }),
        onDone: [
          {
            guard: ({ event }) => event.output.status === 'accepted',
            target: 'loaded',
            actions: ['signalOk', assign({ orderCode: () => '', errorKey: () => null })],
          },
          {
            target: 'ready',
            actions: [
              'signalError',
              assign({
                errorKey: ({ event }) => (event.output.status === 'accepted' ? null : keyOf(event.output)),
              }),
            ],
          },
        ],
        onError: {
          target: 'ready',
          actions: ['signalError', assign({ errorKey: () => SAVE_FAILED_KEY })],
        },
      },
    },
    loaded: { type: 'final' },
  },
});
