import { reduceInPlace } from "./reducer.js";
import type { Rng } from "./rng.js";
import type { CommandError, EventBody, GameEvent, SessionState } from "./types.js";

/** Контекст исполнения команды: черновик состояния и собранные события. */
export class Ctx {
  events: GameEvent[] = [];
  /** Глубина цепочки правил (ТЗ 6.3: до 8 шагов). */
  ruleDepth = 0;
  constructor(
    public s: SessionState,
    public rng: Rng,
  ) {}

  emit(body: EventBody): GameEvent {
    const ev = { ...body, seq: this.s.seq + 1 } as GameEvent;
    const draws = this.rng.takeDraws();
    if (draws.length) ev.draws = draws;
    reduceInPlace(this.s, ev);
    this.events.push(ev);
    return ev;
  }

  get ended(): boolean {
    return this.s.phase === "ended";
  }
}

export const fail = (code: string, message?: string): CommandError => ({ code, message });
