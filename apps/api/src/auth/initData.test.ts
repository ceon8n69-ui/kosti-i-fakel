import { describe, expect, it } from "vitest";
import { InitDataValidationError, signInitData, verifyInitData } from "./initData.js";

const TOKEN = "123456:TEST-token-abcdefghijklmnopqrstuvwxyz";
const NOW = 1_800_000_000;
const user = JSON.stringify({ id: 42, first_name: "Ада", language_code: "ru" });
const opts = { maxAgeSec: 86400, nowSec: NOW };

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof InitDataValidationError) return e.code;
    throw e;
  }
  return undefined;
}

describe("verifyInitData", () => {
  it("принимает корректную подпись", () => {
    const data = signInitData({ auth_date: String(NOW - 10), user, query_id: "q1", start_param: "d_x1" }, TOKEN);
    const v = verifyInitData(data, TOKEN, opts);
    expect(v.user.id).toBe(42);
    expect(v.startParam).toBe("d_x1");
  });

  it("учитывает поле signature в проверке hash", () => {
    const data = signInitData({ auth_date: String(NOW), user, signature: "abc" }, TOKEN);
    expect(verifyInitData(data, TOKEN, opts).user.first_name).toBe("Ада");
  });

  it("отклоняет подменённого пользователя", () => {
    const data = signInitData({ auth_date: String(NOW), user }, TOKEN);
    const forged = data.replace("%22id%22%3A42", "%22id%22%3A43");
    expect(forged).not.toBe(data);
    expect(code(() => verifyInitData(forged, TOKEN, opts))).toBe("bad_signature");
  });

  it("отклоняет подпись чужим токеном", () => {
    const data = signInitData({ auth_date: String(NOW), user }, "999:OTHER-token-abcdefghijklmnopqrstuvw");
    expect(code(() => verifyInitData(data, TOKEN, opts))).toBe("bad_signature");
  });

  it("отклоняет без hash", () => {
    expect(code(() => verifyInitData(`auth_date=${NOW}&user=${encodeURIComponent(user)}`, TOKEN, opts))).toBe(
      "missing_hash",
    );
  });

  it("отклоняет просроченный auth_date", () => {
    const data = signInitData({ auth_date: String(NOW - 86401), user }, TOKEN);
    expect(code(() => verifyInitData(data, TOKEN, opts))).toBe("expired");
  });

  it("отклоняет auth_date из будущего", () => {
    const data = signInitData({ auth_date: String(NOW + 3600), user }, TOKEN);
    expect(code(() => verifyInitData(data, TOKEN, opts))).toBe("from_future");
  });

  it("отклоняет дубли ключей", () => {
    const data = signInitData({ auth_date: String(NOW), user }, TOKEN);
    expect(code(() => verifyInitData(`${data}&auth_date=${NOW}`, TOKEN, opts))).toBe("malformed");
  });
});
