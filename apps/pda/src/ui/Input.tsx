// WBS 2.16 part 2e — touch-sized text input (no autofocus; see ScanField).
import type { InputHTMLAttributes } from 'react';

import { TOUCH_TARGET_CLASS } from './tokens';

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`${TOUCH_TARGET_CLASS} w-full rounded-md border border-border bg-background px-3 text-start ${className}`}
      {...rest}
    />
  );
}
