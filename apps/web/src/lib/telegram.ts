/** Минимальная типизация window.Telegram.WebApp — только то, что используем. */
interface TgWebApp {
  initData: string;
  initDataUnsafe: { start_param?: string };
  version: string;
  platform: string;
  ready(): void;
  expand(): void;
  isVersionAtLeast(v: string): boolean;
  disableVerticalSwipes?(): void;
  lockOrientation?(): void;
  requestFullscreen?(): void;
  setHeaderColor?(c: string): void;
  setBackgroundColor?(c: string): void;
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  HapticFeedback?: {
    impactOccurred(style: "light" | "medium" | "heavy" | "rigid" | "soft"): void;
    notificationOccurred(t: "error" | "success" | "warning"): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
  }
}

export function tg(): TgWebApp | null {
  const w = window.Telegram?.WebApp;
  return w && w.initData ? w : null;
}

/** Подготовка оболочки: расширенный экран, портрет, без закрытия свайпом. */
let currentBack: (() => void) | null = null;
/** Системная кнопка «Назад»: один обработчик за раз. */
export function setBack(cb: (() => void) | null): void {
  const w = tg();
  if (!w) return;
  if (currentBack) w.BackButton.offClick(currentBack);
  currentBack = cb;
  if (cb) {
    w.BackButton.onClick(cb);
    w.BackButton.show();
  } else w.BackButton.hide();
}

export function setupShell(): void {
  const w = tg();
  if (!w) return;
  w.ready();
  w.expand();
  const at = (v: string) => w.isVersionAtLeast(v);
  if (at("7.7")) w.disableVerticalSwipes?.();
  if (at("8.0")) w.lockOrientation?.();
  if (at("6.1")) {
    w.setHeaderColor?.("#15100c");
    w.setBackgroundColor?.("#15100c");
  }
  w.BackButton.hide();
}

export function haptic(kind: "tap" | "success" | "error"): void {
  const h = tg()?.HapticFeedback;
  if (!h) return;
  if (kind === "tap") h.impactOccurred("light");
  else h.notificationOccurred(kind);
}

let lastImpact = 0;
/** Вибрация удара; не чаще раза в 40 мс, чтобы серия ударов кубиков не сливалась в гул. */
export function hapticImpact(style: "light" | "medium" | "heavy" | "soft" = "light"): void {
  const now = performance.now();
  if (now - lastImpact < 40) return;
  lastImpact = now;
  tg()?.HapticFeedback?.impactOccurred(style);
}
