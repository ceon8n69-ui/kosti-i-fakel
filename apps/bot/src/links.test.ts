import { describe, expect, it } from "vitest";
import { directLink, openButton } from "./index.js";

const cfg = { token: "x", username: "kostifakel_bot", appShortName: "play", webAppUrl: "https://kf.example.com" };

describe("ссылки на Mini App", () => {
  it("прямая ссылка с допустимым startapp", () => {
    expect(directLink(cfg, "d_abc123")).toBe("https://t.me/kostifakel_bot/play?startapp=d_abc123");
  });
  it("мусорный параметр отбрасывается", () => {
    expect(directLink(cfg, "x_<script>")).toBe("https://t.me/kostifakel_bot/play");
  });
  it("в группе кнопка url, а не web_app", () => {
    const kb = openButton(cfg, "group");
    const btn = kb.inline_keyboard[0]![0]!;
    expect("url" in btn).toBe(true);
    expect("web_app" in btn).toBe(false);
  });
  it("в личке кнопка web_app", () => {
    const btn = openButton(cfg, "private").inline_keyboard[0]![0]!;
    expect("web_app" in btn).toBe(true);
  });
});
