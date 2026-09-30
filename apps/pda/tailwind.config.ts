// WBS 2.16 part 2e — Tailwind config for @pg-eos/pda. Colours are CSS variables
// (src/styles/tokens.css) mirroring apps/admin; touch/scan sizes come from src/ui/tokens.ts.
import type { Config } from 'tailwindcss';

import { SCAN_FIELD_MIN_HEIGHT_PX, TOUCH_TARGET_MIN_PX } from './src/ui/tokens';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: 'hsl(var(--card))',
        'card-foreground': 'hsl(var(--card-foreground))',
        border: 'hsl(var(--border))',
        primary: 'hsl(var(--primary))',
        'primary-foreground': 'hsl(var(--primary-foreground))',
        muted: 'hsl(var(--muted))',
        'muted-foreground': 'hsl(var(--muted-foreground))',
        destructive: 'hsl(var(--destructive))',
        'destructive-foreground': 'hsl(var(--destructive-foreground))',
      },
      minHeight: {
        touch: `${TOUCH_TARGET_MIN_PX}px`,
        scan: `${SCAN_FIELD_MIN_HEIGHT_PX}px`,
      },
      minWidth: {
        touch: `${TOUCH_TARGET_MIN_PX}px`,
      },
    },
  },
  plugins: [],
};

export default config;
