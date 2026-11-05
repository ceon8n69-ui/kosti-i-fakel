import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Короткоживущий токен сессии: base64url(payload).base64url(hmac).
 * Свой формат вместо JWT: одна схема подписи, нет выбора алгоритма в заголовке.
 */
export interface SessionPayload {
  uid: string;
  tg: string;
  exp: number;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function issueSession(p: SessionPayload, secret: string): string {
  const body = b64(JSON.stringify(p));
  const sig = b64(createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

export function readSession(token: string, secret: string, nowSec: number): SessionPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (typeof p.uid !== "string" || typeof p.exp !== "number" || p.exp <= nowSec) return null;
    return p;
  } catch {
    return null;
  }
}
