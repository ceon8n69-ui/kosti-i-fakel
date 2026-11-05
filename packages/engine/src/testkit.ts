import { applyCommand } from "./commands.js";
import { replay } from "./reducer.js";
import { Rng } from "./rng.js";
import { startSession, type HeroSeed } from "./session.js";
import type { CommandBody, CommandResult, GameEvent, SessionState } from "./types.js";

/** Тестовый стол: держит журнал и прогоняет команды так же, как сервер. */
export class Table {
  events: GameEvent[];
  state: SessionState;
  private n = 0;

  constructor(
    public seed = "00000000000000aa",
    heroes: HeroSeed[] = [{ ownerId: "u1", classId: "guardian", name: "Брам" }],
    scenarioId = "slice_cellar",
  ) {
    const first = startSession({ scenarioId, seedHash: "test", heroes });
    this.events = [first];
    this.state = replay(this.events);
  }

  run(body: CommandBody, actorId = this.state.heroes.find((h) => h.id === (body as { heroId: string }).heroId)?.ownerId ?? "u1"): CommandResult {
    const cmd = { ...body, commandId: `c${++this.n}`, expectedSeq: this.state.seq, actorId } as Parameters<typeof applyCommand>[1];
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

  /** Прямое изменение состояния для подготовки граничных случаев. Журнал при этом не используется. */
  patch(fn: (s: SessionState) => void): void {
    fn(this.state);
  }

  types(events: GameEvent[]): string[] {
    return events.map((e) => e.type);
  }
}
