import type { UserProfile } from "@kf/schema";
import { parseStartParam } from "@kf/schema";
import { useCallback, useEffect, useState } from "react";
import { unlockAudio } from "../audio/sound";
import { t, tk } from "../i18n";
import { ApiError, get, post } from "../lib/api";
import { setBack } from "../lib/telegram";
import { Lobby } from "./Lobby";
import "./tavern.css";

interface HeroCard {
  id: string;
  classId: string;
  name: string;
  level: number;
  xp: number;
  xpToNext: number;
  maxHp: number;
  status: string;
}
interface DungeonCard {
  id: string;
  title: string;
  tier: number;
  unlocked: boolean;
  cleared: boolean;
  intro: string;
}
interface Item {
  id: string;
  key: string;
  rarity: string;
  slot: "weapon" | "armor" | "relic" | null;
  name: string;
  desc: string;
  equippedHeroId: string | null;
  status: string;
}
interface Listing {
  listingId: string;
  price: number;
  sellerId: string;
  item: Item;
}

const CLASSES = ["guardian", "rogue", "sorcerer", "healer"] as const;
type Tab = "play" | "gear" | "market";

export function Tavern({ user, startParam, onPlay }: { user: UserProfile; startParam: string | null; onPlay: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>("play");
  const [heroes, setHeroes] = useState<HeroCard[] | null>(null);
  const [gold, setGold] = useState(0);
  const [heroId, setHeroId] = useState<string | null>(null);
  const sp = parseStartParam(startParam);
  const [tableId, setTableId] = useState<string | null>(sp?.kind === "table" ? sp.id : null);

  const loadHeroes = useCallback(async () => {
    const h = await get<{ heroes: HeroCard[]; gold: number }>("/heroes");
    setHeroes(h.heroes);
    setGold(h.gold);
    setHeroId((cur) => (cur && h.heroes.some((x) => x.id === cur) ? cur : (h.heroes.find((x) => x.status === "alive")?.id ?? h.heroes[0]?.id ?? null)));
  }, []);

  useEffect(() => {
    setBack(null);
    void loadHeroes();
  }, [loadHeroes]);

  if (!heroes) return <p className="muted">{t("app.loading")}</p>;
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
      {tableId && <Lobby tableId={tableId} userId={user.id} heroId={heroId} onPlay={onPlay} onClose={() => setTableId(null)} />}
      <nav className="tabs">
        {(["play", "gear", "market"] as Tab[]).map((x) => (
          <button key={x} className={tab === x ? "on" : ""} onClick={() => setTab(x)}>
            {t(`tab.${x}`)}
          </button>
        ))}
      </nav>
      {tab === "play" && <PlayTab heroes={heroes} heroId={heroId} setHeroId={setHeroId} reload={loadHeroes} onPlay={onPlay} onTable={setTableId} inTable={!!tableId} />}
      {tab === "gear" && <GearTab heroes={heroes} heroId={heroId} setHeroId={setHeroId} onGold={setGold} />}
      {tab === "market" && <MarketTab userId={user.id} gold={gold} onGold={setGold} />}
    </>
  );
}

function HeroPicker({ heroes, heroId, setHeroId }: { heroes: HeroCard[]; heroId: string | null; setHeroId: (id: string) => void }) {
  return (
    <>
      {heroes.map((h) => (
        <button key={h.id} className={`hero-card ${heroId === h.id ? "sel" : ""}`} disabled={h.status === "dead"} onClick={() => setHeroId(h.id)}>
          <img src={`/art/minis/${h.classId}.webp`} alt="" onError={(e) => { const i = e.target as HTMLImageElement; if (i.src.endsWith(".webp")) i.src = i.src.replace(/\.webp$/, ".png"); else i.style.visibility = "hidden"; }} />
          <div className="grow">
            <b>{h.name}</b>
            <span>
              {tk(`class.${h.classId}`)} · {t("tavern.level")} {h.level} · ❤ {h.maxHp}
              {h.status === "in_session" ? " · ⚔" : ""}
            </span>
            <div className="xp">
              <i style={{ width: `${(h.xp / h.xpToNext) * 100}%` }} />
            </div>
          </div>
        </button>
      ))}
    </>
  );
}

function PlayTab({
  heroes,
  heroId,
  setHeroId,
  reload,
  onPlay,
  onTable,
  inTable,
}: {
  heroes: HeroCard[];
  heroId: string | null;
  setHeroId: (id: string) => void;
  reload: () => Promise<void>;
  onPlay: (id: string) => void;
  onTable: (id: string) => void;
  inTable: boolean;
}) {
  const [dungeons, setDungeons] = useState<DungeonCard[]>([]);
  const [exp, setExp] = useState<{ unlocked: boolean; biomes: string[] }>({ unlocked: false, biomes: [] });
  const [active, setActive] = useState<string | null>(null);
  const [target, setTarget] = useState<{ kind: "official"; id: string } | { kind: "expedition"; biome: string } | null>(null);
  const [creating, setCreating] = useState(!heroes.length);
  const [pick, setPick] = useState<string>("guardian");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [dd, a] = await Promise.all([
        get<{ official: DungeonCard[]; expeditions: { unlocked: boolean; biomes: string[] } }>("/dungeons"),
        get<{ sessionId: string | null }>("/sessions/active"),
      ]);
      setDungeons(dd.official);
      setExp(dd.expeditions);
      setActive(a.sessionId);
      setTarget((cur) => {
        if (cur) return cur;
        const next = dd.official.find((x) => x.unlocked && !x.cleared);
        if (next) return { kind: "official", id: next.id };
        return dd.expeditions.unlocked ? { kind: "expedition", biome: dd.expeditions.biomes[0]! } : null;
      });
    })();
  }, []);

  const createHero = async () => {
    setBusy(true);
    try {
      const h = await post<HeroCard>("/heroes", { classId: pick });
      setHeroId(h.id);
      setCreating(false);
      await reload();
    } catch (e) {
      setErr(e instanceof ApiError && e.code === "slots_full" ? t("tavern.slotsFull") : t("app.authFailed"));
    } finally {
      setBusy(false);
    }
  };

  const go = async () => {
    if (!heroId || !target) return;
    unlockAudio();
    setBusy(true);
    setErr(null);
    try {
      const body = target.kind === "official" ? { heroId, dungeonId: target.id } : { heroId, biome: target.biome };
      const r = await post<{ sessionId: string }>("/sessions", body);
      onPlay(r.sessionId);
    } catch (e) {
      setErr(e instanceof ApiError ? tk(`err.${e.code}`) : t("app.authFailed"));
    } finally {
      setBusy(false);
    }
  };

  const party = async () => {
    if (!heroId || target?.kind !== "expedition") return;
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ tableId: string }>("/tables", { biome: target.biome, heroId, mode: "live" });
      onTable(r.tableId);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setErr(e instanceof ApiError ? tk(`err.${e.code}`) : t("app.authFailed"));
    } finally {
      setBusy(false);
    }
  };

  const intro = target?.kind === "official" ? dungeons.find((d) => d.id === target.id)?.intro : target ? t("exp.note") : "";

  return (
    <>
      {active && (
        <button className="btn wide" onClick={() => onPlay(active)}>
          ⚔ {t("tavern.continue")}
        </button>
      )}
      <section className="card">
        <div className="label">{t("tavern.heroes")}</div>
        <HeroPicker heroes={heroes} heroId={heroId} setHeroId={setHeroId} />
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
                  <img src={`/art/minis/${c}.webp`} alt="" onError={(e) => { const i = e.target as HTMLImageElement; if (i.src.endsWith(".webp")) i.src = i.src.replace(/\.webp$/, ".png"); else i.style.display = "none"; }} />
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
          <button
            key={dd.id}
            className={`dungeon-card ${target?.kind === "official" && target.id === dd.id ? "sel" : ""}`}
            disabled={!dd.unlocked}
            onClick={() => setTarget({ kind: "official", id: dd.id })}
          >
            <span className="num">{i + 1}</span>
            <div className="grow">
              <b>{dd.title}</b>
              <span>{dd.unlocked ? (dd.cleared ? `✓ ${t("tavern.cleared")}` : `${"I".repeat(dd.tier)} ур.`) : `🔒 ${t("tavern.lockedDungeon")}`}</span>
            </div>
          </button>
        ))}
        <div className="label">{t("exp.title")}</div>
        {!exp.unlocked && <p className="muted small">🔒 {t("exp.locked")}</p>}
        <div className="biomes">
          {exp.biomes.map((b) => (
            <button
              key={b}
              className={`biome-card b-${b} ${target?.kind === "expedition" && target.biome === b ? "sel" : ""}`}
              disabled={!exp.unlocked}
              onClick={() => setTarget({ kind: "expedition", biome: b })}
              style={{ backgroundImage: `linear-gradient(rgba(10,6,3,.35), rgba(10,6,3,.85)), url(/art/ground/${b}.jpg)` }}
            >
              <b>{tk(`biome.${b}`)}</b>
              <span>{tk(`biome.${b}.d`)}</span>
            </button>
          ))}
        </div>
        {intro && <p className="intro">{intro}</p>}
        {err && <p className="err">{err}</p>}
        <button className="btn wide" disabled={busy || !heroId || !target || !!active} onClick={() => void go()}>
          🔥 {target?.kind === "expedition" ? t("exp.go") : t("tavern.go")}
        </button>
        {target?.kind === "expedition" && (
          <button className="btn-ghost" disabled={busy || !heroId || !!active || inTable} onClick={() => void party()}>
            👥 {t("party.create")}
          </button>
        )}
      </section>
    </>
  );
}

export function ItemIcon({ id, slot }: { id: string; slot?: string | null }) {
  const [bad, setBad] = useState(false);
  const fb = slot === "weapon" ? "🗡" : slot === "armor" ? "🛡" : "✦";
  return bad ? <span className="item-ic fb">{fb}</span> : <img className="item-ic" src={`/art/items/${id}.webp`} alt="" onError={() => setBad(true)} />;
}

function GearTab({ heroes, heroId, setHeroId, onGold }: { heroes: HeroCard[]; heroId: string | null; setHeroId: (id: string) => void; onGold: (n: number) => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [sell, setSell] = useState<Item | null>(null);
  const [price, setPrice] = useState("50");
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await get<{ items: Item[]; gold: number }>("/inventory");
    setItems(r.items);
    onGold(r.gold);
  }, [onGold]);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? tk(`err.${e.code}`) : t("err.generic"));
    }
  };
  if (!items) return <p className="muted">{t("app.loading")}</p>;
  const hero = heroes.find((h) => h.id === heroId);
  const worn = items.filter((i) => i.equippedHeroId === heroId);
  const free = items.filter((i) => !i.equippedHeroId);
  const slots: { slot: "weapon" | "armor" | "relic"; idx: number }[] = [
    { slot: "weapon", idx: 0 },
    { slot: "armor", idx: 0 },
    { slot: "relic", idx: 0 },
    { slot: "relic", idx: 1 },
  ];
  return (
    <>
      <section className="card">
        <div className="label">{t("gear.hero")}</div>
        <HeroPicker heroes={heroes} heroId={heroId} setHeroId={setHeroId} />
        {hero && (
          <div className="slots">
            {slots.map(({ slot, idx }) => {
              const it = worn.filter((w) => w.slot === slot)[idx];
              return (
                <button key={`${slot}${idx}`} className={`slot ${it ? `r-${it.rarity}` : ""}`} disabled={!it || hero.status !== "alive"} onClick={() => it && void act(() => post("/items/unequip", { itemId: it.id }))}>
                  {it ? <ItemIcon id={it.key} slot={it.slot} /> : <span className="item-ic fb">·</span>}
                  <span>{it ? it.name : t(`slot.${slot}`)}</span>
                  {it && <small>{t("gear.unequip")}</small>}
                </button>
              );
            })}
          </div>
        )}
      </section>
      <section className="card">
        <div className="label">{t("gear.inventory")}</div>
        {!free.length && <p className="muted small">{t("gear.empty")}</p>}
        {free.map((it) => (
          <div key={it.id} className={`gear-row r-${it.rarity}`}>
            <ItemIcon id={it.key} slot={it.slot} />
            <div className="grow">
              <b>{it.name}</b>
              <small>
                {tk(`slot.${it.slot}`)} · {tk(`rarity.${it.rarity}`)} · {it.desc}
              </small>
            </div>
            {it.status === "listed" ? (
              <span className="pill">{t("gear.listed")}</span>
            ) : (
              <div className="col">
                <button className="mini-btn" disabled={!hero || hero.status !== "alive"} onClick={() => heroId && void act(() => post(`/heroes/${heroId}/equip`, { itemId: it.id }))}>
                  {t("gear.equip")}
                </button>
                <button className="mini-btn ghost" onClick={() => setSell(it)}>
                  {t("gear.sell")}
                </button>
              </div>
            )}
          </div>
        ))}
        {err && <p className="err">{err}</p>}
      </section>
      {sell && (
        <div className="sheet-bg" onClick={() => setSell(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>
              {t("gear.sell")}: {sell.name}
            </h3>
            <label className="muted small">{t("gear.price")}</label>
            <input className="price" inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value.replace(/\D/g, ""))} />
            <p className="muted small">{t("market.note")}</p>
            <button
              className="btn wide"
              onClick={() => {
                const it = sell;
                setSell(null);
                void act(() => post("/market", { itemId: it.id, price: Number(price) }));
              }}
            >
              {t("gear.sell")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function MarketTab({ userId, gold, onGold }: { userId: string; gold: number; onGold: (n: number) => void }) {
  const [list, setList] = useState<Listing[] | null>(null);
  const [slot, setSlot] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await get<{ listings: Listing[] }>(`/market${slot ? `?slot=${slot}` : ""}`);
    setList(r.listings);
    const inv = await get<{ gold: number }>("/inventory");
    onGold(inv.gold);
  }, [slot, onGold]);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? tk(`err.${e.code}`) : t("err.generic"));
      await load();
    }
  };
  return (
    <section className="card">
      <p className="muted small">{t("market.note")}</p>
      <div className="filters">
        {["", "weapon", "armor", "relic"].map((s) => (
          <button key={s} className={slot === s ? "on" : ""} onClick={() => setSlot(s)}>
            {s ? tk(`slot.${s}`) : "Все"}
          </button>
        ))}
      </div>
      {list && !list.length && <p className="muted small">{t("market.empty")}</p>}
      {list?.map((l) => (
        <div key={l.listingId} className={`gear-row r-${l.item.rarity}`}>
          <ItemIcon id={l.item.key} slot={l.item.slot} />
          <div className="grow">
            <b>{l.item.name}</b>
            <small>
              {tk(`rarity.${l.item.rarity}`)} · {l.item.desc}
            </small>
          </div>
          {l.sellerId === userId ? (
            <button className="mini-btn ghost" onClick={() => void act(() => post(`/market/${l.listingId}/cancel`, {}))}>
              {t("market.cancel")}
            </button>
          ) : (
            <button className="mini-btn" disabled={gold < l.price} onClick={() => void act(() => post(`/market/${l.listingId}/buy`, {}))}>
              🪙 {l.price}
            </button>
          )}
        </div>
      ))}
      {err && <p className="err">{err}</p>}
    </section>
  );
}
