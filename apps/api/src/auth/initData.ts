import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const TelegramUserSchema = z.object({
  id: z.number().int().positive(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
  is_premium: z.boolean().optional(),
  photo_url: z.string().optional(),
});
export type TelegramUser = z.infer<typeof TelegramUserSchema>;

export interface VerifiedInitData {
  user: TelegramUser;
  authDate: number;
  startParam: string | null;
  chatType: string | null;
  queryId: string | null;
}

export type InitDataError =
  | "malformed"
  | "missing_hash"
  | "bad_signature"
  | "expired"
  | "from_future"
  | "missing_user";

export class InitDataValidationError extends Error {
  constructor(public readonly code: InitDataError) {
    super(code);
  }
}

/**
 * Проверка initData по документации Mini Apps:
 * secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token),
 * hash = hex(HMAC_SHA256(key=secret_key, msg=data_check_string)),
 * где data_check_string — все поля, кроме hash, отсортированные по ключу, "key=value" через \n.
 */
export function verifyInitData(
  initData: string,
  botToken: string,
  opts: { maxAgeSec: number; nowSec: number; clockSkewSec?: number },
): VerifiedInitData {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    throw new InitDataValidationError("malformed");
  }
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw new InitDataValidationError("missing_hash");

  const pairs: string[] = [];
  const seen = new Set<string>();
  for (const [k, v] of params) {
    if (k === "hash") continue;
    if (seen.has(k)) throw new InitDataValidationError("malformed");
    seen.add(k);
    pairs.push(`${k}=${v}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(dataCheckString).digest();
  const given = Buffer.from(hash, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    throw new InitDataValidationError("bad_signature");

  const authDate = Number(params.get("auth_date"));
  if (!Number.isInteger(authDate) || authDate <= 0) throw new InitDataValidationError("malformed");
  if (authDate > opts.nowSec + (opts.clockSkewSec ?? 60)) throw new InitDataValidationError("from_future");
  if (opts.nowSec - authDate > opts.maxAgeSec) throw new InitDataValidationError("expired");

  const userRaw = params.get("user");
  if (!userRaw) throw new InitDataValidationError("missing_user");
  let user: TelegramUser;
  try {
    user = TelegramUserSchema.parse(JSON.parse(userRaw));
  } catch {
    throw new InitDataValidationError("malformed");
  }

  return {
    user,
    authDate,
    startParam: params.get("start_param"),
    chatType: params.get("chat_type"),
    queryId: params.get("query_id"),
  };
}

/** Только для тестов и локальной разработки: подписывает initData так же, как Telegram. */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const pairs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(pairs).digest("hex");
  const p = new URLSearchParams(fields);
  p.set("hash", hash);
  return p.toString();
}
