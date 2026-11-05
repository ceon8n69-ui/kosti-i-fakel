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

test("обучающий бой проходится до конца, броски проверяются по зерну", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await mockTelegram(page, 700000 + Math.floor(Math.random() * 1e5));
  await page.goto("/");
  await page.getByText("Чародей").click();
  await page.getByText("Спуститься").click();

  await page.getByText("Осмотреть проход").click();
  // Проверка стоит 1 свет: шкала Факела показывает 39.
  await expect(page.locator(".hud-light b")).toHaveText("39", { timeout: 15_000 });
  await page.getByText("Войти в погреб").click();

  for (let round = 0; round < 15; round++) {
    const roll = page.getByText("Бросить кости");
    await expect(roll.or(page.locator(".end-card"))).toBeVisible({ timeout: 30_000 });
    if (await page.locator(".end-card").isVisible()) break;
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
  }
  await expect(page.locator(".end-card")).toBeVisible({ timeout: 30_000 });
  await page.getByText("Проверить броски").click();
  await expect(page.locator(".journal")).toContainText("Все броски сходятся с зерном");
  await expect(page.locator(".journal")).toContainText("Хеш зерна совпадает");
  expect(errors).toEqual([]);
});

test("после перезагрузки бой продолжается с того же места", async ({ page }) => {
  await mockTelegram(page, 800000 + Math.floor(Math.random() * 1e5));
  await page.goto("/");
  await page.getByText("Спуститься").click();
  await page.getByText("Войти в погреб").click();
  await expect(page.getByText("Бросить кости")).toBeEnabled({ timeout: 30_000 });
  const hp = await page.locator(".unit.mon .u-hp span").first().textContent();
  await page.reload();
  await page.getByText("Вернуться к бою").click();
  await expect(page.getByText("Бросить кости")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".unit.mon .u-hp span").first()).toHaveText(hp!);
});
