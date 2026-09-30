// WBS 2.16 part 2e — non-error status message (role=status).
import type { HTMLAttributes } from 'react';

export function Status({ className = '', ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return <p role="status" className={`rounded-md bg-muted p-3 text-foreground ${className}`} {...rest} />;
}
