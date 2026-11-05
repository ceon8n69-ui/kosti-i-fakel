import { z } from "zod";

/** Языки интерфейса. Запуск на русском, ключи i18n с первого дня. */
export const LocaleSchema = z.enum(["ru", "uk", "en"]);
export type Locale = z.infer<typeof LocaleSchema>;

export const AuthTelegramRequestSchema = z.object({
  initData: z.string().min(1).max(4096),
});
export type AuthTelegramRequest = z.infer<typeof AuthTelegramRequestSchema>;

export const UserProfileSchema = z.object({
  id: z.string().uuid(),
  telegramId: z.string(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  username: z.string().nullable(),
  language: LocaleSchema,
  timezone: z.string(),
  authorLevel: z.number().int(),
  fame: z.number().int(),
  settings: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

export const AuthTelegramResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
  user: UserProfileSchema,
  startParam: z.string().nullable(),
});
export type AuthTelegramResponse = z.infer<typeof AuthTelegramResponseSchema>;

/** Параметры startapp: t_ стол, d_ подземелье, f_ Павший, r_ приглашение. */
export const StartParamSchema = z
  .string()
  .regex(/^(t|d|f|r)_[A-Za-z0-9_-]{1,60}$/);
export type StartParamKind = "table" | "dungeon" | "fallen" | "invite";

export function parseStartParam(
  raw: string | null | undefined,
): { kind: StartParamKind; id: string } | null {
  if (!raw || !StartParamSchema.safeParse(raw).success) return null;
  const map = { t: "table", d: "dungeon", f: "fallen", r: "invite" } as const;
  const prefix = raw[0] as keyof typeof map;
  return { kind: map[prefix], id: raw.slice(2) };
}

export const ApiErrorSchema = z.object({ error: z.string(), message: z.string().optional() });
export type ApiError = z.infer<typeof ApiErrorSchema>;

export { BalanceSchema, type Balance } from "./balance.js";
