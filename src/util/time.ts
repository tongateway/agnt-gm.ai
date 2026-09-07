// relTime — relative "2m / 11m / 1h / 21d" (RU: «сейчас / 2м / 1ч / 21д»).
import { Lang, tr } from '../i18n';

export function relTime(iso?: string, lang: Lang = 'en'): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return tr(lang, 'now', 'сейчас');
  if (s < 3600) return `${Math.floor(s / 60)}${tr(lang, 'm', 'м')}`;
  if (s < 86400) return `${Math.floor(s / 3600)}${tr(lang, 'h', 'ч')}`;
  return `${Math.floor(s / 86400)}${tr(lang, 'd', 'д')}`;
}
