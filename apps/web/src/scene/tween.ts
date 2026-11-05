/** Минимальные твины: время идёт через общий множитель скорости (пропуск, замедление крита). */
export type Ease = (t: number) => number;
export const ease = {
  linear: (t: number) => t,
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  outBack: (t: number) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
  outBounce: (t: number) => {
    const n = 7.5625;
    const d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
};

interface Job {
  dur: number;
  t: number;
  step: (k: number) => void;
  ease: Ease;
  done: () => void;
}

export class Tweens {
  private jobs = new Set<Job>();
  /** Множитель скорости: 1 — норма, 4 — пропуск. */
  speed = 1;

  run(durMs: number, step: (k: number) => void, e: Ease = ease.outCubic): Promise<void> {
    return new Promise((resolve) => {
      if (durMs <= 0) {
        step(1);
        resolve();
        return;
      }
      this.jobs.add({ dur: durMs, t: 0, step, ease: e, done: resolve });
    });
  }

  wait(ms: number): Promise<void> {
    return this.run(ms, () => {});
  }

  tick(dtMs: number): void {
    for (const j of this.jobs) {
      j.t += dtMs * this.speed;
      const k = Math.min(1, j.t / j.dur);
      j.step(j.ease(k));
      if (k >= 1) {
        this.jobs.delete(j);
        j.done();
      }
    }
  }

  /** Немедленно завершить всё (переход в фон, снижение анимации). */
  flush(): void {
    for (const j of this.jobs) {
      j.step(1);
      j.done();
    }
    this.jobs.clear();
  }

  get busy(): boolean {
    return this.jobs.size > 0;
  }
}
