// WBS 2.16 part 1a — shared placeholder component for all nine D4 screens (brief Master decision
// 1). Renders only the screen's own translated title — no data, no scan input, no API call this
// part; a later slice replaces one route's own component at a time with the real feature.
import type { Locale, TranslationKey } from '../../i18n/t';
import { t } from '../../i18n/t';
import { Screen } from '../../ui/Screen';

interface PlaceholderScreenProps {
  titleKey: TranslationKey;
  locale: Locale;
}

export function PlaceholderScreen({ titleKey, locale }: PlaceholderScreenProps) {
  return <Screen title={t(locale, titleKey)} />;
}
