import type { Locale } from "@kf/schema";

/** Язык из Telegram → язык игры. На старте всё русское; uk/en включаются, когда появятся переводы. */
export function pickLocale(code: string | undefined): Locale {
  if (code?.startsWith("uk")) return "uk";
  if (code?.startsWith("en")) return "en";
  return "ru";
}
