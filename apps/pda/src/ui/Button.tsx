// WBS 2.16 part 2e — touch-sized button.
import type { ButtonHTMLAttributes } from 'react';

import { TOUCH_TARGET_CLASS } from './tokens';

export function Button({ className = '', type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={`${TOUCH_TARGET_CLASS} rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50 ${className}`}
      {...rest}
    />
  );
}
