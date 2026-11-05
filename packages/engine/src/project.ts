import { clone } from "./clone.js";
import { isSeen, visibleObject, visibleTile } from "./grid.js";
import type { GameEvent, Hero, SessionState, VisibleObject } from "./types.js";

export type VisibleHero = Omit<Hero, "plan"> & { plan: Hero["plan"] | null };

/** То, что видит участник: без описания подземелья, скрытых объектов, неоткрытых клеток и чужих решений. */
export interface VisibleState {
  v: 2;
  seq: number;
  dungeonId: string;
  title: string;
  tier: number;
  tutorial: boolean;
  phase: SessionState["phase"];
  partySize: number;
  light: number;
  doom: number;
  heroes: VisibleHero[];
  monsters: SessionState["monsters"];
  round: number;
  step: SessionState["step"];
  map: { w: number; h: number; tiles: string[] };
  pos: SessionState["pos"];
  leaderId: string;
  objects: VisibleObject[];
  /** Замеченные, но не побеждённые враги на карте. */
  encounters: { id: string; kinds: string[]; x: number; y: number }[];
  bag: SessionState["bag"];
  biome: string;
  allies: SessionState["allies"];
  story: string[];
  ended: SessionState["ended"];
}

export function project(s: SessionState, viewerId: string): VisibleState {
  const { w, h } = s.def.size;
  const tiles: string[] = [];
  for (let y = 0; y < h; y++) {
    let row = "";
    for (let x = 0; x < w; x++) row += isSeen(s, x, y) ? visibleTile(s, x, y) : " ";
    tiles.push(row);
  }
  return {
    v: 2,
    seq: s.seq,
    dungeonId: s.dungeonId,
    title: s.title,
    tier: s.tier,
    tutorial: s.tutorial,
    phase: s.phase,
    partySize: s.partySize,
    light: s.light,
    doom: s.doom,
    heroes: s.heroes.map((hh) => ({ ...clone(hh), plan: hh.ownerId === viewerId ? clone(hh.plan) : null })),
    monsters: clone(s.monsters),
    round: s.round,
    step: s.step,
    map: { w, h, tiles },
    pos: { ...s.pos },
    leaderId: s.leaderId,
    objects: s.objects.filter((o) => !o.hidden && isSeen(s, o.x, o.y) && !(o.type === "key" && o.used)).map(visibleObject),
    encounters: s.def.encounters
      .filter((e) => {
        const st = s.encounters.find((x) => x.id === e.id)!;
        return st.spotted && !st.done && e.id !== s.encounterId;
      })
      .map((e) => ({ id: e.id, kinds: e.monsters, x: Math.floor(e.zone.x + e.zone.w / 2), y: Math.floor(e.zone.y + e.zone.h / 2) })),
    bag: clone(s.bag),
    biome: s.biome,
    allies: clone(s.allies),
    story: [...s.story],
    ended: s.ended,
  };
}

/** Проекция события. null — событие этому участнику не показывается. */
export function projectEvent(ev: GameEvent, viewerId: string): GameEvent | null {
  switch (ev.type) {
    case "SESSION_STARTED":
      // Описание подземелья (скрытые ловушки, правила) клиенту не отдаётся.
      return { seq: ev.seq, type: "SESSION_ENTERED" };
    case "FACE_ASSIGNED":
      return ev.actorId === viewerId ? ev : null;
    case "TILE_CHANGED":
      // Изменения плиток показываются только после того, как клетку увидят.
      return { ...ev, cells: [] };
    default:
      return ev;
  }
}
