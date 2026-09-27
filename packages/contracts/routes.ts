// packages/contracts/routes.ts — Master task, docs/STREAMS.md §Enablement item 6: "a real OpenAPI
// document." Browser-safe (zod only, no node imports) — apps/ import `@pg-eos/contracts`.
//
// Aggregates every module's own `ROUTES` export (one per packages/contracts/<module>/<usecase>.ts
// that has a matching modules/<module>/api/<usecase>/handlers.ts) and registers them all on the
// given registry. index.ts calls `registerRoutes(registry)` once, at import time, on the shared
// `registry` singleton.
//
// billing/{dimensions,accounting-periods,post-journal} register ahead of their handlers: the
// contract-first wave (ADR-0005 §3) freezes them before lane 2 builds WBS 4.1b part 2, 4.19, 4.20.
//
// Modules with no `ROUTES` export today (never invented here — brief default, closing report):
//   - billing/chart-of-accounts, billing/gl-account-change-requests — no api layer yet.
//   - sales/customer-profile, sales/resolve-price — no handlers.ts exists yet (composition.ts's
//     own header comment: "No API endpoint exists yet").

import type { ContractRegistry } from './_shared/registry.js';
import { ROUTES as BILLING_ACCOUNTING_PERIODS_ROUTES } from './billing/accounting-periods.js';
import { ROUTES as BILLING_DIMENSIONS_ROUTES } from './billing/dimensions.js';
import { ROUTES as BILLING_POST_JOURNAL_ROUTES } from './billing/post-journal.js';
import { ROUTES as CATALOG_MAINTAIN_PRICE_LIST_ROUTES } from './catalog/maintain-price-list.js';
import { ROUTES as FLEET_ASSERT_VEHICLE_ASSIGNABLE_ROUTES } from './fleet/assert-vehicle-assignable.js';
import { ROUTES as FLEET_REGISTER_VEHICLE_ROUTES } from './fleet/register-vehicle.js';
import { ROUTES as HR_CALCULATE_DAILY_COMMISSION_ROUTES } from './hr/calculate-daily-commission.js';
import { ROUTES as HR_CONFIRM_COMMISSION_ROUTES } from './hr/confirm-commission.js';
import { ROUTES as HR_DISPUTE_COMMISSION_ROUTES } from './hr/dispute-commission.js';
import { ROUTES as HR_MAINTAIN_SHIFT_ROUTES } from './hr/maintain-shift.js';
import { ROUTES as HR_REGISTER_EMPLOYEE_ROUTES } from './hr/register-employee.js';
import { ROUTES as IDENTITY_OTP_LOGIN_ROUTES } from './identity/otp-login.js';
import { ROUTES as IMILE_ASSIGN_DRIVER_ID_ROUTES } from './imile/assign-driver-id.js';
import { ROUTES as IMILE_EVALUATE_DTL_PROBLEM_ROUTES } from './imile/evaluate-dtl-problem.js';
import { ROUTES as IMILE_PULL_SHIPMENTS_ROUTES } from './imile/pull-shipments.js';
import { ROUTES as IMILE_REPORT_AGENT_HEALTH_ROUTES } from './imile/report-agent-health.js';
import { ROUTES as PLATFORM_EVALUATE_ALERTS_ROUTES } from './platform/evaluate-alerts.js';
import { ROUTES as PLATFORM_MAINTAIN_SITE_ROUTES } from './platform/maintain-site.js';
import { ROUTES as SALES_MANAGE_ACCOUNT_CREDIT_ROUTES } from './sales/manage-account-credit.js';
import { ROUTES as SALES_MANAGE_CONTRACT_ROUTES } from './sales/manage-contract.js';
import { ROUTES as SALES_MANAGE_QUOTE_ROUTES } from './sales/manage-quote.js';
import { ROUTES as WMS_COUNT_INVENTORY_ROUTES } from './wms/count-inventory.js';
import { ROUTES as WMS_MANAGE_SPACE_ROUTES } from './wms/manage-space.js';
import { ROUTES as WMS_PROCESS_OUTBOUND_ROUTES } from './wms/process-outbound.js';
import { ROUTES as WMS_RECEIVE_INBOUND_ROUTES } from './wms/receive-inbound.js';
import { ROUTES as WMS_SCHEDULE_INBOUND_ROUTES } from './wms/schedule-inbound.js';
import { ROUTES as WMS_TAKE_OCCUPANCY_SNAPSHOT_ROUTES } from './wms/take-occupancy-snapshot.js';

/** Every registered route, module by module (alphabetical, matching `ls packages/contracts` module
 * directories). Exported so tests can assert the exact fixture count without re-scanning modules/
 * at test time. */
export const ALL_ROUTES = [
  ...BILLING_ACCOUNTING_PERIODS_ROUTES,
  ...BILLING_DIMENSIONS_ROUTES,
  ...BILLING_POST_JOURNAL_ROUTES,
  ...CATALOG_MAINTAIN_PRICE_LIST_ROUTES,
  ...FLEET_ASSERT_VEHICLE_ASSIGNABLE_ROUTES,
  ...FLEET_REGISTER_VEHICLE_ROUTES,
  ...HR_CALCULATE_DAILY_COMMISSION_ROUTES,
  ...HR_CONFIRM_COMMISSION_ROUTES,
  ...HR_DISPUTE_COMMISSION_ROUTES,
  ...HR_MAINTAIN_SHIFT_ROUTES,
  ...HR_REGISTER_EMPLOYEE_ROUTES,
  ...IDENTITY_OTP_LOGIN_ROUTES,
  ...IMILE_ASSIGN_DRIVER_ID_ROUTES,
  ...IMILE_EVALUATE_DTL_PROBLEM_ROUTES,
  ...IMILE_PULL_SHIPMENTS_ROUTES,
  ...IMILE_REPORT_AGENT_HEALTH_ROUTES,
  ...PLATFORM_EVALUATE_ALERTS_ROUTES,
  ...PLATFORM_MAINTAIN_SITE_ROUTES,
  ...SALES_MANAGE_ACCOUNT_CREDIT_ROUTES,
  ...SALES_MANAGE_CONTRACT_ROUTES,
  ...SALES_MANAGE_QUOTE_ROUTES,
  ...WMS_COUNT_INVENTORY_ROUTES,
  ...WMS_MANAGE_SPACE_ROUTES,
  ...WMS_PROCESS_OUTBOUND_ROUTES,
  ...WMS_RECEIVE_INBOUND_ROUTES,
  ...WMS_SCHEDULE_INBOUND_ROUTES,
  ...WMS_TAKE_OCCUPANCY_SNAPSHOT_ROUTES,
];

/** Registers every module's routes on `registry`. Called once, at import time, from index.ts on
 * the shared `registry` singleton. */
export function registerRoutes(registry: ContractRegistry): void {
  for (const route of ALL_ROUTES) {
    registry.registerRoute(route);
  }
}
