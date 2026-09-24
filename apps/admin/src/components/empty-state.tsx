// WBS 0.19 — generic, reusable EmptyState component (Master decision 4). Names the missing data
// and its owner — the two facts doc 40 §D1 requires of every empty-state component.
export interface EmptyStateProps {
  title: string;
  missing: string;
  owner: string;
}

export function EmptyState({ title, missing, owner }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-border p-8 text-center">
      <p className="text-base font-semibold">{title}</p>
      <p className="text-sm text-muted-foreground">{missing}</p>
      <p className="text-sm text-muted-foreground">{owner}</p>
    </div>
  );
}
