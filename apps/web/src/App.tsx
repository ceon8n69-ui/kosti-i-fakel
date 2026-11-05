import { parseStartParam, type UserProfile } from "@kf/schema";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { unlockAudio } from "./audio/sound";
import { setLocale, t, tk } from "./i18n";
import { get, login, post } from "./lib/api";
import { haptic, setBack, tg } from "./lib/telegram";

// Three.js и сцена грузятся только при входе в бой — первая загрузка остаётся лёгкой.
const CombatScreen = lazy(() => import("./combat/CombatScreen"));

type State =
  | { s: "loading" }
  | { s: "outside" }
  | { s: "error" }
  | { s: "ready"; user: UserProfile; startParam: string | null };

const CLASSES = ["guardian", "rogue", "sorcerer", "healer"] as const;

export function App() {
  const [state, setState] = useState<State>({ s: "loading" });
  const [session, setSession] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);

  const run = useCallback(async () => {
    const w = tg();
    if (!w) return setState({ s: "outside" });
    setState({ s: "loading" });
    try {
      const r = await login(w.initData);
      setLocale(r.user.language);
      setState({ s: "ready", user: r.user, startParam: r.startParam });
      const a = await get<{ sessionId: string | null }>("/sessions/active");
      setActive(a.sessionId);
      haptic("success");
    } catch {
      setState({ s: "error" });
      haptic("error");
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  const start = async (classId: string) => {
    unlockAudio();
    const r = await post<{ sessionId: string }>("/sessions", { classId });
    setSession(r.sessionId);
  };

  if (state.s === "ready" && session)
    return (
      <Suspense fallback={<main className="screen"><p className="muted">{t("app.loading")}</p></main>}>
        <CombatScreen
          key={session}
          sessionId={session}
          userId={state.user.id}
          onExit={() => {
            setSession(null);
            void get<{ sessionId: string | null }>("/sessions/active").then((a) => setActive(a.sessionId));
          }}
          onAgain={() => setSession(null)}
        />
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
      {state.s === "ready" && <Tavern user={state.user} startParam={state.startParam} active={active} onStart={start} onContinue={setSession} />}
    </main>
  );
}

function Tavern({
  user,
  startParam,
  active,
  onStart,
  onContinue,
}: {
  user: UserProfile;
  startParam: string | null;
  active: string | null;
  onStart: (c: string) => Promise<void>;
  onContinue: (id: string) => void;
}) {
  const [pick, setPick] = useState<string>("guardian");
  const [busy, setBusy] = useState(false);
  const sp = parseStartParam(startParam);
  useEffect(() => setBack(null), []);
  return (
    <>
      <section className="card">
        <div className="who">
          <div className="portrait sm" aria-hidden>
            {(user.firstName[0] ?? "?").toUpperCase()}
          </div>
          <div>
            <div className="label">{t("profile.heading")}</div>
            <div className="name">{user.firstName}</div>
          </div>
        </div>
        {sp && (
          <div className="muted small">
            {t("invite.opened")}: {sp.kind} {sp.id}
          </div>
        )}
      </section>

      {active && (
        <button className="btn wide" onClick={() => onContinue(active)}>
          ⚔ {t("tavern.continue")}
        </button>
      )}

      <section className="card">
        <div className="label">{t("tavern.slice")}</div>
        <div className="name small-h">{t("tavern.pick")}</div>
        <div className="classes">
          {CLASSES.map((c) => (
            <button key={c} className={`class-card ${pick === c ? "sel" : ""}`} onClick={() => setPick(c)}>
              <b>{tk(`class.${c}`)}</b>
              <span>{tk(`class.${c}.d`)}</span>
            </button>
          ))}
        </div>
        <button
          className="btn wide"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onStart(pick);
            } finally {
              setBusy(false);
            }
          }}
        >
          🔥 {t("tavern.start")}
        </button>
      </section>
    </>
  );
}
