import { effectiveFace, legalTargets, verifyJournal, type CommandBody, type GameEvent, type Intent, type SessionState, type VisibleObject, type VisibleState } from "@kf/engine";
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
}

type Mode = { kind: "idle" } | { kind: "target"; die: number; star?: number } | { kind: "star"; die: number } | { kind: "reroll"; fate: boolean; dice: number[] };
interface Rewards {
  xp: number;
  gold: number;
  items: string[];
  reason: string;
}

export default function GameScreen({ sessionId, userId, onExit }: Props) {
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
  const [story, setStory] = useState<{ text: string; speaker?: string; id: number } | null>(null);
  const [online, setOnline] = useState(true);
  const [sending, setSending] = useState(false);
  const [muted, setMutedState] = useState(isMuted());
  const [reduced, setReduced] = useState(reducedPref());
  const [skip, setSkip] = useState(false);
  const [sheet, setSheet] = useState<VisibleObject | null>(null);
  const [bagOpen, setBagOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [rewards, setRewards] = useState<Rewards | null>(null);
  const [journal, setJournal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasGl = useMemo(() => webglAvailable(), []);
  const client = useMemo(() => new GameClient(sessionId), [sessionId]);

  const d = dispRef.current;
  const me = d?.heroes.find((h) => h.ownerId === userId) ?? null;

  const addFloater = useCallback((pos: { x: number; y: number } | null, text: string, cls: string) => {
    const layer = overlayRef.current;
    if (!pos || !layer) return;
    const el = document.createElement("div");
    el.className = `floater ${cls}`;
    el.textContent = text;
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 1300);
  }, []);

  const placeOverlays = useCallback(() => {
    const st = stageRef.current;
    if (!st) return;
    for (const [id, el] of unitEls.current) {
      if (st.mode !== "battle") {
        el.style.visibility = "hidden";
        continue;
      }
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
      toast: (text, tone = "good") => setToast({ text, tone, id: Date.now() + Math.random() }),
      floater: (id, text, cls) => addFloater(stageRef.current?.screenPos(id) ?? null, text, cls),
      cellFloater: (x, y, text, cls) => addFloater(stageRef.current?.cellScreen(x, y) ?? null, text, cls),
      story: (text, speaker) => setStory({ text, speaker, id: Date.now() }),
      rewards: (r) => setRewards(r),
      render: rerender,
      t: (k) => tk(k),
    }),
    [addFloater, rerender],
  );

  const snap = (s: VisibleState) => {
    dispRef.current = clone(s);
    truthRef.current = s;
    const st = stageRef.current;
    if (!st) return;
    st.map.sync(s);
    st.setUnits(unitsOf(s));
    st.setLight(s.light);
    const want = s.phase === "combat" ? "battle" : "map";
    if (st.mode !== want) st.setMode(want);
  };

  const pump = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setBusy(true);
    try {
      while (queueRef.current.length) {
        const b = queueRef.current.shift()!;
        if (b.kind === "sync" || !dispRef.current) {
          snap(b.state);
          const last = b.state.story.at(-1);
          if (last) setStory({ text: last, id: Date.now() });
          rerender();
          continue;
        }
        for (const ev of b.events) await animateEvent(ev as GameEvent, dispRef.current, stageRef.current, ui);
        snap(b.state);
        rerender();
      }
    } finally {
      runningRef.current = false;
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rerender, ui]);

  useEffect(() => {
    if (hasGl && hostRef.current) {
      const st = new Stage3D(hostRef.current, {
        onFrame: placeOverlays,
        onImpact: (s) => {
          play("dice", s);
          if (s > 0.25) hapticImpact(s > 0.6 ? "medium" : "light");
        },
      });
      st.exploring = false;
      st.setSkip(reduced);
      stageRef.current = st;
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

  useEffect(() => stageRef.current?.setSkip(skip || reduced), [skip, reduced]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast((x) => (x?.id === toast.id ? null : x)), 2600);
    return () => clearTimeout(id);
  }, [toast]);

  const send = useCallback(
    async (body: CommandBody) => {
      unlockAudio();
      play("tap");
      setSending(true);
      try {
        const ack = await client.send(body);
        if (!ack.ok && ack.error && ack.error !== "stale_seq") {
          const key = `err.${ack.error}`;
          const text = tk(key);
          ui.toast(text === key ? t("err.generic") : text, "bad");
        }
      } finally {
        setSending(false);
      }
    },
    [client, ui],
  );

  const truth = truthRef.current;
  const myTruth = truth?.heroes.find((h) => h.ownerId === userId) ?? null;
  const locked = busy || sending || !truth;
  const isLeader = !!truth && !!myTruth && truth.leaderId === myTruth.id;

  // ───────── Тапы по карте ─────────
  const down = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    unlockAudio();
    down.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const st = stageRef.current;
    const start = down.current;
    down.current = null;
    if (!st || !start || st.mode !== "map" || !truth || truth.phase !== "explore" || !myTruth) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) return;
    const hit = st.pick(e.clientX, e.clientY);
    if (hit.objectId) {
      const o = truth.objects.find((x) => x.id === hit.objectId);
      if (o) setSheet(o);
      return;
    }
    if (hit.cell) {
      const [cx, cy] = hit.cell;
      // На клетке есть объект — открываем его действия, а не идём.
      const here = truth.objects.find((o) => o.x === cx && o.y === cy && o.type !== "light");
      if (here) return setSheet(here);
      if (cx === truth.pos.x && cy === truth.pos.y) return;
      if (locked) return;
      if (!isLeader) return ui.toast(t("err.not_leader"), "bad");
      st.map.showMarker(hit.cell[0], hit.cell[1]);
      void send({ type: "MOVE", heroId: myTruth.id, x: hit.cell[0], y: hit.cell[1] });
    }
  };

  // ───────── Бой ─────────
  const heroFace = (die: number, star?: number): Face | null => (myTruth ? effectiveFace(myTruth as unknown as SessionState["heroes"][number], { die, star }) : null);
  const targetsFor = (die: number, star?: number): (string | null)[] => {
    const f = heroFace(die, star);
    return f && truth && myTruth ? legalTargets(truth as unknown as SessionState, myTruth as unknown as SessionState["heroes"][number], f) : [];
  };
  const tapDie = (die: number) => {
    if (!myTruth || locked || myTruth.ready) return;
    if (mode.kind === "reroll") {
      const has = mode.dice.includes(die);
      setMode({ ...mode, dice: has ? mode.dice.filter((x) => x !== die) : [...mode.dice, die] });
      return;
    }
    const rolled = myTruth.dice[die]![myTruth.roll[die]!]!;
    if (rolled.t === "SKULL") return;
    if (rolled.t === "STAR") return setMode(mode.kind === "star" && mode.die === die ? { kind: "idle" } : { kind: "star", die });
    const legal = targetsFor(die);
    if (legal.includes(null)) return void send({ type: "ASSIGN_FACE", heroId: myTruth.id, die, target: null });
    if (legal.length === 1 && legal[0]) return void send({ type: "ASSIGN_FACE", heroId: myTruth.id, die, target: legal[0] });
    setMode(mode.kind === "target" && mode.die === die ? { kind: "idle" } : { kind: "target", die });
  };
  const pickStar = (die: number, star: number) => {
    const legal = targetsFor(die, star);
    if (!myTruth) return;
    if (legal.includes(null) || (legal.length === 1 && legal[0])) {
      setMode({ kind: "idle" });
      return void send({ type: "ASSIGN_FACE", heroId: myTruth.id, die, target: legal.includes(null) ? null : legal[0]!, star });
    }
    setMode({ kind: "target", die, star });
  };
  const tapUnit = (id: string) => {
    if (mode.kind !== "target" || !myTruth) return;
    if (!targetsFor(mode.die, mode.star).includes(id)) return;
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
    setJournal(`${report.ok ? t("journal.ok") : t("journal.bad")} (${report.checked} ${t("journal.rolls")}) · ${hex === j.seedHash ? t("journal.hash") : t("journal.hashBad")}`);
  };

  if (error) return <div className="combat-error">{t("app.authFailed")}</div>;

  const phase = d?.phase;
  const ended = truth?.phase === "ended" && !busy ? truth.ended : null;
  const lightPct = d ? Math.min(100, (d.light / 40) * 100) : 100;
  const lightState = !d ? "bright" : d.light >= 25 ? "bright" : d.light >= 11 ? "dusk" : d.light >= 1 ? "dark" : "gloom";
  const bagCounts = (truth?.bag.items ?? []).reduce<Record<string, number>>((a, i) => ((a[i] = (a[i] ?? 0) + 1), a), {});
  const leaderName = truth?.heroes.find((h) => h.id === truth.leaderId)?.name;

  const objectActions = (o: VisibleObject): { label: string; body: CommandBody }[] => {
    if (!myTruth) return [];
    const out: { label: string; body: CommandBody }[] = [];
    const hid = myTruth.id;
    if (o.type === "trap") {
      if (o.state === "revealed") out.push({ label: t("obj.disarm"), body: { type: "INTERACT", heroId: hid, objectId: o.id, verb: "disarm" } });
      return out;
    }
    if (o.type === "light" || o.type === "plate") return out;
    if (o.type === "campfire") {
      if (!o.used) out.push({ label: tk("obj.campfire.use"), body: { type: "REST", heroId: hid, objectId: o.id } });
      return out;
    }
    if (o.type === "door" && o.open) return out;
    if (!o.used || o.type === "note" || o.type === "treasury" || o.type === "entrance") out.push({ label: tk(`obj.${o.type}.use`), body: { type: "INTERACT", heroId: hid, objectId: o.id, verb: "use" } });
    if ((o.type === "door" || o.type === "chest") && o.locked && !o.used) out.push({ label: t("obj.force"), body: { type: "INTERACT", heroId: hid, objectId: o.id, verb: "force" } });
    return out;
  };

  return (
    <div className={`combat light-${lightState}`}>
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
        {phase === "combat" ? <div className="hud-round">{t("combat.round")} {d?.round}</div> : <div className="hud-round">🪙 {truth?.bag.gold ?? 0}</div>}
        <button className="hud-btn" aria-label={t("settings.sound")} onClick={() => (setMuted(!muted), setMutedState(!muted))}>
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

      <div className="board" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
        <div ref={hostRef} className="board-3d" />
        <div className="vignette" />
        <div ref={overlayRef} className={`overlay ${hasGl ? "" : "flat"}`}>
          {d &&
            phase === "combat" &&
            [...d.monsters.filter((m) => m.alive), ...d.heroes.filter((h) => h.status !== "dead")].map((u) => {
              const isMon = "kind" in u;
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
                    <i style={{ width: `${(u.hp / u.maxHp) * 100}%` }} />
                    <span>
                      {u.hp}/{u.maxHp}
                    </span>
                  </div>
                  <div className="u-tags">
                    {u.block > 0 && <span className="tag blk">🛡{u.block}</span>}
                    {u.poison > 0 && <span className="tag psn">☠{u.poison}</span>}
                    {"armor" in u && u.armor > 0 && <span className="tag arm">⛨{u.armor}</span>}
                  </div>
                </div>
              );
            })}
        </div>
        {toast && <div className={`toast ${toast.tone}`}>{toast.text}</div>}
        {!online && <div className="offline">{t("toast.reconnecting")}</div>}
        {busy && !reduced && (
          <button className={`skip ${skip ? "on" : ""}`} onPointerUp={(e) => e.stopPropagation()} onClick={() => setSkip(!skip)}>
            ⏩ {t("combat.skip")}
          </button>
        )}
        {phase === "explore" && me && (
          <div className="party-strip">
            {d!.heroes.map((h) => (
              <div key={h.id} className={`ps-hero ${h.status}`}>
                <b>{h.name}</b>
                <div className="u-hp">
                  <i style={{ width: `${(h.hp / h.maxHp) * 100}%` }} />
                  <span>
                    {h.hp}/{h.maxHp}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <footer className="panel">
        {story && phase !== "combat" && (
          <button className="story" key={story.id} onClick={() => setLogOpen(true)}>
            {story.speaker && <b>{story.speaker}: </b>}
            {story.text}
          </button>
        )}
        {phase === "explore" && me && (
          <div className="row3">
            <button className="act ghost" disabled={locked} onClick={() => send({ type: "SEARCH", heroId: me.id })}>
              🔍 {t("map.search")}
            </button>
            <button className="act ghost" onClick={() => setBagOpen(true)}>
              🎒 {t("bag.title")} {truth?.bag.items.length ?? 0}
            </button>
            <button className="act ghost" disabled={locked} onClick={() => send({ type: "CHANGE_ROW", heroId: me.id, row: me.row === "front" ? "back" : "front" })}>
              {me.row === "front" ? t("explore.row.back") : t("explore.row.front")}
            </button>
          </div>
        )}
        {phase === "explore" && !isLeader && leaderName && (
          <div className="panel-title">
            {t("map.leaderOnly")}: {leaderName}
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
            onBag={() => setBagOpen(true)}
            names={Object.fromEntries([...(d?.monsters ?? []).map((m) => [m.id, tk(`monster.${m.kind}`)]), ...(d?.heroes ?? []).map((h) => [h.id, h.name])])}
          />
        )}
        {phase === "combat" && me && me.status !== "up" && <div className="panel-title">{t("combat.waiting")}</div>}
      </footer>

      {sheet && truth && (
        <div className="sheet-bg" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>
              {tk(`obj.${sheet.type}`)}
              {sheet.locked && !sheet.used ? ` · ${t("obj.locked")}` : ""}
            </h3>
            {objectActions(sheet).map((a) => (
              <button
                key={a.label}
                className="act"
                disabled={locked}
                onClick={() => {
                  setSheet(null);
                  void send(a.body);
                }}
              >
                {a.label}
              </button>
            ))}
            {!objectActions(sheet).length && <p className="muted">{t("err.used")}</p>}
          </div>
        </div>
      )}

      {bagOpen && truth && myTruth && (
        <div className="sheet-bg" onClick={() => setBagOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>
              {t("bag.title")} · 🪙 {truth.bag.gold}
            </h3>
            {!Object.keys(bagCounts).length && <p className="muted">{t("bag.empty")}</p>}
            {Object.entries(bagCounts).map(([id, n]) => {
              const downed = truth.heroes.find((h) => h.status === "downed");
              const hurt = [...truth.heroes].filter((h) => h.status === "up" && h.hp < h.maxHp).sort((a, b) => a.hp - b.hp)[0];
              const target = id === "potion" ? (downed ?? hurt)?.id : undefined;
              const disabled = locked || (id === "potion" && !target) || (id === "return_scroll" && truth.phase === "combat");
              return (
                <button
                  key={id}
                  className="act item"
                  disabled={disabled}
                  onClick={() => {
                    setBagOpen(false);
                    void send({ type: "USE_ITEM", heroId: myTruth.id, itemId: id, ...(target ? { targetId: target } : {}) });
                  }}
                >
                  <b>
                    {tk(`item.${id}`)} ×{n}
                  </b>
                  <small>{tk(`item.${id}.d`)}</small>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {logOpen && truth && (
        <div className="sheet-bg" onClick={() => setLogOpen(false)}>
          <div className="sheet log" onClick={(e) => e.stopPropagation()}>
            <h3>{truth.title}</h3>
            {truth.story.map((s, i) => (
              <p key={i}>{s}</p>
            ))}
          </div>
        </div>
      )}

      {ended && (
        <div className="end">
          <div className={`end-card ${ended.reason}`}>
            <h2>{ended.reason === "victory" ? t("end.victory") : ended.reason === "retreat" ? t("end.retreat") : t("end.defeat")}</h2>
            <p>{ended.reason === "victory" ? t("end.victory.d") : ended.reason === "retreat" ? t("end.retreat.d") : t("end.defeat.d")}</p>
            {rewards && (
              <div className="rewards">
                <span>
                  ✨ +{rewards.xp} {t("end.xp")}
                </span>
                <span>🪙 +{rewards.gold}</span>
                {rewards.items
                  .filter((i) => i !== "torch")
                  .map((i, k) => (
                    <span key={k}>{tk(`item.${i}`)}</span>
                  ))}
              </div>
            )}
            <button className="act primary" onClick={onExit}>
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
  onBag: () => void;
}

function CombatControls({ me, truthHero, locked, mode, setMode, tapDie, pickStar, send, names, onBag }: CCProps) {
  const h = truthHero ?? me;
  const rolled = h.roll.every((r) => r !== null);
  if (!rolled)
    return (
      <div className="actions">
        <button className="act primary big" disabled={locked} onClick={() => send({ type: "ROLL_DICE", heroId: h.id })}>
          🎲 {t("combat.roll")}
        </button>
        <button className="act ghost" onClick={onBag}>
          🎒 {t("bag.title")}
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
