// WBS 2.16 part 2e — the one large scan input per screen: autofocused on mount, refocusable
// through its ref (`refocus`).
import { forwardRef, useImperativeHandle, useRef } from 'react';
import type { InputHTMLAttributes } from 'react';

import { SCAN_FIELD_CLASS, TOUCH_TARGET_CLASS } from './tokens';

export interface ScanFieldHandle {
  refocus: () => void;
}

export interface ScanFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'autoFocus'> {
  label: string;
}

export const ScanField = forwardRef<ScanFieldHandle, ScanFieldProps>(function ScanField(
  { label, className = '', ...rest },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({
    refocus: () => inputRef.current?.focus(),
  }));
  return (
    <label className="flex flex-col gap-1 text-start">
      {label}
      <input
        ref={inputRef}
        autoFocus
        className={`${SCAN_FIELD_CLASS} ${TOUCH_TARGET_CLASS} w-full rounded-md border-2 border-primary bg-background px-3 text-xl text-start ${className}`}
        {...rest}
      />
    </label>
  );
});
