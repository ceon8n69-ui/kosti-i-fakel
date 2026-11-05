import type { CommandBody, GameEvent, VisibleState } from "@kf/engine";
import { authToken } from "./api";

export interface Batch {
  kind: "sync" | "events";
  events: GameEvent[];
  state: VisibleState;
  seq: number;
}

interface Ack {
  ok: boolean;
  commandId: string;
  error?: string;
  seq?: number;
  events?: GameEvent[];
  state?: VisibleState;
}

const uuid = (): string =>
  crypto.randomUUID?.() ??
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });

/**
 * Связь с партией. Клиент ничего не считает: он отправляет команды и показывает то,
 * что прислал сервер. При обрыве переподключается и забирает пропущенное по seq.
 */
export class GameClient {
  seq = 0;
  seedHash = "";
  seed: string | null = null;
  online = false;
  private ws: WebSocket | null = null;
  private pending = new Map<string, (a: Ack) => void>();
  private retry = 0;
  private closed = false;
  private pingTimer = 0;
  private listeners = new Set<(b: Batch) => void>();
  private statusListeners = new Set<(online: boolean) => void>();

  constructor(readonly sessionId: string) {}

  onBatch(cb: (b: Batch) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  onStatus(cb: (online: boolean) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  private setOnline(v: boolean): void {
    this.online = v;
    for (const l of this.statusListeners) l(v);
  }

  /** Первая загрузка через REST: работает, даже если WebSocket недоступен. */
  async load(): Promise<void> {
    const r = await fetch(`/sessions/${this.sessionId}/state?sinceSeq=0`, { headers: { authorization: `Bearer ${authToken()}` } });
    if (!r.ok) throw new Error(`state ${r.status}`);
    const v = await r.json();
    this.accept({ kind: "sync", events: v.events, state: v.state, seq: v.seq }, v);
  }

  connect(): void {
    if (this.closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: "auth", token: authToken() }));
    ws.onmessage = (m) => this.onMessage(JSON.parse(m.data as string));
    ws.onclose = () => {
      this.setOnline(false);
      clearInterval(this.pingTimer);
      if (this.closed) return;
      const delay = Math.min(10000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.pingTimer);
    this.ws?.close();
  }

  private onMessage(msg: Record<string, unknown>): void {
    switch (msg.t) {
      case "authed":
        this.retry = 0;
        this.ws?.send(JSON.stringify({ t: "sub", sessionId: this.sessionId, sinceSeq: this.seq }));
        this.pingTimer = window.setInterval(() => this.ws?.send(JSON.stringify({ t: "ping" })), 25000);
        break;
      case "sync":
        this.setOnline(true);
        this.accept({ kind: "sync", events: msg.events as GameEvent[], state: msg.state as VisibleState, seq: msg.seq as number }, msg);
        break;
      case "events":
        this.accept({ kind: "events", events: msg.events as GameEvent[], state: msg.state as VisibleState, seq: msg.seq as number });
        break;
      case "ack": {
        const a = msg as unknown as Ack;
        this.pending.get(a.commandId)?.(a);
        this.pending.delete(a.commandId);
        break;
      }
    }
  }

  private accept(b: Batch, meta?: { seedHash?: unknown; seed?: unknown }): void {
    if (meta?.seedHash) this.seedHash = meta.seedHash as string;
    if (meta && "seed" in meta) this.seed = (meta.seed as string | null) ?? null;
    if (b.seq <= this.seq && b.kind === "events") return; // уже видели (ack + рассылка)
    const first = b.events[0]?.seq;
    if (b.kind === "events" && first !== undefined && first > this.seq + 1) {
      void this.resync(); // дыра в последовательности — догружаем
      return;
    }
    if (b.kind === "sync" && b.seq <= this.seq && this.seq > 0) return;
    const fresh = b.events.filter((e) => e.seq > this.seq);
    this.seq = b.seq;
    for (const l of this.listeners) l({ ...b, events: fresh });
  }

  async resync(): Promise<void> {
    const r = await fetch(`/sessions/${this.sessionId}/state?sinceSeq=${this.seq}`, { headers: { authorization: `Bearer ${authToken()}` } });
    if (!r.ok) return;
    const v = await r.json();
    this.accept({ kind: "events", events: v.events, state: v.state, seq: v.seq }, v);
  }

  /** Полный журнал и (после конца) зерно — для проверки бросков. */
  async journal(): Promise<{ events: GameEvent[]; seed: string | null; seedHash: string }> {
    const r = await fetch(`/sessions/${this.sessionId}/state?sinceSeq=0`, { headers: { authorization: `Bearer ${authToken()}` } });
    const v = await r.json();
    return { events: v.events, seed: v.seed, seedHash: v.seedHash };
  }

  async send(body: CommandBody): Promise<Ack> {
    const command = { ...body, commandId: uuid(), expectedSeq: this.seq };
    let ack: Ack;
    if (this.ws?.readyState === WebSocket.OPEN && this.online) {
      ack = await new Promise<Ack>((resolve) => {
        this.pending.set(command.commandId, resolve);
        this.ws!.send(JSON.stringify({ t: "cmd", sessionId: this.sessionId, command }));
        setTimeout(() => {
          if (this.pending.delete(command.commandId)) resolve({ ok: false, commandId: command.commandId, error: "timeout" });
        }, 8000);
      });
    } else {
      const r = await fetch(`/sessions/${this.sessionId}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${authToken()}` },
        body: JSON.stringify(command),
      });
      ack = (await r.json()) as Ack;
    }
    if (ack.ok && ack.state && ack.events) this.accept({ kind: "events", events: ack.events, state: ack.state, seq: ack.seq! });
    if (!ack.ok && (ack.error === "stale_seq" || ack.error === "timeout")) await this.resync();
    return ack;
  }
}
