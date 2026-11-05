import type { AuthTelegramResponse, UserProfile } from "@kf/schema";

let token: string | null = null;

export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? "network");
  return body as T;
}

export async function login(initData: string): Promise<AuthTelegramResponse> {
  const r = await call<AuthTelegramResponse>("/auth/telegram", {
    method: "POST",
    body: JSON.stringify({ initData }),
  });
  token = r.token;
  return r;
}

export const getMe = () => call<UserProfile>("/me");
