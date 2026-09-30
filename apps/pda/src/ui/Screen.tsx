// WBS 2.16 part 2e — one-step screen layout: a title and ONE child step.
import type { ReactNode } from 'react';

import { ONE_STEP_TEST_ID } from './tokens';

export interface ScreenProps {
  title: string;
  children?: ReactNode;
  'data-testid'?: string;
}

export function Screen({ title, children, 'data-testid': testId }: ScreenProps) {
  return (
    <section data-testid={ONE_STEP_TEST_ID} className="flex min-h-screen flex-col gap-4 p-4 text-start">
      <h1 className="text-2xl font-bold">{title}</h1>
      <div data-testid={testId} className="flex flex-col gap-4">
        {children}
      </div>
    </section>
  );
}
