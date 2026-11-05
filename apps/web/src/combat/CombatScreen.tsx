import {
  effectiveFace,
  legalTargets,
  verifyJournal,
  type CommandBody,
  type GameEvent,
  type Intent,
  type SessionState,
  type VisibleState,
} from "@kf/engine";
import type { Face } from "@kf/schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isMuted, play, setMuted, unlockAudio } from "../audio/sound";
import { t, tk } from "../i18n";
import { GameClient, type Batch } from "../lib/game";
import { hapticImpact, setBack } from "../lib/telegram";
import { faceDataUrl } from "../scene/glyphs";
import { Stage3D, webglAvailable } from "../scene/stage3d";
import { animateEvent, unitsOf, type UiHooks } from "./animate";
import "./combat.css";

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const reducedPref = () => {
  try {
    return localStorage.getItem("kf.reduced") === "1" || matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

interface Props {
  sessionId: string;
  userId: string;
  onExit: () => void;
  onAgain: () => void;
}

type Mode = { kind: "idle" } | { kind: "target"; die: number; star?: number } | { kind: "star"; die: number } | { kind: "reroll"; fate: boolean; dice: number[] };

export default function CombatScreen({ sessionId, userId, onExit, onAgain }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Stage3D | null>(null);
  const dispRef = useRef<VisibleState | null>(null);
  const truthRef = useRef<VisibleState | null>(null);
  const queueRef = useRef<Batch[]>([]);
  const runningRef = useRef(false);
  const unitEls = useRef(new Map<string, HTMLDivElement>());
  const [, force] = useState(0);
  const rerender = useCallback(() => force((n) => n + 1), []);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [toast, setToast] = useState<{ text: string; tone: string; id: number } | null>(null);
  const [online, setOnline] = useState(true);
  const [sending, setSending] = useState(false);
  const [muted, setMutedState] = useState(isMuted());
  const [reduced, setReduced] = useState(reducedPref());
  const [skip, setSkip] = useState(false);
  const [journal, setJournal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasGl = useMemo(() => webglAvailable(), []);
  const client = useMemo(() => new GameClient(sessionId), [sessionId]);

  const d = dispRef.current;
  const me = d?.heroes.find((h) => h.ownerId === userId) ?? null;

  // ───────── Подписи и числа над миниатюрами ─────────
  const floater = useCallback((unitId: string, text: string, cls: string) => {
    const pos = stageRef.current?.screenPos(unitId) ?? fallbackPos(unitId);
    const layer = overlayRef.current;
    if (!pos || !layer) return;
    const el = document.createElement("div");
    el.className = `floater ${cls}`;
    el.textContent = text;
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 1100);
  }, []);

  const fallbackPos = (id: string) => {
    const el = unitEls.current.get(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const host = overlayRef.current!.getBoundingClientRect();
    return { x: r.left - host.left + r.width / 2, y: r.top - host.top };
  };

  const placeOverlays = useCallback(() => {
    const st = stageRef.current;
    if (!st) return;
    for (const [id, el] of unitEls.current) {
      // Подписи героев — под подставкой, монстров — над головой: так они не пересекаются.
      const hero = st.sideOf(id) === "hero";
      const p = st.screenPos(id, hero ? "base" : "top");
      if (!p) {
        el.style.visibility = "hidden";
        continue;
      }
      el.style.visibility = "visible";
      el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, ${hero ? "0" : "-100%"})`;
    }
  }, []);

  const ui: UiHooks = useMemo(
    () => ({
      toast: (text, tone = "good") => setToast({ text, tone, id: Date.now() }),
      floater,
      render: rerender,
      t: (k) => tk(k),
    }),
    [floater, rerender],
  );

  // ───────── Очередь анимаций ─────────
  const pump = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setBusy(true);
    try {
      while (queueRef.current.length) {
        const b = queueRef.current.shift()!;
        const stage = stageRef.current;
        if (b.kind === "sync" || !dispRef.current) {
          // Переподключение или первый вход: ставим всё на места без анимации.
          dispRef.current = clone(b.state);
          if (stage) {
            stage.exploring = b.state.phase === "explore";
            stage.setUnits(unitsOf(b.state));
            stage.setLight(b.state.light);
          }
          truthRef.current = b.state;
          rerender();
          continue;
        }
        const disp = dispRef.current;
        for (const ev of b.events) await animateEvent(ev as GameEvent, disp, stage, ui);
        // Истина — то, что прислал сервер.
        dispRef.current = clone(b.state);
        truthRef.current = b.state;
        if (stage) {
          stage.exploring = b.state.phase === "explore";
          stage.setUnits(unitsOf(b.state));
        }
        rerender();
      }
    } finally {
      runningRef.current = false;
      setBusy(false);
    }
  }, [rerender, ui]);

  useEffect(() => {
    if (hasGl && hostRef.current) {
      stageRef.current = new Stage3D(hostRef.current, {
        onFrame: placeOverlays,
        onImpact: (s) => {
          play("dice", s);
          if (s > 0.25) hapticImpact(s > 0.6 ? "medium" : "light");
        },
      });
      stageRef.current.setSkip(reduced);
    }
    const offB = client.onBatch((b) => {
      queueRef.current.push(b);
      void pump();
    });
    const offS = client.onStatus(setOnline);
    client
      .load()
      .then(() => client.connect())
      .catch(() => setError("load"));
    setBack(onExit);
    const onVis = () => document.visibilityState === "visible" && void client.resync();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      offB();
      offS();
      client.close();
      stageRef.current?.dispose();
      stageRef.current = null;
      setBack(null);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    stageRef.current?.setSkip(skip || reduced);
  }, [skip, reduced]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast((x) => (x?.id === toast.id ? null : x)), 2600);
    return () => clearTimeout(id);
  }, [toast]);

  // ───────── Команды ─────────
  const send = useCallback(
    async (body: CommandBody) => {
      unlockAudio();
      play("tap");
      setSending(true);
      try {
        const ack = await client.send(body);
        if (!ack.ok && ack.error && ack.error !== "stale_seq") ui.toast(ack.error, "bad");
      } finally {
        setSending(false);
      }
    },
    [client, ui],
  );

  // Решения принимаются по истине, а не по ещё проигрываемой картинке.
  const truth = truthRef.current;
  const myTruth = truth?.heroes.find((h) => h.ownerId === userId) ?? null;
  const locked = busy || sending || !truth;

  const heroFace = (die: number, star?: number): Face | null =>
    myTruth ? effectiveFace(myTruth as unknown as SessionState["heroes"][number], { die, star }) : null;
  const targetsFor = (die: number, star?: number): (string | null)[] => {
    const f = heroFace(die, star);
    return f && truth && myTruth ? legalTargets(truth as unknown as SessionState, myTruth as unknown as SessionState["heroes"][number], f) : [];
  };

  const tapDie = (die: number) => {
    if (!myTruth || locked || myTruth.ready) return;
    unlockAudio();
    if (mode.kind === "reroll") {
      const has = mode.dice.includes(die);
      setMode({ ...mode, dice: has ? mode.dice.filter((x) => x !== die) : [...mode.dice, die] });
      return;
    }
    const rolled = myTruth.dice[die]![myTruth.roll[die]!]!;
    if (rolled.t === "SKULL") return;
    if (rolled.t === "STAR") {
      setMode(mode.kind === "star" && mode.die === die ? { kind: "idle" } : { kind: "star", die });
      return;
    }
    const legal = targetsFor(die);
    if (legal.includes(null)) return void send({ type: "ASSIGN_FACE", heroId: myTruth.id, die, target: null });
    if (legal.length === 1 && legal[0]) return void send({ type: "ASSIGN_FACE", heroId: myTruth.id, die, target: legal[0] });
    setMode(mode.kind === "target" && mode.die === die ? { kind: "idle" } : { kind: "target", die });
  };

  const pickStar = (die: number, star: number) => {
    const legal = targetsFor(die, star);
    if (!myTruth) return;
    if (legal.includes(null)) {
      setMode({ kind: "idle" });
      return void send({ type: "ASSIGN_FACE", heroId: myTruth.id, die, target: null, star });
    }
    if (legal.length === 1 && legal[0]) {
      setMode({ kind: "idle" });
      return void send({ type: "ASSIGN_FACE", heroId: myTruth.id, die, target: legal[0], star });
    }
    setMode({ kind: "target", die, star });
  };

  const tapUnit = (id: string) => {
    if (mode.kind !== "target" || !myTruth) return;
    const legal = targetsFor(mode.die, mode.star);
    if (!legal.includes(id)) return;
    const current = myTruth.plan?.find((a) => a.die === mode.die);
    const unassign = current?.target === id && current.star === mode.star;
    void send({ type: "ASSIGN_FACE", heroId: myTruth.id, die: mode.die, target: unassign ? null : id, ...(mode.star != null ? { star: mode.star } : {}) });
    setMode({ kind: "idle" });
  };

  const highlight = new Set<string>(mode.kind === "target" ? (targetsFor(mode.die, mode.star).filter(Boolean) as string[]) : []);

  const checkJournal = async () => {
    const j = await client.journal();
    if (!j.seed) return;
    const report = verifyJournal(j.seed, j.events as GameEvent[]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(j.seed));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    setJournal(
      `${report.ok ? t("journal.ok") : t("journal.bad")} (${report.checked} ${t("journal.rolls")}) · ${hex === j.seedHash ? t("journal.hash") : t("journal.hashBad")} · seed ${j.seed}`,
    );
  };

  if (error) return <div className="combat-error">{t("app.authFailed")}</div>;

  const phase = d?.phase;
  const ended = truth?.phase === "ended" && !busy ? truth.ended : null;
  const lightPct = d ? Math.min(100, (d.light / 40) * 100) : 100;
  const lightState = !d ? "bright" : d.light >= 25 ? "bright" : d.light >= 11 ? "dusk" : d.light >= 1 ? "dark" : "gloom";
  const trapRevealed = truth?.objects.find((o) => o.kind === "trap" && o.state === "revealed");

  return (
    <div className={`combat light-${lightState}`} onPointerDown={unlockAudio}>
      <header className="hud">
        <div className="hud-light" title="Факел">
          <span className="flame" />
          <div className="bar">
            <i style={{ width: `${lightPct}%` }} />
          </div>
          <b>{d?.light ?? "–"}</b>
        </div>
        <div className="hud-doom" title="Рок">
          ◆ <b>{d?.doom ?? 0}</b>
        </div>
        {phase === "combat" && (
          <div className="hud-round">
            {t("combat.round")} {d?.round}
          </div>
        )}
        <button
          className="hud-btn"
          aria-label={t("settings.sound")}
          onClick={() => {
            setMuted(!muted);
            setMutedState(!muted);
          }}
        >
          {muted ? "🔇" : "🔊"}
        </button>
        <button
          className={`hud-btn ${reduced ? "on" : ""}`}
          aria-label={t("settings.motion")}
          onClick={() => {
            const v = !reduced;
            setReduced(v);
            try {
              localStorage.setItem("kf.reduced", v ? "1" : "0");
            } catch {
              /* ok */
            }
          }}
        >
          ≈
        </button>
      </header>

      <div className="board">
        <div ref={hostRef} className="board-3d" />
        <div className="vignette" />
        <div ref={overlayRef} className={`overlay ${hasGl ? "" : "flat"}`}>
          {d &&
            [...d.monsters.filter((m) => m.alive), ...d.heroes.filter((h) => h.status !== "dead")].map((u) => {
              const isMon = "kind" in u;
              const hp = u.hp;
              const max = u.maxHp;
              const name = isMon ? tk(`monster.${u.kind}`) : u.name;
              return (
                <div
                  key={u.id}
                  ref={(el) => {
                    if (el) unitEls.current.set(u.id, el);
                    else unitEls.current.delete(u.id);
                  }}
                  className={`unit ${isMon ? "mon" : "hero"} ${highlight.has(u.id) ? "target" : ""}`}
                  onClick={() => tapUnit(u.id)}
                >
                  {isMon && <Intents intents={u.intents} />}
                  <div className="u-name">{name}</div>
                  <div className="u-hp">
                    <i style={{ width: `${(hp / max) * 100}%` }} />
                    <span>
                      {hp}/{max}
                    </span>
                  </div>
                  <div className="u-tags">
                    {u.block > 0 && <span className="tag blk">🛡{u.block}</span>}
                    {u.poison > 0 && <span className="tag psn">☠{u.poison}</span>}
                    {"armor" in u && u.armor > 0 && <span className="tag arm">⛨{u.armor}</span>}
                  </div>
                  {!hasGl && <div className={`flat-mini ${isMon ? "m" : "h"}`}>{name.slice(0, 1)}</div>}
                </div>
              );
            })}
        </div>
        {toast && <div className={`toast ${toast.tone}`}>{toast.text}</div>}
        {!online && <div className="offline">{t("toast.reconnecting")}</div>}
        {busy && !reduced && (
          <button className={`skip ${skip ? "on" : ""}`} onClick={() => setSkip(!skip)}>
            ⏩ {t("combat.skip")}
          </button>
        )}
      </div>

      <footer className="panel">
        {phase === "explore" && me && (
          <div className="actions">
            <div className="panel-title">{t("explore.title")}</div>
            <button className="act" disabled={locked} onClick={() => send({ type: "INTERACT", heroId: me.id, objectId: "corridor", verb: "inspect" })}>
              🔍 {t("explore.inspect")} <small>d20 + {t("attr.INT")}</small>
            </button>
            {trapRevealed && (
              <button className="act" disabled={locked} onClick={() => send({ type: "INTERACT", heroId: me.id, objectId: trapRevealed.id, verb: "disarm" })}>
                🔧 {t("explore.disarm")} <small>d20 + {t("attr.DEX")}</small>
              </button>
            )}
            <div className="row2">
              <button
                className="act ghost"
                disabled={locked}
                onClick={() => send({ type: "CHANGE_ROW", heroId: me.id, row: me.row === "front" ? "back" : "front" })}
              >
                {me.row === "front" ? t("explore.row.back") : t("explore.row.front")}
              </button>
              <button className="act primary" disabled={locked} onClick={() => send({ type: "MOVE", heroId: me.id, objectId: "door_1" })}>
                {t("explore.move")} ▶
              </button>
            </div>
          </div>
        )}

        {phase === "combat" && me && me.status === "up" && (
          <CombatControls
            me={me}
            truthHero={myTruth}
            locked={locked}
            mode={mode}
            setMode={setMode}
            tapDie={tapDie}
            pickStar={pickStar}
            send={send}
            names={Object.fromEntries([...(d?.monsters ?? []).map((m) => [m.id, tk(`monster.${m.kind}`)]), ...(d?.heroes ?? []).map((h) => [h.id, h.name])])}
          />
        )}
        {phase === "combat" && me && me.status !== "up" && <div className="panel-title">{t("combat.waiting")}</div>}
      </footer>

      {ended && (
        <div className="end">
          <div className={`end-card ${ended.reason}`}>
            <h2>{ended.reason === "victory" ? t("end.victory") : t("end.defeat")}</h2>
            <p>{ended.reason === "victory" ? t("end.victory.d") : t("end.defeat.d")}</p>
            <button className="act primary" onClick={onAgain}>
              {t("end.again")}
            </button>
            <button className="act ghost" onClick={onExit}>
              {t("end.tavern")}
            </button>
            <button className="link" onClick={() => void checkJournal()}>
              {t("end.journal")}
            </button>
            {journal && <p className="journal">{journal}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function Intents({ intents }: { intents: Intent[] }) {
  if (!intents.length) return null;
  return (
    <div className="intents">
      {intents.map((it, i) => (
        <span key={i} className={`intent ${it.kind}`}>
          {it.kind === "attack" && `⚔${it.amount}${it.targets.length > 1 ? `×${it.targets.length}` : ""}${it.pierce ? "!" : ""}`}
          {it.kind === "block" && `🛡${it.amount}`}
          {it.kind === "doom" && `◆+${it.amount}`}
          {it.kind === "charge" && "…"}
          {it.kind === "summon" && "⤒"}
          {it.kind === "drain" && `🔥−${it.amount}`}
        </span>
      ))}
    </div>
  );
}

interface CCProps {
  me: VisibleState["heroes"][number];
  truthHero: VisibleState["heroes"][number] | null;
  locked: boolean;
  mode: Mode;
  setMode: (m: Mode) => void;
  tapDie: (die: number) => void;
  pickStar: (die: number, star: number) => void;
  send: (b: CommandBody) => Promise<void>;
  names: Record<string, string>;
}

function CombatControls({ me, truthHero, locked, mode, setMode, tapDie, pickStar, send, names }: CCProps) {
  const h = truthHero ?? me;
  const rolled = h.roll.every((r) => r !== null);
  if (!rolled)
    return (
      <div className="actions">
        <button className="act primary big" disabled={locked} onClick={() => send({ type: "ROLL_DICE", heroId: h.id })}>
          🎲 {t("combat.roll")}
        </button>
      </div>
    );
  const plan = h.plan ?? [];
  return (
    <div className="actions">
      <div className="dice-row">
        {h.roll.map((idx, die) => {
          const face = h.dice[die]![idx!]!;
          const a = plan.find((x) => x.die === die);
          const shown = a?.star != null ? h.dice[die]![a.star]! : face;
          const sel =
            (mode.kind === "target" && mode.die === die) || (mode.kind === "star" && mode.die === die) || (mode.kind === "reroll" && mode.dice.includes(die));
          return (
            <button key={die} className={`die-chip ${sel ? "sel" : ""} ${a ? "assigned" : ""} ${face.t === "SKULL" ? "skull" : ""}`} onClick={() => tapDie(die)} disabled={locked || h.ready}>
              <img src={faceDataUrl(shown)} alt={face.t} />
              {a?.star != null && <span className="star-mark">★</span>}
              <span className="die-target">{a ? (a.target ? names[a.target] ?? "" : "все") : ""}</span>
            </button>
          );
        })}
      </div>

      {mode.kind === "star" && (
        <div className="star-pick">
          <div className="hint">{t("combat.starPick")}</div>
          <div className="star-faces">
            {h.dice[mode.die]!.map((f, i) =>
              f.t === "STAR" || f.t === "SKULL" ? null : (
                <button key={i} className="die-chip small" onClick={() => pickStar(mode.die, i)}>
                  <img src={faceDataUrl(f)} alt={f.t} />
                </button>
              ),
            )}
          </div>
        </div>
      )}
      {mode.kind === "target" && <div className="hint">{t("combat.pickTarget")}</div>}

      {mode.kind === "reroll" ? (
        <div className="row2">
          <button className="act ghost" onClick={() => setMode({ kind: "idle" })}>
            {t("combat.cancel")}
          </button>
          <button
            className="act primary"
            disabled={locked || !mode.dice.length}
            onClick={() => {
              void send({ type: mode.fate ? "USE_FATE_DEBT" : "REROLL", heroId: h.id, dice: mode.dice });
              setMode({ kind: "idle" });
            }}
          >
            {t("combat.doReroll")} {mode.dice.length || ""} {mode.fate ? `· ${t("combat.fate.hint")}` : ""}
          </button>
        </div>
      ) : h.ready ? (
        <div className="row2">
          <div className="panel-title">{t("combat.waiting")}</div>
          <button className="act ghost" disabled={locked} onClick={() => send({ type: "READY", heroId: h.id, ready: false })}>
            {t("combat.unready")}
          </button>
        </div>
      ) : (
        <div className="row3">
          <button className="act ghost" disabled={locked || h.freeRerolls < 1} onClick={() => setMode({ kind: "reroll", fate: false, dice: [] })}>
            ↻ {t("combat.reroll")} {h.freeRerolls}
          </button>
          <button className="act ghost" disabled={locked} onClick={() => setMode({ kind: "reroll", fate: true, dice: [] })}>
            ◆ {t("combat.fate")}
          </button>
          <button className="act primary" disabled={locked} onClick={() => send({ type: "READY", heroId: h.id, ready: true })}>
            ✓ {t("combat.ready")}
          </button>
        </div>
      )}
    </div>
  );
}
