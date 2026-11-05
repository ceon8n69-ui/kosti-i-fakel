import { project, projectEvent, type GameEvent, type SessionState } from "@kf/engine";

export interface HubClient {
  userId: string;
  send(msg: unknown): void;
}

/** Подписчики партий в этом процессе. Каждому уходит его собственная проекция. */
export class Hub {
  private subs = new Map<string, Set<HubClient>>();

  subscribe(sessionId: string, c: HubClient): void {
    let set = this.subs.get(sessionId);
    if (!set) this.subs.set(sessionId, (set = new Set()));
    set.add(c);
  }

  unsubscribe(sessionId: string, c: HubClient): void {
    const set = this.subs.get(sessionId);
    set?.delete(c);
    if (set && !set.size) this.subs.delete(sessionId);
  }

  dropClient(c: HubClient): void {
    for (const [id, set] of this.subs) {
      set.delete(c);
      if (!set.size) this.subs.delete(id);
    }
  }

  publish(sessionId: string, seq: number, events: GameEvent[], state: SessionState): void {
    for (const c of this.subs.get(sessionId) ?? []) {
      const own = events.map((e) => projectEvent(e, c.userId)).filter((e): e is GameEvent => e !== null);
      c.send({ t: "events", sessionId, seq, events: own, state: project(state, c.userId) });
    }
  }
}
