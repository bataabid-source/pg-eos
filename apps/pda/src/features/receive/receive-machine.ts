// WBS 2.16 part 2 — receive screen state machine (XState v5). Fields live in context; an
// accepted scan clears them in the same transition so a re-tap cannot enqueue the same scan twice.
import { assign, fromPromise, setup } from 'xstate';

import type { TranslationKey } from '../../i18n/t';
import type { ReceiveRefusalCode, ReceiveScan } from './client';
import type { SubmitResult } from './scan-queue';

export const REFUSAL_KEY: Record<ReceiveRefusalCode, TranslationKey> = {
  lineNotFound: 'receive.refused.lineNotFound',
  skuClientMismatch: 'receive.refused.skuClientMismatch',
  lineAlreadyReceived: 'receive.refused.lineAlreadyReceived',
};

export const STATUS_KEY: Record<'invalid' | 'offline' | 'failed', TranslationKey> = {
  invalid: 'receive.refused.invalidInput',
  offline: 'receive.offline.retry',
  failed: 'receive.error.unexpected',
};

const SAVE_FAILED_KEY: TranslationKey = 'pda.queue.saveFailed';

export type ReceiveFieldName = 'skuCode' | 'batchNo' | 'expiryDate' | 'qty';
export type ReceiveFields = Record<ReceiveFieldName, string>;

export interface ReceiveContext {
  orderId: string;
  fields: ReceiveFields;
  errorKey: TranslationKey | null;
}

export type ReceiveEvent = { type: 'FIELD'; name: ReceiveFieldName; value: string } | { type: 'SUBMIT' };

const EMPTY_FIELDS: ReceiveFields = { skuCode: '', batchNo: '', expiryDate: '', qty: '' };

type Refused = Exclude<SubmitResult, { status: 'accepted' }>;

function keyOf(result: Refused): TranslationKey {
  const byStatus: Record<Refused['status'], () => TranslationKey> = {
    refused: () => (result.status === 'refused' ? REFUSAL_KEY[result.code] : SAVE_FAILED_KEY),
    invalid: () => STATUS_KEY.invalid,
    offline: () => STATUS_KEY.offline,
    failed: () => STATUS_KEY.failed,
  };
  return byStatus[result.status]();
}

export const receiveMachine = setup({
  types: {
    input: {} as { orderId: string },
    context: {} as ReceiveContext,
    events: {} as ReceiveEvent,
  },
  actors: {
    submitScan: fromPromise<SubmitResult, ReceiveScan>(async () => {
      throw new Error('submitScan actor not provided');
    }),
  },
  actions: {
    signalOk: () => undefined,
    signalError: () => undefined,
    setField: assign({
      fields: ({ context, event }) =>
        event.type === 'FIELD' ? { ...context.fields, [event.name]: event.value } : context.fields,
    }),
  },
}).createMachine({
  id: 'receive',
  context: ({ input }) => ({ orderId: input.orderId, fields: { ...EMPTY_FIELDS }, errorKey: null }),
  initial: 'idle',
  states: {
    idle: { on: { FIELD: { actions: 'setField' }, SUBMIT: 'submitting' } },
    submitting: {
      entry: assign({ errorKey: () => null }),
      invoke: {
        src: 'submitScan',
        input: ({ context }) => ({ orderId: context.orderId, ...context.fields }),
        onDone: [
          {
            guard: ({ event }) => event.output.status === 'accepted',
            target: 'accepted',
            actions: ['signalOk', assign({ fields: () => ({ ...EMPTY_FIELDS }), errorKey: () => null })],
          },
          {
            target: 'rejected',
            actions: [
              'signalError',
              assign({
                errorKey: ({ event }) =>
                  event.output.status === 'accepted' ? null : keyOf(event.output),
              }),
            ],
          },
        ],
        onError: {
          target: 'rejected',
          actions: ['signalError', assign({ errorKey: () => SAVE_FAILED_KEY })],
        },
      },
    },
    accepted: { on: { FIELD: { actions: 'setField' }, SUBMIT: 'submitting' } },
    rejected: { on: { FIELD: { actions: 'setField' }, SUBMIT: 'submitting' } },
  },
});
