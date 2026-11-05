import type { Locale } from "@kf/schema";
import { ru, type I18nKey } from "./ru";

/** uk и en подключаются как Partial<typeof ru>: недостающие ключи падают на русский. */
const dicts: Record<Locale, Partial<Record<string, string>>> = { ru, uk: {}, en: {} };
let current: Locale = "ru";

export const setLocale = (l: Locale) => {
  current = l;
};
export const t = (k: I18nKey): string => dicts[current][k] ?? ru[k];
/** Ключ, собранный из данных (класс, монстр, характеристика). */
export const tk = (k: string): string => dicts[current][k] ?? (ru as Record<string, string>)[k] ?? k;
