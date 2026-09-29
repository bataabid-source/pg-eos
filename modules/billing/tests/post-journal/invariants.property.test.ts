// modules/billing/tests/post-journal/invariants.property.test.ts — WBS 4.20 (lane 2).
//
// fast-check properties for the 4.20 invariants (brief: "for any generated set of lines, commit
// succeeds <=> sum(debit) = sum(credit), and G2 stays empty"). Two layers:
//   (A) PURE domain — modules/billing/domain/post-journal/invariants.ts against an INDEPENDENT
//       BigInt reference written in this file (never importing the real one back): amounts are
//       decimal STRINGS (numeric(14,3), same shape as packages/contracts/billing/post-journal.ts
//       AMOUNT), never float. No Date / Math.random in the code under test.
//   (B) DATABASE — the deferred constraint trigger (#6, chk_journal_entry_balanced): every generated
//       entry is written line by line in ONE transaction and COMMITted; the commit succeeds iff the
//       entry has >= 2 lines and sum(debit) = sum(credit) (numeric). Refused commits roll back;
//       accepted ones are balanced by construction, tracked and force-deleted in afterAll (this
//       file's OWN rows, replica role — the 4.19 precedent; D-183 permits afterAll cleanup of the
//       suite's own rows). Run with PGDATABASE=pgeos_lane2.
//
// Surface — modules/billing/domain/post-journal/invariants.ts (builder to provide):
//   type AmountLine = { debit?: string | undefined; credit?: string | undefined };
//   - `isBalanced(lines: readonly AmountLine[]): boolean` — lines.length >= 2 AND sum(debit) = sum(credit)
//     in exact decimal arithmetic (an omitted side is 0).
//   - `assertBalanced(lines: readonly AmountLine[]): void` — throws InsufficientLinesError when
//     lines.length < 2 (checked first), else UnbalancedEntryError when the sums differ.
//   - `mirrorLines<T extends AmountLine>(lines: readonly T[]): T[]` — same order, same other fields,
//     each line's debit and credit swapped (a reversing entry's lines).
//   - `toMilli(amount: string): bigint` — numeric(14,3) string -> integer thousandths.

import { randomUUID } from 'node:crypto';

import fc from 'fast-check';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InsufficientLinesError, UnbalancedEntryError } from '../../domain/post-journal/errors.js';
import { assertBalanced, isBalanced, mirrorLines, toMilli } from '../../domain/post-journal/invariants.js';

const MILLI_PER_UNIT = 1000n;
const MAX_MILLI = 99_999_999_999_999n; // 11 integer digits + 3 fractional = numeric(14,3) ceiling, contract AMOUNT.
const CHECK_VIOLATION = '23514';
const BALANCE_CONSTRAINT = 'chk_journal_entry_balanced';
const DB_ENTRY_DATE = '1700-01-01'; // no accounting period ever covers it (4.19 synthetic years are 1899+).
const DB_NUM_RUNS = 25;
const UNIT_NUM_RUNS = 300;
const MAX_LINES = 6;

type Line = { debit?: string; credit?: string };

// Independent reference: format integer thousandths as a decimal string in one of three legal shapes.
function formatMilli(milli: bigint, shape: 0 | 1 | 2): string {
  const whole = milli / MILLI_PER_UNIT;
  const frac = (milli % MILLI_PER_UNIT).toString().padStart(3, '0');
  if (shape === 0) return `${whole}.${frac}`; // always 3 fractional digits
  const trimmed = frac.replace(/0+$/, '');
  if (trimmed === '') return whole.toString(); // no fractional part at all
  return shape === 1 ? `${whole}.${trimmed}` : `${whole}.${frac}`;
}

function refMilli(amount: string | undefined): bigint {
  if (amount === undefined) return 0n;
  const [whole = '0', frac = ''] = amount.split('.');
  return BigInt(whole) * MILLI_PER_UNIT + BigInt(frac.padEnd(3, '0'));
}

function refBalanced(lines: readonly Line[]): boolean {
  const debit = lines.reduce((sum, line) => sum + refMilli(line.debit), 0n);
  const credit = lines.reduce((sum, line) => sum + refMilli(line.credit), 0n);
  return lines.length >= 2 && debit === credit;
}

const smallMilli = fc.bigInt({ min: 1n, max: 5_000_000n });
const shapeArb = fc.constantFrom<0 | 1 | 2>(0, 1, 2);

// One-side-only line (01:1212 one_side_only): a positive debit XOR a positive credit.
const lineArb: fc.Arbitrary<Line> = fc
  .tuple(fc.boolean(), smallMilli, shapeArb)
  .map(([isDebit, milli, shape]) => (isDebit ? { debit: formatMilli(milli, shape) } : { credit: formatMilli(milli, shape) }));

const arbitraryLines = fc.array(lineArb, { minLength: 0, maxLength: MAX_LINES });

// A guaranteed-balanced set: n debits and m credits splitting the same total.
const balancedLines: fc.Arbitrary<Line[]> = fc
  .tuple(fc.array(smallMilli, { minLength: 1, maxLength: 4 }), fc.integer({ min: 1, max: 4 }), shapeArb)
  .chain(([debitAmounts, creditCount, shape]) => {
    const total = debitAmounts.reduce((a, b) => a + b, 0n);
    return fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: creditCount, maxLength: creditCount }).map((weights) => {
      const weightSum = BigInt(weights.reduce((a, b) => a + b, 0));
      const credits: bigint[] = weights.map((w) => (total * BigInt(w)) / weightSum);
      const assigned = credits.reduce((a, b) => a + b, 0n);
      credits[0] = (credits[0] ?? 0n) + (total - assigned); // remainder to the first credit
      return [
        ...debitAmounts.map((m) => ({ debit: formatMilli(m, shape) })),
        ...credits.filter((c) => c > 0n).map((m) => ({ credit: formatMilli(m, shape) })),
      ];
    });
  });

/** Matches by `.name`, so an undefined/missing class can never satisfy the assertion (RED review #1). */
function expectThrowsNamed(fn: () => unknown, name: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected ${name} to be thrown`).toBeInstanceOf(Error);
  expect((thrown as Error).name).toBe(name);
}

describe('(A) pure domain — isBalanced / assertBalanced / mirrorLines / toMilli', () => {
  beforeAll(() => {
    // Not vacuous: every imported class/function must really exist before any property runs.
    for (const [label, value] of Object.entries({ InsufficientLinesError, UnbalancedEntryError, assertBalanced, isBalanced, mirrorLines, toMilli })) {
      expect(typeof value, label).toBe('function');
    }
  });

  it('toMilli parses numeric(14,3) decimal strings exactly (independent reference)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MAX_MILLI }), shapeArb, (milli, shape) => {
        expect(toMilli(formatMilli(milli, shape))).toBe(milli);
      }),
      { numRuns: UNIT_NUM_RUNS },
    );
  });

  it('isBalanced <=> at least two lines AND sum(debit) = sum(credit), for arbitrary line sets', () => {
    fc.assert(
      fc.property(fc.oneof(arbitraryLines, balancedLines), (lines) => {
        expect(isBalanced(lines)).toBe(refBalanced(lines));
      }),
      { numRuns: UNIT_NUM_RUNS },
    );
  });

  it('a generated balanced set is accepted; nudging any one line by one thousandth is refused', () => {
    fc.assert(
      fc.property(balancedLines, fc.nat(), (lines, pick) => {
        fc.pre(lines.length >= 2 && refBalanced(lines));
        expect(isBalanced(lines)).toBe(true);
        expect(() => assertBalanced(lines)).not.toThrow();
        const index = pick % lines.length;
        const nudged = lines.map((line, i) => {
          if (i !== index) return line;
          return line.debit !== undefined ? { debit: formatMilli(refMilli(line.debit) + 1n, 0) } : { credit: formatMilli(refMilli(line.credit) + 1n, 0) };
        });
        expect(isBalanced(nudged)).toBe(false);
        expectThrowsNamed(() => assertBalanced(nudged), 'UnbalancedEntryError');
      }),
      { numRuns: UNIT_NUM_RUNS },
    );
  });

  it('assertBalanced throws InsufficientLinesError for fewer than two lines, UnbalancedEntryError otherwise', () => {
    fc.assert(
      fc.property(fc.oneof(arbitraryLines, balancedLines), (lines) => {
        if (lines.length < 2) {
          expectThrowsNamed(() => assertBalanced(lines), 'InsufficientLinesError');
        } else if (refBalanced(lines)) {
          expect(() => assertBalanced(lines)).not.toThrow();
        } else {
          expectThrowsNamed(() => assertBalanced(lines), 'UnbalancedEntryError');
        }
      }),
      { numRuns: UNIT_NUM_RUNS },
    );
  });

  it('no float arithmetic: 0.1 + 0.2 balances 0.3, and the largest amounts do not lose precision', () => {
    expect(isBalanced([{ debit: '0.1' }, { debit: '0.2' }, { credit: '0.3' }])).toBe(true);
    expect(isBalanced([{ debit: '99999999999.999' }, { credit: '99999999999.998' }])).toBe(false);
    expect(isBalanced([{ debit: '99999999999.999' }, { credit: '99999999999.999' }])).toBe(true);
    expect(isBalanced([{ debit: '1' }, { credit: '1.000' }])).toBe(true);
  });

  it('mirrorLines swaps debit and credit per line, preserves order and other fields, and keeps a balanced set balanced', () => {
    fc.assert(
      fc.property(balancedLines, (lines) => {
        const tagged = lines.map((line, i) => ({ ...line, accountId: `account-${i}` }));
        const mirrored = mirrorLines(tagged);
        expect(mirrored).toHaveLength(tagged.length);
        mirrored.forEach((line, i) => {
          const original = tagged[i];
          expect(line.accountId).toBe(original?.accountId);
          expect(refMilli(line.debit)).toBe(refMilli(original?.credit));
          expect(refMilli(line.credit)).toBe(refMilli(original?.debit));
        });
        expect(refBalanced(mirrored)).toBe(refBalanced(tagged));
        expect(isBalanced(mirrored)).toBe(isBalanced(tagged));
      }),
      { numRuns: UNIT_NUM_RUNS },
    );
  });
});

// --- (B) the database: commit succeeds <=> sum(debit) = sum(credit) (>= 2 lines) ----------------------

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 4,
});

let entityId: string;
let accountId: string;
const trackedEntryIds: string[] = [];

beforeAll(async () => {
  const entity = await pool.query<{ id: string }>(`select id from platform.entities where code = 'PST'`);
  const row = entity.rows[0];
  if (!row) throw new Error("platform.entities row not found for code 'PST'");
  entityId = row.id;
  const code = `9-${randomUUID().replace(/\D/g, '').padEnd(11, '0').slice(0, 2)}-${randomUUID().replace(/\D/g, '').padEnd(6, '0').slice(0, 3)}-${randomUUID().replace(/\D/g, '').padEnd(6, '0').slice(0, 3)}`;
  const account = await pool.query<{ id: string }>(
    `insert into billing.gl_accounts (entity_id, code, name_ar, account_type) values ($1, $2, $3, 'expense') returning id`,
    [entityId, code, 'حساب اختبار خصائص القيد — WBS 4.20'],
  );
  const accountRow = account.rows[0];
  if (!accountRow) throw new Error('fixture gl_accounts insert returned no id');
  accountId = accountRow.id;
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local session_replication_role = replica`);
    if (trackedEntryIds.length > 0) {
      await client.query(`delete from billing.journal_lines where entry_id = any($1::uuid[])`, [trackedEntryIds]);
      await client.query(`delete from billing.journal_entries where id = any($1::uuid[])`, [trackedEntryIds]);
    }
    await client.query(`delete from billing.gl_accounts where id = $1`, [accountId]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});

/** Writes the entry then its lines ONE STATEMENT AT A TIME, then COMMITs. Resolves to 'committed' or
 *  the SQLSTATE + message of the refusal. */
async function commitEntry(lines: readonly Line[]): Promise<{ outcome: 'committed' } | { outcome: 'refused'; code: string; message: string }> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const inserted = await client.query<{ id: string }>(
      `insert into billing.journal_entries (entity_id, doc_no, entry_date, description, entry_type, posted_at, posted_by)
       values ($1, $2, $3, $4, 'accrual', now(), $5) returning id`,
      [entityId, `JE-PROP-${randomUUID().slice(0, 12)}`, DB_ENTRY_DATE, 'قيد اختبار خصائص — WBS 4.20', randomUUID()],
    );
    const entryId = inserted.rows[0]?.id;
    if (!entryId) throw new Error('fixture journal_entries insert returned no id');
    trackedEntryIds.push(entryId);
    for (const line of lines) {
      await client.query(`insert into billing.journal_lines (entry_id, account_id, debit, credit) values ($1, $2, $3, $4)`, [
        entryId,
        accountId,
        line.debit ?? '0',
        line.credit ?? '0',
      ]);
    }
    await client.query('commit');
    return { outcome: 'committed' };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    const err = error as { code?: string; message?: string; constraint?: string };
    return { outcome: 'refused', code: err.code ?? 'unknown', message: `${err.constraint ?? ''} ${err.message ?? ''}` };
  } finally {
    client.release();
  }
}

describe('(B) database — the deferred balance trigger (#6): commit succeeds <=> at least two lines and sum(debit) = sum(credit)', () => {
  it('for any generated set of one-sided lines, COMMIT is accepted iff balanced; a refusal is SQLSTATE 23514 chk_journal_entry_balanced', async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(arbitraryLines, balancedLines), async (lines) => {
        const result = await commitEntry(lines);
        if (refBalanced(lines)) {
          expect(result).toEqual({ outcome: 'committed' });
        } else {
          expect(result.outcome).toBe('refused');
          if (result.outcome === 'refused') {
            expect(result.code).toBe(CHECK_VIOLATION);
            expect(result.message).toContain(BALANCE_CONSTRAINT);
          }
        }
      }),
      { numRuns: DB_NUM_RUNS },
    );
  });

  it('G2 stays empty: billing.verify_journal_balance() returns zero rows after every generated commit', async () => {
    expect(trackedEntryIds.length, 'the property above must have written entries, or this check is vacuous').toBeGreaterThan(0);
    const rows = await pool.query(`select * from billing.verify_journal_balance()`);
    expect(rows.rows).toHaveLength(0);
  });
});
