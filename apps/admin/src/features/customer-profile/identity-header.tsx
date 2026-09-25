// WBS 1.9 — identity header strip (Master decision 8): name, code, segment, no edit affordance
// (read-only screen).
import type { Locale } from '../../i18n/t';
import { t } from '../../i18n/t';
import type { CustomerProfileIdentity } from './contract';

export interface IdentityHeaderProps {
  identity: CustomerProfileIdentity;
  locale: Locale;
}

function nameFor(identity: CustomerProfileIdentity, locale: Locale): string {
  if (locale === 'ar') {
    return identity.nameAr;
  }
  return identity.nameEn ?? identity.nameAr;
}

// Fix round 1, finding 8: `segmentNameAr` is Arabic-only text — showing it on every locale left
// non-Arabic screens displaying an Arabic segment name. Arabic locale still shows the Arabic name;
// every other locale falls back to the locale-neutral `segmentCode`.
function segmentFor(identity: CustomerProfileIdentity, locale: Locale): string | null {
  if (locale === 'ar') {
    return identity.segmentNameAr;
  }
  return identity.segmentCode ?? identity.segmentNameAr;
}

export function IdentityHeader({ identity, locale }: IdentityHeaderProps) {
  return (
    <div className="flex items-center gap-6 border-b border-border p-4">
      <h1 data-testid="identity-name" className="text-lg font-bold">
        {nameFor(identity, locale)}
      </h1>
      <span data-testid="identity-code" className="text-sm text-muted-foreground">
        {identity.code}
      </span>
      <span data-testid="identity-segment" className="text-sm text-muted-foreground">
        {segmentFor(identity, locale) ?? t(locale, 'customer360.identity.segment.none')}
      </span>
    </div>
  );
}
