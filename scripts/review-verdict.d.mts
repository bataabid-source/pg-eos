export interface ReviewComment {
  readonly id?: number;
  readonly html_url?: string;
  readonly user: { readonly login: string; readonly type?: string };
  readonly created_at: string;
  readonly body: string;
}

export interface PickedVerdict {
  readonly verdict: 'PASS' | 'FAIL';
  readonly findings: number;
  readonly security: number;
  readonly comment: ReviewComment;
}

export function pickVerdict(
  comments: ReadonlyArray<ReviewComment> | ReadonlyArray<ReadonlyArray<ReviewComment>>,
  opts: { readonly since: string; readonly author?: string },
): PickedVerdict | null;
