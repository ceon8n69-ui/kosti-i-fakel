import { createHmac } from "node:crypto";
import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { BOT_TOKEN } from "./playwright.config";
const sign = (id: number, name: string, sp?: string) => {
  const f = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: name }), ...(sp ? { start_param: sp } : {}) } as Record<string, string>;
  const dcs = Object.entries(f).map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const p = new URLSearchParams(f); p.set("hash", createHmac("sha256", secret).update(dcs).digest("hex")); return p.toString();
};
/** Партия: два игрока за одним столом (обучение «закрыто» прямо в БД), хозяин стартует общий поход. */
test("партия: приглашение по ссылке, готовность, общий поход", async ({ page, baseURL }) => {
  const mk = async (id: number, name: string, cls: string) => {
    const initData = sign(id, name);
    const tok = (await (await fetch(`${baseURL}/auth/telegram`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ initData }) })).json()).token;
    const h = { authorization: `Bearer ${tok}`, "content-type": "application/json" };
    const hero = await (await fetch(`${baseURL}/heroes`, { method: "POST", headers: h, body: JSON.stringify({ classId: cls }) })).json();
    const s = await (await fetch(`${baseURL}/sessions`, { method: "POST", headers: h, body: JSON.stringify({ heroId: hero.id, dungeonId: "tavern_cellar" }) })).json();
    execSync(`psql ${process.env.TEST_DATABASE_URL ?? "postgres://kf:kf@localhost:5432/kf_test"} -c "update sessions set state='ended', ended_reason='victory' where id='${s.sessionId}'; update heroes set status='alive' where id='${hero.id}'"`);
    return { initData, h, hero };
  };
  const base = 900000 + Math.floor(Math.random() * 1e5);
  const a = await mk(base, "Агата", "guardian");
  const b = await mk(base + 1, "Борис", "sorcerer");
  const t = await (await fetch(`${baseURL}/tables`, { method: "POST", headers: a.h, body: JSON.stringify({ biome: "forest", heroId: a.hero.id }) })).json();
  await fetch(`${baseURL}/tables/${t.tableId}/join`, { method: "POST", headers: b.h, body: JSON.stringify({ heroId: b.hero.id }) });
  await fetch(`${baseURL}/tables/${t.tableId}/ready`, { method: "POST", headers: b.h, body: JSON.stringify({ ready: true }) });
  await page.route("https://telegram.org/**", (r) => r.fulfill({ contentType: "text/javascript", body: `window.Telegram={WebApp:{initData:${JSON.stringify(sign(base, "Агата", "t_" + t.tableId))},initDataUnsafe:{start_param:"t_${t.tableId}"},version:"8.0",platform:"android",ready(){},expand(){},isVersionAtLeast(){return true},BackButton:{show(){},hide(){},onClick(){},offClick(){}}}}` }));
  await page.goto("/");
  await page.locator(".lobby .seat").first().waitFor();
  await page.waitForTimeout(800);
  await expect(page.locator(".seat.ready")).toContainText("Борис");
  await page.getByText("Начать поход").click();
  await expect(page.locator(".story")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Борис").first()).toBeVisible();
});
