// WBS 0.19 — minimal shadcn-style Badge primitive.
import type { HTMLAttributes } from 'react';

export type BadgeVariant = 'neutral' | 'destructive';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  neutral: 'bg-muted text-muted-foreground',
  destructive: 'bg-destructive text-destructive-foreground',
};

export function Badge({ variant = 'neutral', className = '', ...props }: BadgeProps) {
  const classes =
    `inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ` +
    `${VARIANT_CLASSES[variant]} ${className}`.trim();
  return <span className={classes} {...props} />;
}
