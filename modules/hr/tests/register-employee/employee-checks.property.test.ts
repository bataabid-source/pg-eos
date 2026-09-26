// modules/hr/tests/register-employee/employee-checks.property.test.ts — Master task P6a (pg-tester),
// written RED-first against docs/notes/SCR-HR-EMP-01-employee-checks.md §1 table, ahead of pg-backend
// adding the two pure functions below to modules/hr/domain/register-employee/invariants.ts (doc 36
// §5-4 #2: every invariant lives in domain/ as well as as a database constraint — the DB-constraint
// side of the same three rules is modules/hr/tests/integration/hr-employee-checks.test.ts).
//
// A separate file from ./invariants.property.test.ts on purpose: that file's P1/P2/P3 imports were
// already implemented when this file was added mid-slice, and had to stay GREEN throughout; this
// file's four named imports (assertDocTypeAllowed, assertEmployeeCodeFormat, DocumentTypeInvalidError,
// EmployeeCodeFormatInvalidError) did NOT exist at RED time — every "does not throw" assertion failed
// with `TypeError: ... is not a function` (Vite/vitest SSR resolves a missing named export to
// `undefined` rather than throwing at import time). pg-backend has since added both functions and
// both error classes (modules/hr/domain/register-employee/{invariants,errors}.ts) — this file is now
// GREEN and is the permanent regression suite for the two functions.
//
// Expected new domain surface (modules/hr/domain/register-employee/invariants.ts):
//   - `assertDocTypeAllowed(docType: string): void` — throws DocumentTypeInvalidError unless docType
//     is one of the 5 values SCR-HR-EMP-01 §1 row 2 names (residency, passport, license, health_card,
//     contract — 01-Data-Model.sql:1303's column comment), mirroring
//     chk_employee_documents_doc_type.
//   - `assertEmployeeCodeFormat(code: string): void` — throws EmployeeCodeFormatInvalidError unless
//     code matches ASCII `^PG-[0-9]{4}$` (Arabic-Indic digits ٠-٩ must NOT match — same rule as
//     chk_employees_code_format), mirroring the DB CHECK.
// New error classes expected in modules/hr/domain/register-employee/errors.ts, named consistently
// with that file's existing `<Subject><Problem>Error` pattern (DocumentDatesInvalidError,
// EmployeeCodeTakenError, EntityScopeAmbiguousError, …):
//   - `DocumentTypeInvalidError`
//   - `EmployeeCodeFormatInvalidError`

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// The module under test.
import { assertDocTypeAllowed, assertEmployeeCodeFormat } from '../../domain/register-employee/invariants.js';
import { DocumentTypeInvalidError, EmployeeCodeFormatInvalidError } from '../../domain/register-employee/errors.js';

// The five doc_type values SCR-HR-EMP-01 §1 row 2 names, copied verbatim from
// 01-Data-Model.sql:1303's column comment (never invented) — same list as
// modules/hr/tests/integration/hr-employee-checks.test.ts's VALID_DOC_TYPES.
const VALID_DOC_TYPES = ['residency', 'passport', 'license', 'health_card', 'contract'] as const;

// --- assertDocTypeAllowed ------------------------------------------------------------------------

describe('assertDocTypeAllowed — unit (mirrors chk_employee_documents_doc_type)', () => {
  it.each(VALID_DOC_TYPES)('does not throw for doc_type = %s', (docType) => {
    expect(() => assertDocTypeAllowed(docType)).not.toThrow();
  });

  it("throws DocumentTypeInvalidError for 'visa' (outside the 5 documented values)", () => {
    expect(() => assertDocTypeAllowed('visa')).toThrow(DocumentTypeInvalidError);
  });
});

describe('assertDocTypeAllowed — property', () => {
  it('never throws for any of the 5 documented values', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_DOC_TYPES), (docType) => {
        expect(() => assertDocTypeAllowed(docType)).not.toThrow();
      }),
    );
  });

  it('always throws DocumentTypeInvalidError for any string outside the 5 documented values', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !(VALID_DOC_TYPES as readonly string[]).includes(s)),
        (docType) => {
          expect(() => assertDocTypeAllowed(docType)).toThrow(DocumentTypeInvalidError);
        },
      ),
    );
  });
});

// --- assertEmployeeCodeFormat --------------------------------------------------------------------

// Arabic-Indic digit for '4' (٤, U+0664) — used to prove the ASCII-only character class rejects it,
// same non-ASCII-digit proof as modules/hr/tests/integration/hr-employee-checks.test.ts's 'PG-١٢٣٤'.
const ARABIC_INDIC_CODE = 'PG-٤٢٣٤'; // "PG-٤٢٣٤"

describe('assertEmployeeCodeFormat — unit (mirrors chk_employees_code_format)', () => {
  it('does not throw for "PG-0001"', () => {
    expect(() => assertEmployeeCodeFormat('PG-0001')).not.toThrow();
  });

  it.each(['PG-12', 'pg-1234', 'PG-12345', 'X-1234', 'XPG-1234', ARABIC_INDIC_CODE])(
    "throws EmployeeCodeFormatInvalidError for '%s'",
    (code) => {
      expect(() => assertEmployeeCodeFormat(code)).toThrow(EmployeeCodeFormatInvalidError);
    },
  );
});

describe('assertEmployeeCodeFormat — property', () => {
  it('never throws for "PG-" + any 4 ASCII digits', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9999 }), (n) => {
        const code = `PG-${String(n).padStart(4, '0')}`;
        expect(() => assertEmployeeCodeFormat(code)).not.toThrow();
      }),
    );
  });

  it('always throws EmployeeCodeFormatInvalidError for a string not matching ASCII ^PG-[0-9]{4}$', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/^PG-[0-9]{4}$/.test(s)),
        (code) => {
          expect(() => assertEmployeeCodeFormat(code)).toThrow(EmployeeCodeFormatInvalidError);
        },
      ),
    );
  });
});
