import type { DungeonDefinition } from "@kf/schema";
import { applyCommand, openSession } from "./commands.js";
import { replay } from "./reducer.js";
import { Rng } from "./rng.js";
import { startSession, type HeroSeed } from "./session.js";
import type { CommandBody, CommandResult, GameEvent, SessionState } from "./types.js";

/** Небольшая арена для тестов боя: шаг вправо — и бой. */
export const ARENA: DungeonDefinition = {
  schemaVersion: 1,
  id: "test_arena",
  title: "Арена",
  tier: 1,
  tutorial: true,
  size: { w: 8, h: 5 },
  tiles: ["########", "#......#", "#......#", "#......#", "########"],
  objects: [
    { id: "entrance", type: "entrance", x: 1, y: 2 },
    { id: "treasury", type: "treasury", x: 6, y: 2 },
  ],
  encounters: [{ id: "fight", zone: { x: 3, y: 1, w: 2, h: 3 }, monsters: ["rat_swarm", "skeleton_guard", "rotten_archer"], boss: false }],
  npcs: [],
  rules: [],
  variables: [],
  texts: { intro: "Арена." },
};

/** Тестовый стол: держит журнал и прогоняет команды так же, как сервер. */
export class Table {
  events: GameEvent[];
  state: SessionState;
  private n = 0;

  constructor(
    public seed = "00000000000000aa",
    heroes: HeroSeed[] = [{ ownerId: "u1", classId: "guardian", name: "Брам" }],
    dungeon: string | DungeonDefinition = ARENA,
  ) {
    const first = startSession({ ...(typeof dungeon === "string" ? { dungeonId: dungeon } : { dungeon }), seedHash: "test", heroes });
    this.events = openSession(first, new Rng(seed, 0));
    this.state = replay(this.events);
  }

  run(body: CommandBody, actorId?: string): CommandResult {
    const owner = this.state.heroes.find((h) => h.id === (body as { heroId: string }).heroId)?.ownerId ?? "u1";
    const cmd = { ...body, commandId: `c${++this.n}`, expectedSeq: this.state.seq, actorId: actorId ?? owner } as Parameters<typeof applyCommand>[1];
    const r = applyCommand(this.state, cmd, new Rng(this.seed, this.state.rngCounter));
    if (!r.errors.length) {
      this.events.push(...r.events);
      this.state = r.state;
    }
    return r;
  }

  ok(body: CommandBody, actorId?: string): GameEvent[] {
    const r = this.run(body, actorId);
    if (r.errors.length) throw new Error(`${body.type}: ${JSON.stringify(r.errors)}`);
    return r.events;
  }

  patch(fn: (s: SessionState) => void): void {
    fn(this.state);
  }

  types(events: GameEvent[]): string[] {
    return events.map((e) => e.type);
  }
}
