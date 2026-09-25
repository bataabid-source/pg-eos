// WBS 1.9 — ReadinessChecklist component (Master decision 8), sibling to EmptyState. Renders a
// LIST of `{item, present, owner}` rows — the "what's missing before go-live" bar doc 40 §D1's
// "profile" pattern requires — plus a positive "all clear" state when every item is present
// (brief UI scenario 3: "not an empty list silently").
// `item` is the raw readiness code (used as the DOM `data-item` value); `label`/`status`/`owner`
// are already-translated display strings — i18n lives in the screen, not this generic component
// (mirrors EmptyState taking pre-translated strings as props). `status` is the visible
// present/missing text (fix round 1, finding 5 — previously only exposed via the DOM
// `data-present` attribute, never visible to a sighted user).
export interface ReadinessItem {
  item: string;
  label: string;
  status: string;
  present: boolean;
  owner: string;
}

export interface ReadinessChecklistProps {
  items: ReadinessItem[];
  allClearLabel: string;
}

export function ReadinessChecklist({ items, allClearLabel }: ReadinessChecklistProps) {
  const allPresent = items.length > 0 && items.every((row) => row.present);

  return (
    <div
      data-testid="readiness-checklist"
      className="flex flex-col gap-2 rounded-lg border border-border p-4"
    >
      {allPresent ? (
        <p data-testid="readiness-all-clear" className="text-sm font-semibold">
          {allClearLabel}
        </p>
      ) : null}
      <ul className="flex flex-col gap-1">
        {items.map((row) => (
          <li
            key={row.item}
            data-testid="readiness-item"
            data-item={row.item}
            data-present={String(row.present)}
            className="flex items-center justify-between gap-4 text-sm"
          >
            <span>{row.label}</span>
            <span data-testid="readiness-status">{row.status}</span>
            {!row.present ? (
              <span data-testid="readiness-owner" className="text-muted-foreground">
                {row.owner}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
