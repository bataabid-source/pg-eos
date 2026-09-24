// modules/hr/application/register-employee/index.ts — WBS 3.3.
//
// Barrel for the register-employee use case's four commands (application/ layer public surface).

export type { AuditTarget, ClockDeps, EmployeeRepository, RegisterEmployeeDeps } from './ports.js';
export { registerEmployee, type RegisterEmployeeInput, type RegisterEmployeeResult } from './register-employee.js';
export {
  recordEmployeeDocument,
  type RecordEmployeeDocumentInput,
  type RecordEmployeeDocumentResult,
} from './record-employee-document.js';
export {
  changeEmployeeStatus,
  type ChangeEmployeeStatusInput,
  type ChangeEmployeeStatusResult,
} from './change-employee-status.js';
export {
  checkDriverAssignable,
  type CheckDriverAssignableInput,
  type CheckDriverAssignableResult,
} from './check-driver-assignable.js';
