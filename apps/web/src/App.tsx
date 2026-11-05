import { parseStartParam, type UserProfile } from "@kf/schema";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { unlockAudio } from "./audio/sound";
import { setLocale, t, tk } from "./i18n";
import { ApiError, get, login, post } from "./lib/api";
import { haptic, setBack, tg } from "./lib/telegram";

// Three.js и сцена грузятся только при входе в подземелье — первая загрузка остаётся лёгкой.
const GameScreen = lazy(() => import("./combat/GameScreen"));

type State = { s: "loading" } | { s: "outside" } | { s: "error" } | { s: "ready"; user: UserProfile; startParam: string | null };

interface HeroCard {
  id: string;
  classId: string;
  name: string;
  level: number;
  xp: number;
  xpToNext: number;
  maxHp: number;
  status: string;
  consumables: string[];
}
interface DungeonCard {
  id: string;
  title: string;
  tier: number;
  tutorial: boolean;
  unlocked: boolean;
  cleared: boolean;
  intro: string;
}

const CLASSES = ["guardian", "rogue", "sorcerer", "healer"] as const;

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

function Tavern({ user, startParam, onPlay }: { user: UserProfile; startParam: string | null; onPlay: (id: string) => void }) {
  const [heroes, setHeroes] = useState<HeroCard[] | null>(null);
  const [gold, setGold] = useState(0);
  const [dungeons, setDungeons] = useState<DungeonCard[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [heroId, setHeroId] = useState<string | null>(null);
  const [dungeonId, setDungeonId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pick, setPick] = useState<string>("guardian");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const sp = parseStartParam(startParam);

  const load = useCallback(async () => {
    const [h, dd, a] = await Promise.all([
      get<{ heroes: HeroCard[]; gold: number }>("/heroes"),
      get<{ official: DungeonCard[] }>("/dungeons"),
      get<{ sessionId: string | null }>("/sessions/active"),
    ]);
    setHeroes(h.heroes);
    setGold(h.gold);
    setDungeons(dd.official);
    setActive(a.sessionId);
    setHeroId((cur) => cur ?? h.heroes.find((x) => x.status === "alive")?.id ?? null);
    setDungeonId((cur) => cur ?? dd.official.find((x) => x.unlocked && !x.cleared)?.id ?? dd.official.find((x) => x.unlocked)?.id ?? null);
    if (!h.heroes.length) setCreating(true);
  }, []);

  useEffect(() => {
    setBack(null);
    void load();
  }, [load]);

  const createHero = async () => {
    setBusy(true);
    try {
      const h = await post<HeroCard>("/heroes", { classId: pick });
      setHeroId(h.id);
      setCreating(false);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError && e.code === "slots_full" ? t("tavern.slotsFull") : t("app.authFailed"));
    } finally {
      setBusy(false);
    }
  };

  const go = async () => {
    if (!heroId || !dungeonId) return;
    unlockAudio();
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ sessionId: string }>("/sessions", { heroId, dungeonId });
      onPlay(r.sessionId);
    } catch (e) {
      setErr(e instanceof ApiError ? tk(`err.${e.code}`) : t("app.authFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (!heroes) return <p className="muted">{t("app.loading")}</p>;
  const selDungeon = dungeons.find((x) => x.id === dungeonId);

  return (
    <>
      <section className="card row-card">
        <div className="portrait sm" aria-hidden>
          {(user.firstName[0] ?? "?").toUpperCase()}
        </div>
        <div className="grow">
          <div className="label">{t("profile.heading")}</div>
          <div className="name">{user.firstName}</div>
        </div>
        <div className="gold">🪙 {gold}</div>
      </section>
      {sp && (
        <div className="muted small">
          {t("invite.opened")}: {sp.kind} {sp.id}
        </div>
      )}

      {active && (
        <button className="btn wide" onClick={() => onPlay(active)}>
          ⚔ {t("tavern.continue")}
        </button>
      )}

      <section className="card">
        <div className="label">{t("tavern.heroes")}</div>
        {heroes.map((h) => (
          <button key={h.id} className={`hero-card ${heroId === h.id ? "sel" : ""}`} disabled={h.status !== "alive"} onClick={() => setHeroId(h.id)}>
            <img src={`/art/minis/${h.classId}.png`} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
            <div className="grow">
              <b>{h.name}</b>
              <span>
                {tk(`class.${h.classId}`)} · {t("tavern.level")} {h.level} · ❤ {h.maxHp}
              </span>
              <div className="xp">
                <i style={{ width: `${(h.xp / h.xpToNext) * 100}%` }} />
              </div>
            </div>
          </button>
        ))}
        {heroes.length < 3 && !creating && (
          <button className="btn-ghost" onClick={() => setCreating(true)}>
            + {t("tavern.newHero")}
          </button>
        )}
        {creating && (
          <>
            <div className="name small-h">{t("tavern.pick")}</div>
            <div className="classes">
              {CLASSES.map((c) => (
                <button key={c} className={`class-card ${pick === c ? "sel" : ""}`} onClick={() => setPick(c)}>
                  <b>{tk(`class.${c}`)}</b>
                  <span>{tk(`class.${c}.d`)}</span>
                </button>
              ))}
            </div>
            <button className="btn wide" disabled={busy} onClick={() => void createHero()}>
              {t("tavern.newHero")}
            </button>
          </>
        )}
      </section>

      <section className="card">
        <div className="label">{t("tavern.dungeons")}</div>
        {dungeons.map((dd, i) => (
          <button key={dd.id} className={`dungeon-card ${dungeonId === dd.id ? "sel" : ""}`} disabled={!dd.unlocked} onClick={() => setDungeonId(dd.id)}>
            <span className="num">{i + 1}</span>
            <div className="grow">
              <b>{dd.title}</b>
              <span>{dd.unlocked ? (dd.cleared ? `✓ ${t("tavern.cleared")}` : `${"I".repeat(dd.tier)} ур.`) : `🔒 ${t("tavern.lockedDungeon")}`}</span>
            </div>
          </button>
        ))}
        {selDungeon && <p className="intro">{selDungeon.intro}</p>}
        {err && <p className="err">{err}</p>}
        <button className="btn wide" disabled={busy || !heroId || !dungeonId || !!active} onClick={() => void go()}>
          🔥 {t("tavern.go")}
        </button>
      </section>
    </>
  );
}
