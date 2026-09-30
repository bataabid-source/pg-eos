// WBS 2.16 part 2e — error message (role=alert).
import type { HTMLAttributes } from 'react';

export function Alert({ className = '', ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      role="alert"
      data-severity="error"
      className={`rounded-md bg-destructive p-3 text-destructive-foreground ${className}`}
      {...rest}
    />
  );
}
