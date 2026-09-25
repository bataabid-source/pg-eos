// WBS 0.19 — one card per open decision (Master decision 5, doc 29 §6-2 mockup).
import { Money } from '@pg-eos/domain-kit';

import { Card, CardContent, CardFooter, CardHeader } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import type { Locale } from '../../i18n/t';
import { t } from '../../i18n/t';
import { ACCENTED_URGENCIES } from './constants';
import type { DecisionItem } from './contract';

export interface DecisionCardProps {
  item: DecisionItem;
  locale: Locale;
}

// "N.NNN KWD" — Money.of/.toString() gives the numeric(14,3) formatting (packages/domain-kit);
// this brief's Master decision 5 requires exact numeric(14,3) precision, which rules out
// Number()/parseFloat() on the value itself. No local CURRENCY_CODE constant — Money.of(value)
// .currency is the one source of truth for the currency code (packages/domain-kit/money.ts),
// never duplicated (pg-reviewer WBS 1.9 round 2, finding R3).
function formatKwd(value: string): string {
  const amount = Money.of(value);
  return `${amount.toString()} ${amount.currency}`;
}

// `context` is jsonb (z.record(z.string(), z.unknown()) — Master decision 2 fix round 1): render
// every value as text, never as raw HTML/JSX (no free-form HTML, per the DDL's own comment).
function renderContextValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null || value === undefined) {
    return '';
  }
  return JSON.stringify(value);
}

export function DecisionCard({ item, locale }: DecisionCardProps) {
  const isAccented = ACCENTED_URGENCIES.has(item.urgency);
  const contextEntries = Object.entries(item.context);

  return (
    <Card data-testid="decision-card" data-item-id={item.id}>
      <CardHeader className="flex flex-row items-center gap-2">
        {isAccented ? (
          // Visual accent only (fix round 1, finding 7) — a coloured left border/icon, never the
          // raw DB urgency value as English text (that would bypass i18n); matches doc 29 §6-2's
          // "urgency-colored left border/icon" literally.
          <span
            data-testid="urgency-accent"
            aria-hidden="true"
            className="h-3 w-3 shrink-0 rounded-full bg-destructive"
          />
        ) : null}
        <p className="text-sm font-semibold">{item.titleAr}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 text-sm text-muted-foreground">
        <p>
          {contextEntries.map(([key, value], index) => (
            <span key={key}>
              {index > 0 ? ' · ' : ''}
              {key}: {renderContextValue(value)}
            </span>
          ))}
        </p>
        {item.financialImpact !== null ? (
          <p data-testid="financial-impact">{formatKwd(item.financialImpact)}</p>
        ) : null}
      </CardContent>
      <CardFooter>
        <Button
          type="button"
          variant="outline"
          disabled
          aria-disabled="true"
          data-testid="decision-action-disabled"
        >
          {t(locale, 'inbox.action.approve')}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled
          aria-disabled="true"
          data-testid="decision-action-disabled"
        >
          {t(locale, 'inbox.action.reject')}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled
          aria-disabled="true"
          data-testid="decision-action-disabled"
        >
          {t(locale, 'inbox.action.details')}
        </Button>
      </CardFooter>
    </Card>
  );
}
