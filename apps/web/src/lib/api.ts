import type { AuthTelegramResponse, UserProfile } from "@kf/schema";

let token: string | null = null;
export const authToken = (): string => token ?? "";

export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

let lastInitData: string | null = null;

async function call<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  // Сессия короткая: при истечении перевходим по свежей initData.
  if (res.status === 401 && !retried && lastInitData && path !== "/auth/telegram") {
    await login(lastInitData);
    return call<T>(path, init, true);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? "network");
  return body as T;
}

export async function login(initData: string): Promise<AuthTelegramResponse> {
  lastInitData = initData;
  const r = await call<AuthTelegramResponse>("/auth/telegram", {
    method: "POST",
    body: JSON.stringify({ initData }),
  });
  token = r.token;
  return r;
}

export const getMe = () => call<UserProfile>("/me");

export async function post<T>(path: string, body: unknown): Promise<T> {
  return call<T>(path, { method: "POST", body: JSON.stringify(body) });
}
export const get = <T,>(path: string) => call<T>(path);
