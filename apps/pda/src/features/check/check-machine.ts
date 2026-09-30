// WBS 2.16 part 3 — check screen state machine (XState v5). An accepted check clears the scan in
// the same transition and ends the machine, so a re-tap cannot enqueue the same check twice.
import { assign, fromPromise, setup } from 'xstate';

import type { TranslationKey } from '../../i18n/t';
import type { CheckRefusalCode, CheckScan } from './client';
import type { CheckSubmitResult } from './check-queue';

export const REFUSAL_KEY: Record<CheckRefusalCode, TranslationKey> = {
  selfCheckNotAllowed: 'check.refused.selfCheckNotAllowed',
  orderNotFound: 'check.refused.orderNotFound',
};

export const STATUS_KEY: Record<'invalid' | 'offline' | 'failed', TranslationKey> = {
  invalid: 'check.refused.invalidInput',
  offline: 'check.offline.retry',
  failed: 'check.error.unexpected',
};

const SAVE_FAILED_KEY: TranslationKey = 'pda.queue.saveFailed';

export interface CheckContext {
  checkerId: string;
  orderCode: string;
  errorKey: TranslationKey | null;
}

export type CheckEvent = { type: 'SCAN'; value: string } | { type: 'SUBMIT' };

type Refused = Exclude<CheckSubmitResult, { status: 'accepted' }>;

function keyOf(result: Refused): TranslationKey {
  const byStatus: Record<Refused['status'], () => TranslationKey> = {
    refused: () => (result.status === 'refused' ? REFUSAL_KEY[result.code] : SAVE_FAILED_KEY),
    invalid: () => STATUS_KEY.invalid,
    offline: () => STATUS_KEY.offline,
    failed: () => STATUS_KEY.failed,
  };
  return byStatus[result.status]();
}

export const checkMachine = setup({
  types: {
    input: {} as { checkerId: string },
    context: {} as CheckContext,
    events: {} as CheckEvent,
  },
  actors: {
    submitScan: fromPromise<CheckSubmitResult, CheckScan>(async () => {
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
  id: 'check',
  context: ({ input }) => ({ checkerId: input.checkerId, orderCode: '', errorKey: null }),
  initial: 'ready',
  states: {
    ready: { on: { SCAN: { actions: 'setScan' }, SUBMIT: 'submitting' } },
    submitting: {
      entry: assign({ errorKey: () => null }),
      invoke: {
        src: 'submitScan',
        input: ({ context }) => ({ orderCode: context.orderCode, checkerId: context.checkerId }),
        onDone: [
          {
            guard: ({ event }) => event.output.status === 'accepted',
            target: 'checked',
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
    checked: { type: 'final' },
  },
});
