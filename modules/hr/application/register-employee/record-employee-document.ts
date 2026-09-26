// modules/hr/application/register-employee/record-employee-document.ts — WBS 3.3.
//
// application/ layer, ONE withIdempotentContext transaction (step 0 — see
// ../../../../packages/db/src/idempotency.ts — runs first when input.idem is set). Lock order,
// same discipline as the golden slice's own receive-line.ts: (1) employee-row lock
// (repo.getEmployeeForUpdate) + expectedVersion check, (2) role gate (brief D6: PRO, HR_MGR or
// GM), (3) the pure domain invariant (assertDocumentDatesValid) — thrown before any write, (4) the
// document INSERT (never an UPDATE — brief: a renewal is a NEW row, history kept, D3), (5) the
// unconditional version bump on the employee row already locked in step 1, (6) the
// 'hr.employee_document.recorded' outbox event, (7) the audit row (last, ADR-0002).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import { assertDocTypeAllowed, assertDocumentDatesValid } from '../../domain/register-employee/invariants.js';
import { MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/register-employee/errors.js';
import type { RegisterEmployeeDeps } from './ports.js';

const AUDIT_OPERATION_RECORD_DOCUMENT = 'insert';
// Event name listed in packages/events/catalog.ts (added by the Master on MIGRATION-REQUEST-2,
// origin/main 8d7d337) — typed as CatalogedEventType, see ./register-employee.ts.
const DOCUMENT_RECORDED_EVENT_TYPE: CatalogedEventType = 'hr.employee_document.recorded';
const EMPLOYEE_DOCUMENTS_AGGREGATE_TYPE = 'hr.employee_documents';
// brief D6: RecordEmployeeDocument -> PRO, HR_MGR or GM (bp06 D08).
const RECORD_DOCUMENT_ROLES = ['PRO', 'HR_MGR', 'GM'] as const;

export interface RecordEmployeeDocumentInput {
  readonly employeeId: string;
  readonly docType: string;
  readonly docNo?: string | undefined;
  readonly issueDate?: string | undefined;
  readonly expiryDate: string;
  readonly fileUrl?: string | undefined;
  readonly alertDaysBefore?: number | undefined;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface RecordEmployeeDocumentResult {
  readonly id: string;
  readonly employeeVersion: number;
}

export async function recordEmployeeDocument(
  ctx: WithContextCtx,
  input: RecordEmployeeDocumentInput,
  deps: RegisterEmployeeDeps,
): Promise<RecordEmployeeDocumentResult> {
  if (!ctx.userId) throw new MissingActorError('RecordEmployeeDocument requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<RecordEmployeeDocumentResult>(ctx, input.idem, async (tx) => {
    const employee = await deps.repo.getEmployeeForUpdate(tx, input.employeeId);
    if (employee.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `RecordEmployeeDocument: expectedVersion ${input.expectedVersion} no longer matches ` +
          `employee ${input.employeeId}'s version ${employee.version} (optimistic lock).`,
      );
    }

    if (!(await deps.repo.hasAnyRole(tx, RECORD_DOCUMENT_ROLES))) {
      throw new RoleRequiredError(
        `RecordEmployeeDocument requires role ${RECORD_DOCUMENT_ROLES.join(' or ')} (platform.my_roles()).`,
      );
    }

    assertDocTypeAllowed(input.docType);
    assertDocumentDatesValid(input.issueDate ?? null, input.expiryDate);

    const insertedDocument = await deps.repo.insertEmployeeDocument(tx, {
      employeeId: input.employeeId,
      docType: input.docType,
      docNo: input.docNo ?? null,
      issueDate: input.issueDate ?? null,
      expiryDate: input.expiryDate,
      fileUrl: input.fileUrl ?? null,
      alertDaysBefore: input.alertDaysBefore ?? null,
    });

    const newEmployeeVersion = await deps.repo.bumpEmployeeVersion(tx, input.employeeId);
    const occurredAt = deps.clock.now();

    await writeOutboxEvent(tx, {
      entityId: employee.entityId,
      aggregateType: EMPLOYEE_DOCUMENTS_AGGREGATE_TYPE,
      aggregateId: insertedDocument.id,
      eventType: DOCUMENT_RECORDED_EVENT_TYPE,
      payload: { employeeId: input.employeeId, documentId: insertedDocument.id, docType: input.docType, expiryDate: input.expiryDate },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: employee.entityId,
      target: 'document',
      recordId: insertedDocument.id,
      operation: AUDIT_OPERATION_RECORD_DOCUMENT,
      correlationId: input.correlationId,
      actorId,
      newValue: { docType: input.docType, expiryDate: input.expiryDate, employeeVersion: newEmployeeVersion },
      occurredAt,
    });

    return { id: insertedDocument.id, employeeVersion: newEmployeeVersion };
  });
}
