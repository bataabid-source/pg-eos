// WBS 2.16 part 3 — pick screen state machine (XState v5). An accepted pick clears the fields in
// the same transition and ends the machine, so a re-tap cannot enqueue the same pick twice.
import { assign, fromPromise, setup } from 'xstate';

import type { TranslationKey } from '../../i18n/t';
import type { PickRefusalCode, PickScan } from './client';
import type { PickSubmitResult } from './pick-queue';

export const REFUSAL_KEY: Record<PickRefusalCode, TranslationKey> = {
  lineNotFound: 'pick.refused.lineNotFound',
  lineAlreadyPicked: 'pick.refused.lineAlreadyPicked',
  qtyExceedsReserved: 'pick.refused.qtyExceedsReserved',
  lineNotReserved: 'pick.refused.lineNotReserved',
  varianceReasonRequired: 'pick.refused.varianceReasonRequired',
};

export const STATUS_KEY: Record<'invalid' | 'offline' | 'failed', TranslationKey> = {
  invalid: 'pick.refused.invalidInput',
  offline: 'pick.offline.retry',
  failed: 'pick.error.unexpected',
};

const SAVE_FAILED_KEY: TranslationKey = 'pda.queue.saveFailed';

export type PickFieldName = 'locationCode' | 'qtyActual' | 'varianceReason';
export type PickFields = Record<PickFieldName, string>;

export interface PickContext {
  orderId: string;
  lineId: string;
  fields: PickFields;
  errorKey: TranslationKey | null;
}

export type PickEvent = { type: 'FIELD'; name: PickFieldName; value: string } | { type: 'SUBMIT' };

const EMPTY_FIELDS: PickFields = { locationCode: '', qtyActual: '', varianceReason: '' };

type Refused = Exclude<PickSubmitResult, { status: 'accepted' }>;

function keyOf(result: Refused): TranslationKey {
  const byStatus: Record<Refused['status'], () => TranslationKey> = {
    refused: () => (result.status === 'refused' ? REFUSAL_KEY[result.code] : SAVE_FAILED_KEY),
    invalid: () => STATUS_KEY.invalid,
    offline: () => STATUS_KEY.offline,
    failed: () => STATUS_KEY.failed,
  };
  return byStatus[result.status]();
}

export const pickMachine = setup({
  types: {
    input: {} as { orderId: string; lineId: string },
    context: {} as PickContext,
    events: {} as PickEvent,
  },
  actors: {
    submitScan: fromPromise<PickSubmitResult, PickScan>(async () => {
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
  id: 'pick',
  context: ({ input }) => ({
    orderId: input.orderId,
    lineId: input.lineId,
    fields: { ...EMPTY_FIELDS },
    errorKey: null,
  }),
  initial: 'ready',
  states: {
    ready: { on: { FIELD: { actions: 'setField' }, SUBMIT: 'submitting' } },
    submitting: {
      entry: assign({ errorKey: () => null }),
      invoke: {
        src: 'submitScan',
        input: ({ context }) => ({ orderId: context.orderId, lineId: context.lineId, ...context.fields }),
        onDone: [
          {
            guard: ({ event }) => event.output.status === 'accepted',
            target: 'picked',
            actions: ['signalOk', assign({ fields: () => ({ ...EMPTY_FIELDS }), errorKey: () => null })],
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
    picked: { type: 'final' },
  },
});
