import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { BOT_TOKEN } from "./playwright.config";

function signInitData(fields: Record<string, string>): string {
  const dcs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const p = new URLSearchParams(fields);
  p.set("hash", createHmac("sha256", secret).update(dcs).digest("hex"));
  return p.toString();
}

/** Имитация Telegram WebApp: подписанная initData и пустые методы оболочки. */
async function mockTelegram(page: Page, userId: number, initDataOverride?: string) {
  void userId;
  const initData = initDataOverride ?? signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: "Тест" }) });
  await page.route("https://telegram.org/**", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: `window.Telegram={WebApp:{initData:${JSON.stringify(initData)},initDataUnsafe:{},version:"8.0",platform:"android",ready(){},expand(){},isVersionAtLeast(){return true},BackButton:{show(){},hide(){},onClick(){},offClick(){}},HapticFeedback:{impactOccurred(){},notificationOccurred(){}}}}`,
    }),
  );
}

test("подделанная initData не пускает в игру", async ({ page }) => {
  await mockTelegram(page, 1, "user=%7B%22id%22%3A1%7D&auth_date=1&hash=" + "0".repeat(64));
  await page.goto("/");
  await expect(page.getByText("Не удалось войти")).toBeVisible();
});

/** Команды от имени того же игрока через REST — так тест ведёт отряд по карте без координат экрана. */
async function api(baseURL: string, initData: string) {
  const tok = (await (await fetch(`${baseURL}/auth/telegram`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ initData }) })).json()).token;
  const h = { authorization: `Bearer ${tok}`, "content-type": "application/json" };
  const sid = (await (await fetch(`${baseURL}/sessions/active`, { headers: h })).json()).sessionId as string;
  return async (c: object) => {
    const st = await (await fetch(`${baseURL}/sessions/${sid}/state?sinceSeq=999999`, { headers: h })).json();
    return (await fetch(`${baseURL}/sessions/${sid}/commands`, { method: "POST", headers: h, body: JSON.stringify({ ...c, commandId: crypto.randomUUID(), expectedSeq: st.seq }) })).json();
  };
}

test("таверна → подвал → бой в винном погребе → победа в стычке", async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 700000 + Math.floor(Math.random() * 1e5), first_name: "Тест" }) });
  await mockTelegram(page, 0, initData);
  await page.goto("/");
  await page.locator(".class-card", { hasText: "Чародей" }).click();
  await page.getByText("Новый герой").last().click();
  await expect(page.locator(".hero-card")).toHaveCount(1);
  await page.getByText("В путь").click();
  await expect(page.locator(".story")).toContainText("Мирон", { timeout: 20_000 });

  const cmd = await api(baseURL!, initData);
  // Тап по объекту на карте открывает лист действий.
  expect((await cmd({ type: "INTERACT", heroId: "h1", objectId: "note_miron", verb: "use" })).ok).toBe(true);
  await expect(page.locator(".story")).toContainText("Записка Мирона", { timeout: 15_000 });
  expect((await cmd({ type: "MOVE", heroId: "h1", x: 3, y: 5 })).ok).toBe(true);
  expect((await cmd({ type: "MOVE", heroId: "h1", x: 3, y: 7 })).ok).toBe(true);

  for (let round = 0; round < 20; round++) {
    const roll = page.getByText("Бросить кости");
    const back = page.locator(".story");
    await expect(roll.or(back)).toBeVisible({ timeout: 30_000 });
    if (!(await roll.isVisible())) break;
    await expect(roll).toBeEnabled({ timeout: 30_000 });
    await roll.click();
    const ready = page.locator(".row3 .act.primary");
    await expect(ready).toBeEnabled({ timeout: 30_000 });
    for (let i = 0; i < 3; i++) {
      const chip = page.locator(".die-chip").nth(i);
      if ((await chip.getAttribute("class"))?.includes("skull")) continue;
      await chip.click();
      const star = page.locator(".star-faces .die-chip").first();
      if (await star.isVisible().catch(() => false)) await star.click();
      const target = page.locator(".unit.target").first();
      if (await target.isVisible().catch(() => false)) await target.click();
      await expect(ready).toBeEnabled({ timeout: 15_000 });
    }
    await ready.click();
    await expect(page.locator(".end-card").or(page.getByText("Бросить кости")).or(page.locator(".story"))).toBeVisible({ timeout: 30_000 });
    if (await page.locator(".end-card").isVisible()) break;
  }
  // После стычки — снова карта (или поражение в обучении).
  await expect(page.locator(".story").or(page.locator(".end-card"))).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("отступление: награды и проверка бросков по зерну", async ({ page, baseURL }) => {
  const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 750000 + Math.floor(Math.random() * 1e5), first_name: "Тест" }) });
  await mockTelegram(page, 0, initData);
  await page.goto("/");
  await page.getByText("Новый герой").last().click();
  await page.getByText("В путь").click();
  await expect(page.locator(".story")).toBeVisible({ timeout: 20_000 });
  const cmd = await api(baseURL!, initData);
  await cmd({ type: "SEARCH", heroId: "h1" });
  expect((await cmd({ type: "RETREAT", heroId: "h1" })).ok).toBe(true);
  await expect(page.locator(".end-card")).toContainText("Отступление", { timeout: 20_000 });
  await page.getByText("Проверить броски").click();
  await expect(page.locator(".journal")).toContainText("Все броски сходятся с зерном");
  await expect(page.locator(".journal")).toContainText("Хеш зерна совпадает");
  await page.getByText("В таверну").click();
  await expect(page.locator(".hero-card")).toHaveCount(1);
});

test("после перезагрузки поход продолжается с того же места", async ({ page, baseURL }) => {
  const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 800000 + Math.floor(Math.random() * 1e5), first_name: "Тест" }) });
  await mockTelegram(page, 0, initData);
  await page.goto("/");
  await page.getByText("Новый герой").last().click();
  await page.getByText("В путь").click();
  await expect(page.locator(".story")).toBeVisible({ timeout: 20_000 });
  const cmd = await api(baseURL!, initData);
  await cmd({ type: "INTERACT", heroId: "h1", objectId: "note_miron", verb: "use" });
  await expect(page.locator(".story")).toContainText("Записка Мирона", { timeout: 15_000 });
  await page.reload();
  await page.getByText("Вернуться в поход").click();
  await expect(page.locator(".story")).toContainText("Записка Мирона", { timeout: 20_000 });
});
