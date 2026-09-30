// WBS 2.16 part 2e — PDA home: one link per D4 screen, each labelled with its screen key.
import { Link } from '@tanstack/react-router';

import { t, type Locale, type TranslationKey } from '../../i18n/t';
import { Screen } from '../../ui/Screen';
import { TOUCH_TARGET_CLASS } from '../../ui/tokens';

interface HomeProps {
  locale: Locale;
}

const HOME_LINKS = [
  { to: '/receive', key: 'screen.receive' },
  { to: '/put-away', key: 'screen.putAway' },
  { to: '/pick', key: 'screen.pick' },
  { to: '/check', key: 'screen.check' },
  { to: '/load', key: 'screen.load' },
  { to: '/count', key: 'screen.count' },
  { to: '/transfer-return', key: 'screen.transferReturn' },
  { to: '/lookup', key: 'screen.lookup' },
] as const satisfies ReadonlyArray<{ to: string; key: TranslationKey }>;

export function HomeScreen({ locale }: HomeProps) {
  return (
    <Screen title={t(locale, 'screen.home')}>
      <nav className="flex flex-col gap-2">
        {HOME_LINKS.map((link) => (
          <Link
            key={link.to}
            to={link.to}
            className={`${TOUCH_TARGET_CLASS} flex items-center rounded-md bg-primary px-4 text-primary-foreground`}
          >
            {t(locale, link.key)}
          </Link>
        ))}
      </nav>
    </Screen>
  );
}
