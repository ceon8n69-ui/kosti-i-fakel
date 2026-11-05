import type { UserProfile } from "@kf/schema";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { setLocale, t } from "./i18n";
import { login } from "./lib/api";
import { haptic, tg } from "./lib/telegram";
import { Tavern } from "./tavern/Tavern";

// Three.js и сцена грузятся только при входе в подземелье — первая загрузка остаётся лёгкой.
const GameScreen = lazy(() => import("./combat/GameScreen"));

type State = { s: "loading" } | { s: "outside" } | { s: "error" } | { s: "ready"; user: UserProfile; startParam: string | null };


export function App() {
  const [state, setState] = useState<State>({ s: "loading" });
  const [session, setSession] = useState<string | null>(null);

  const run = useCallback(async () => {
    const w = tg();
    if (!w) return setState({ s: "outside" });
    setState({ s: "loading" });
    try {
      const r = await login(w.initData);
      setLocale(r.user.language);
      setState({ s: "ready", user: r.user, startParam: r.startParam });
      haptic("success");
    } catch {
      setState({ s: "error" });
      haptic("error");
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  if (state.s === "ready" && session)
    return (
      <Suspense fallback={<main className="screen"><p className="muted">{t("app.loading")}</p></main>}>
        <GameScreen key={session} sessionId={session} userId={state.user.id} onExit={() => setSession(null)} />
      </Suspense>
    );

  return (
    <main className="screen">
      <div className="torch" aria-hidden />
      <h1 className="title">{t("app.title")}</h1>
      {state.s === "loading" && <p className="muted">{t("app.loading")}</p>}
      {state.s === "outside" && <p className="muted">{t("app.outsideTelegram")}</p>}
      {state.s === "error" && (
        <>
          <p className="muted">{t("app.authFailed")}</p>
          <button className="btn" onClick={() => void run()}>
            {t("app.retry")}
          </button>
        </>
      )}
      {state.s === "ready" && <Tavern user={state.user} startParam={state.startParam} onPlay={setSession} />}
    </main>
  );
}

