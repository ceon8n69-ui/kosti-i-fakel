import { clone } from "./clone.js";
import type { GameEvent, Hero, SessionState } from "./types.js";

/** То, что видит конкретный участник. Не содержит скрытых объектов, чужих решений и счётчика ГСЧ. */
export type VisibleHero = Omit<Hero, "plan"> & { plan: Hero["plan"] | null };
export type VisibleState = Omit<SessionState, "rngCounter" | "objects" | "heroes"> & {
  objects: SessionState["objects"];
  heroes: VisibleHero[];
};

export function project(s: SessionState, viewerId: string): VisibleState {
  const { rngCounter: _rng, ...rest } = s;
  return {
    ...clone(rest),
    objects: s.objects
      .filter((o) => !o.hidden)
      .map((o) => clone(o)),
    heroes: s.heroes.map((h) => ({
      ...clone(h),
      // Чужие назначения граней видны только после раскрытия (в фазе разрешения).
      plan: h.ownerId === viewerId ? clone(h.plan) : null,
    })),
  };
}

/** Проекция события. null — событие этому участнику не показывается. */
export function projectEvent(ev: GameEvent, viewerId: string): GameEvent | null {
  switch (ev.type) {
    case "SESSION_STARTED": {
      const initial = ev.initial;
      return {
        ...ev,
        initial: {
          ...initial,
          rngCounter: 0,
          objects: initial.objects.filter((o) => !o.hidden),
          heroes: initial.heroes.map((h) => ({ ...h, plan: h.ownerId === viewerId ? h.plan : [] })),
        },
      };
    }
    case "FACE_ASSIGNED":
      return ev.actorId === viewerId ? ev : null;
    default:
      return ev;
  }
}
