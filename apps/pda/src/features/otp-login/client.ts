// WBS 2.16 part 1a-4 — OtpLoginClient port (swappable client-port precedent, same pattern as
// apps/admin/src/features/decision-inbox/client.ts: no NestJS app exists anywhere in the
// workspace today, so this port is implemented by a mock until a real HTTP client exists).
//
// Input shapes mirror packages/contracts/identity/otp-login.ts's `RequestOtpCodeInputSchema`/
// `VerifyOtpCodeInputSchema` (email + code only — `correlationId` is a transport-layer concern,
// not part of this app-local port's surface).
//
// `verifyOtpCode` REJECTS with a plain `Error` (any message/shape) on every non-success outcome —
// the port never re-derives `InvalidOtpError`, that type belongs to `modules/identity` and is not
// imported here (brief, cross-module import boundary). The screen renders one uniform
// `login.error.invalidCode` string for every rejection, never branching on it (Master decision 3).
export interface OtpLoginClient {
  requestOtpCode(email: string): Promise<{ expiresInMinutes: number }>;
  verifyOtpCode(email: string, code: string): Promise<{ token: string; expiresAt: string }>;
}
