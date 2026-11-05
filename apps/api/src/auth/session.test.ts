import { describe, expect, it } from "vitest";
import { issueSession, readSession } from "./session.js";

const S = "s".repeat(32);

describe("session token", () => {
  it("читается до истечения и не читается после", () => {
    const tok = issueSession({ uid: "u", tg: "1", exp: 100 }, S);
    expect(readSession(tok, S, 99)?.uid).toBe("u");
    expect(readSession(tok, S, 100)).toBeNull();
  });
  it("подмена payload ломает подпись", () => {
    const tok = issueSession({ uid: "u", tg: "1", exp: 100 }, S);
    const [, sig] = tok.split(".");
    const body = Buffer.from(JSON.stringify({ uid: "admin", tg: "1", exp: 100 })).toString("base64url");
    expect(readSession(`${body}.${sig}`, S, 1)).toBeNull();
  });
  it("чужой секрет не подходит", () => {
    const tok = issueSession({ uid: "u", tg: "1", exp: 100 }, S);
    expect(readSession(tok, "x".repeat(32), 1)).toBeNull();
  });
});
