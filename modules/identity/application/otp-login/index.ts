// modules/identity/application/otp-login/index.ts — WBS 2.16 part 1a-3.
//
// Barrel for the otp-login use case's two commands (application/ layer public surface).

export type { Logger, LogFields, OtpLoginDeps } from './ports.js';
export { requestOtpCode, type RequestOtpCodeInput, type RequestOtpCodeResult } from './request-otp-code.js';
export { verifyOtpCode, type VerifyOtpCodeInput, type VerifyOtpCodeResult } from './verify-otp-code.js';
