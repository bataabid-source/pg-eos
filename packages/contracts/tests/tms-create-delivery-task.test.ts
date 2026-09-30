// packages/contracts/tests/tms-create-delivery-task.test.ts — WBS 3.4 part 1, contract-first.
// Pure Zod schema + registry tests, no DB, no I/O. Precedent: billing-post-journal.test.ts.
//
// Covers tms/create-delivery-task.ts: CreateDeliveryTaskInputSchema (INV-C4-2, doc 40 line 274:
// area, block, street, recipientPhone required and non-empty) and the one registered ROUTE.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { registry } from '../index.js';
import {
  CreateDeliveryTaskInputSchema,
  ROUTES as TMS_CREATE_DELIVERY_TASK_ROUTES,
} from '../tms/create-delivery-task.js';

const VALID_ORDER_ID = '00000000-0000-4000-8000-000000000341';
const VALID_CORRELATION_ID = '00000000-0000-4000-8000-000000000342';
const MIN_VERSION = 1;
const BELOW_MIN_VERSION = 0;
const NON_INTEGER_VERSION = 1.5;
const EXPECTED_ROUTE_COUNT = 1;
const EXPECTED_PATH = '/tms/create-delivery-task/create-delivery-task';
const NOT_A_UUID = 'not-a-uuid';
const WHITESPACE_ONLY = '   ';
const TRIMMED_STRING_FIELDS = ['area', 'block', 'street', 'recipientPhone', 'recipientName'] as const;

const REQUIRED_ADDRESS_FIELDS = ['area', 'block', 'street', 'recipientPhone'] as const;
const OPTIONAL_FIELDS = ['building', 'addressText', 'governorate'] as const;

const validInput = {
  outboundOrderId: VALID_ORDER_ID,
  expectedVersion: MIN_VERSION,
  recipientName: 'Recipient',
  recipientPhone: '55512345',
  area: 'Salmiya',
  block: '5',
  street: 'Street 10',
  correlationId: VALID_CORRELATION_ID,
};

function without(field: string): Record<string, unknown> {
  const input: Record<string, unknown> = { ...validInput };
  delete input[field];
  return input;
}

describe('CreateDeliveryTaskInputSchema — valid input', () => {
  it('parses the minimal valid input', () => {
    expect(CreateDeliveryTaskInputSchema.safeParse(validInput).success).toBe(true);
  });

  it.each(OPTIONAL_FIELDS)('treats %s as optional (absent and present both parse)', (field) => {
    expect(CreateDeliveryTaskInputSchema.safeParse(without(field)).success).toBe(true);
    expect(CreateDeliveryTaskInputSchema.safeParse({ ...validInput, [field]: 'value' }).success).toBe(true);
  });
});

describe('CreateDeliveryTaskInputSchema — INV-C4-2 required address fields', () => {
  it.each(REQUIRED_ADDRESS_FIELDS)('refuses a missing %s', (field) => {
    expect(CreateDeliveryTaskInputSchema.safeParse(without(field)).success).toBe(false);
  });

  it.each(REQUIRED_ADDRESS_FIELDS)('refuses an empty-string %s', (field) => {
    expect(CreateDeliveryTaskInputSchema.safeParse({ ...validInput, [field]: '' }).success).toBe(false);
  });
});

describe('CreateDeliveryTaskInputSchema — whitespace-only strings', () => {
  it.each(TRIMMED_STRING_FIELDS)('refuses a whitespace-only %s', (field) => {
    expect(
      CreateDeliveryTaskInputSchema.safeParse({ ...validInput, [field]: WHITESPACE_ONLY }).success,
    ).toBe(false);
  });
});

describe('CreateDeliveryTaskInputSchema — other fields', () => {
  it('refuses a missing recipientName', () => {
    expect(CreateDeliveryTaskInputSchema.safeParse(without('recipientName')).success).toBe(false);
  });

  it('refuses expectedVersion = 0', () => {
    expect(
      CreateDeliveryTaskInputSchema.safeParse({ ...validInput, expectedVersion: BELOW_MIN_VERSION }).success,
    ).toBe(false);
  });

  it('refuses a non-integer expectedVersion', () => {
    expect(
      CreateDeliveryTaskInputSchema.safeParse({ ...validInput, expectedVersion: NON_INTEGER_VERSION }).success,
    ).toBe(false);
  });

  it.each(['outboundOrderId', 'correlationId'])('refuses a non-UUID %s', (field) => {
    expect(CreateDeliveryTaskInputSchema.safeParse({ ...validInput, [field]: NOT_A_UUID }).success).toBe(
      false,
    );
  });
});

describe('CreateDeliveryTaskInputSchema — property: INV-C4-2', () => {
  const nonEmpty = fc.string({ minLength: 1 }).filter((v) => v.trim().length > 0);
  const arbitraryInput = fc.record({
    outboundOrderId: fc.uuid(),
    correlationId: fc.uuid(),
    expectedVersion: fc.integer({ min: MIN_VERSION, max: Number.MAX_SAFE_INTEGER }),
    recipientName: nonEmpty,
    recipientPhone: nonEmpty,
    area: nonEmpty,
    block: nonEmpty,
    street: nonEmpty,
  });

  const blank = fc.oneof(
    fc.constant(''),
    fc.string({ unit: fc.constantFrom(' ', '\t'), minLength: 1 }),
  );

  it('parses when the four required fields are non-empty', () => {
    fc.assert(
      fc.property(arbitraryInput, (input) => {
        expect(CreateDeliveryTaskInputSchema.safeParse(input).success).toBe(true);
      }),
    );
  });

  it('fails when any one of the four required fields is replaced by an empty or whitespace-only string', () => {
    fc.assert(
      fc.property(arbitraryInput, fc.constantFrom(...REQUIRED_ADDRESS_FIELDS), blank, (input, field, bad) => {
        expect(CreateDeliveryTaskInputSchema.safeParse({ ...input, [field]: bad }).success).toBe(false);
      }),
    );
  });
});

describe('tms/create-delivery-task ROUTES', () => {
  it('declares exactly one POST route at the contract path, contractFirst', () => {
    expect(TMS_CREATE_DELIVERY_TASK_ROUTES.length).toBe(EXPECTED_ROUTE_COUNT);
    const [route] = TMS_CREATE_DELIVERY_TASK_ROUTES;
    expect(route?.method).toBe('POST');
    expect(route?.path).toBe(EXPECTED_PATH);
    expect(route?.contractFirst).toBe(true);
  });

  it('registers the path on the shared registry with a required Idempotency-Key header', () => {
    const document = registry.toOpenApiDocument();
    const pathItem = document.paths?.[EXPECTED_PATH] as Record<string, unknown> | undefined;
    expect(pathItem, `${EXPECTED_PATH} must be registered`).toBeDefined();
    const operation = pathItem?.post as
      | { parameters?: ReadonlyArray<{ name?: string; required?: boolean }> }
      | undefined;
    expect(operation, 'must be a POST operation').toBeDefined();
    const header = operation?.parameters?.find((p) => p.name?.toLowerCase() === 'idempotency-key');
    expect(header, 'must declare the Idempotency-Key header').toBeDefined();
    expect(header?.required).toBe(true);
  });
});
