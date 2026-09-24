// WBS 0.19 — minimal shadcn-style Button primitive. Tailwind + CSS variables, no external UI
// library dependency (brief Master decision 1/15). RTL-safe: no directional margin/padding
// classes baked in here (start/end logical properties only, via Tailwind's ms-/me- utilities at
// call sites, none needed for this simple variant).
import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'outline' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:opacity-90',
  outline: 'border border-border bg-transparent text-foreground hover:bg-muted',
  ghost: 'bg-transparent text-foreground hover:bg-muted',
};

const BASE_CLASSES =
  'inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium ' +
  'transition-colors disabled:opacity-50 disabled:pointer-events-none aria-disabled:opacity-50';

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  const classes = `${BASE_CLASSES} ${VARIANT_CLASSES[variant]} ${className}`.trim();
  return <button className={classes} {...props} />;
}
