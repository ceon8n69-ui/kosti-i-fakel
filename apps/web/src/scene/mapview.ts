import type { VisibleObject, VisibleState } from "@kf/engine";
import * as THREE from "three";
import { ease, type Tweens } from "./tween";

/**
 * Карта подземелья на столе: модульные плитки, стены, объекты, отряд и замеченные враги.
 * Клиент знает только открытые клетки — их и рисует.
 */
export const CELL = 1;
/** Невысокие стены: в изометрии ближние стены не закрывают клетки за собой. */
const WALL_H = 0.42;

export interface MapHooks {
  makeMini(kind: string, side: "hero" | "monster", small?: boolean): THREE.Group & { userData: { height: number } };
  canvasTex(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): THREE.CanvasTexture;
  burst(at: THREE.Vector3, color: string, n: number): void;
  onImpact(s: number): void;
}

export class MapView {
  readonly group = new THREE.Group();
  private tiles = new Map<string, THREE.Object3D>();
  private objects = new Map<string, THREE.Group>();
  private party: THREE.Group[] = [];
  private partyKinds: string[] = [];
  private foes = new Map<string, THREE.Group>();
  private mats: Record<string, THREE.Material>;
  private geo = { floor: new THREE.BoxGeometry(CELL, 0.12, CELL), wall: new THREE.BoxGeometry(CELL, WALL_H, CELL) };
  readonly torch = new THREE.PointLight("#ffa04a", 26, 7, 1.4);
  pos = { x: 0, y: 0 };
  private marker: THREE.Mesh;

  constructor(
    private tw: Tweens,
    private hooks: MapHooks,
  ) {
    const stone = hooks.canvasTex(128, 128, (c) => {
      c.fillStyle = "#3d3832";
      c.fillRect(0, 0, 128, 128);
      const g = 58 + Math.random() * 12;
      c.fillStyle = `rgb(${g},${g - 4},${g - 9})`;
      c.fillRect(3, 3, 122, 122);
      c.fillStyle = "rgba(0,0,0,.14)";
      for (let k = 0; k < 7; k++) c.fillRect(Math.random() * 110, Math.random() * 110, 16, 3);
    });
    const brick = hooks.canvasTex(128, 128, (c) => {
      c.fillStyle = "#2a241f";
      c.fillRect(0, 0, 128, 128);
      for (let r = 0; r < 4; r++)
        for (let k = 0; k < 3; k++) {
          const g = 50 + Math.random() * 16;
          c.fillStyle = `rgb(${g},${g - 5},${g - 10})`;
          c.fillRect(k * 44 + (r % 2) * 22 - 10, r * 32 + 2, 40, 28);
        }
    });
    this.mats = {
      floor: new THREE.MeshStandardMaterial({ map: stone, roughness: 0.95 }),
      wall: new THREE.MeshStandardMaterial({ map: brick, roughness: 0.9 }),
      water: new THREE.MeshStandardMaterial({ color: "#1d4a5c", roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.85 }),
      wood: new THREE.MeshStandardMaterial({ color: "#6b4426", roughness: 0.8 }),
      iron: new THREE.MeshStandardMaterial({ color: "#4a4a50", roughness: 0.5, metalness: 0.6 }),
      gold: new THREE.MeshStandardMaterial({ color: "#d9a93c", roughness: 0.3, metalness: 0.8, emissive: "#3a2600" }),
      paper: new THREE.MeshStandardMaterial({ color: "#e8dcc0", roughness: 1 }),
      trap: new THREE.MeshBasicMaterial({ color: "#c0392b", transparent: true, opacity: 0.75 }),
      stoneLight: new THREE.MeshStandardMaterial({ color: "#7a7268", roughness: 0.9 }),
    };
    this.group.add(this.torch);
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.38, 24), new THREE.MeshBasicMaterial({ color: "#f0a040", transparent: true, opacity: 0 }));
    this.marker.rotation.x = -Math.PI / 2;
    this.group.add(this.marker);
  }

  /** Центр клетки в мире (карта лежит на столе в осях x/z). */
  cellPos(x: number, y: number, h = 0): THREE.Vector3 {
    return new THREE.Vector3(x * CELL, h, y * CELL);
  }

  /** Полная перерисовка по видимому состоянию (вход, переподключение, конец очереди). */
  sync(s: VisibleState): void {
    for (let y = 0; y < s.map.h; y++) for (let x = 0; x < s.map.w; x++) this.setTile(x, y, s.map.tiles[y]![x]!, false);
    const live = new Set(s.objects.map((o) => o.id));
    for (const [id, g] of this.objects)
      if (!live.has(id)) {
        this.group.remove(g);
        this.objects.delete(id);
      }
    for (const o of s.objects) this.setObject(o, false);
    const foeIds = new Set(s.encounters.map((e) => e.id));
    for (const [id, g] of this.foes)
      if (!foeIds.has(id)) {
        this.group.remove(g);
        this.foes.delete(id);
      }
    for (const e of s.encounters) if (!this.foes.has(e.id)) this.addFoes(e.id, e.kinds, e.x, e.y, false);
    this.setParty(s.heroes.filter((h) => h.status !== "dead").map((h) => h.classId), s.pos.x, s.pos.y);
  }

  setTile(x: number, y: number, ch: string, animate: boolean): void {
    const k = `${x},${y}`;
    const prev = this.tiles.get(k);
    if (prev?.userData.ch === ch) return;
    if (prev) this.group.remove(prev);
    if (ch === " " || ch === "_") {
      this.tiles.delete(k);
      return;
    }
    let m: THREE.Mesh;
    if (ch === "#") {
      m = new THREE.Mesh(this.geo.wall, this.mats.wall!);
      m.position.copy(this.cellPos(x, y, WALL_H / 2));
      m.castShadow = true;
    } else {
      m = new THREE.Mesh(this.geo.floor, ch === "~" ? this.mats.water! : this.mats.floor!);
      m.position.copy(this.cellPos(x, y, 0.06));
    }
    m.receiveShadow = true;
    m.userData = { ch, cell: [x, y] };
    this.group.add(m);
    this.tiles.set(k, m);
    if (animate) {
      const target = m.scale.y;
      m.scale.y = 0.01;
      void this.tw.run(260 + Math.random() * 160, (t) => (m.scale.y = 0.01 + (target - 0.01) * t), ease.outBack);
    }
  }

  private doorAxis(o: VisibleObject): "x" | "z" {
    const wall = (x: number, y: number) => this.tiles.get(`${x},${y}`)?.userData.ch === "#";
    return wall(o.x - 1, o.y) || wall(o.x + 1, o.y) ? "x" : "z";
  }

  setObject(o: VisibleObject, animate: boolean): void {
    let g = this.objects.get(o.id);
    const fresh = !g;
    if (!g) {
      g = this.buildObject(o);
      g.position.copy(this.cellPos(o.x, o.y, 0.12));
      g.traverse((c) => (c.userData.objectId = o.id));
      this.group.add(g);
      this.objects.set(o.id, g);
      if (animate) {
        g.position.y = 2;
        void this.tw.run(360, (t) => (g!.position.y = 2 - 1.88 * t), ease.outBounce);
      }
    }
    g.userData.obj = o;
    this.applyState(g, o, animate && !fresh);
  }

  private buildObject(o: VisibleObject): THREE.Group {
    const g = new THREE.Group();
    const M = this.mats;
    const box = (w: number, h: number, d: number, mat: THREE.Material, y = h / 2) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.y = y;
      m.castShadow = true;
      g.add(m);
      return m;
    };
    switch (o.type) {
      case "door": {
        const leaf = box(0.9, 0.75, 0.1, o.locked ? M.iron! : M.wood!);
        leaf.name = "leaf";
        if (this.doorAxis(o) === "z") g.rotation.y = Math.PI / 2;
        break;
      }
      case "chest": {
        box(0.5, 0.26, 0.34, M.wood!);
        const lid = box(0.52, 0.08, 0.36, M.iron!, 0.3);
        lid.name = "lid";
        break;
      }
      case "treasury": {
        box(0.62, 0.32, 0.42, M.gold!);
        const lid = box(0.64, 0.1, 0.44, M.gold!, 0.37);
        lid.name = "lid";
        const glow = new THREE.PointLight("#ffcc55", 4, 2.5);
        glow.position.y = 0.8;
        g.add(glow);
        break;
      }
      case "entrance":
        for (let i = 0; i < 3; i++) box(0.8 - i * 0.2, 0.1, 0.8 - i * 0.2, M.stoneLight!, 0.05 + i * 0.1);
        break;
      case "note": {
        const p = box(0.32, 0.02, 0.24, M.paper!, 0.01);
        p.rotation.y = 0.4;
        break;
      }
      case "key": {
        const k = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.025, 8, 16), M.gold!);
        k.position.y = 0.15;
        g.add(k);
        const shaft = box(0.22, 0.03, 0.03, M.gold!, 0.15);
        shaft.position.x = 0.15;
        g.name = "spin";
        break;
      }
      case "lever": {
        box(0.2, 0.1, 0.2, M.iron!);
        const stick = box(0.05, 0.45, 0.05, M.wood!, 0.3);
        stick.name = "stick";
        stick.rotation.z = 0.5;
        break;
      }
      case "plate":
        box(0.7, 0.03, 0.7, M.stoneLight!, 0.015);
        break;
      case "altar": {
        box(0.5, 0.45, 0.5, M.stoneLight!);
        const water = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.02, 20), M.water!);
        water.position.y = 0.46;
        g.add(water);
        break;
      }
      case "campfire": {
        for (let i = 0; i < 3; i++) {
          const log = box(0.5, 0.07, 0.07, M.wood!, 0.05);
          log.rotation.y = (i * Math.PI) / 3;
        }
        const fire = new THREE.PointLight("#ff8a2a", 6, 3);
        fire.position.y = 0.4;
        fire.name = "fire";
        g.add(fire);
        const flame = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 8), new THREE.MeshBasicMaterial({ color: "#ffb347" }));
        flame.position.y = 0.2;
        flame.name = "flame";
        g.add(flame);
        break;
      }
      case "light": {
        box(0.08, 0.6, 0.08, M.iron!);
        const lamp = new THREE.PointLight("#ffd27a", 5, 4);
        lamp.position.y = 0.7;
        g.add(lamp);
        break;
      }
      case "trap": {
        const p = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8), M.trap!);
        p.rotation.x = -Math.PI / 2;
        p.position.y = 0.02;
        g.add(p);
        for (let i = 0; i < 4; i++) {
          const spike = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.18, 6), M.iron!);
          spike.position.set(((i % 2) - 0.5) * 0.35, 0.09, (Math.floor(i / 2) - 0.5) * 0.35);
          g.add(spike);
        }
        break;
      }
      case "npc": {
        const mini = this.hooks.makeMini("ghost", "hero");
        mini.traverse((c) => {
          const m = (c as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
          if (m && "opacity" in m) {
            m.transparent = true;
            m.opacity = 0.7;
          }
        });
        g.add(mini);
        break;
      }
    }
    return g;
  }

  private applyState(g: THREE.Group, o: VisibleObject, animate: boolean): void {
    const run = (fn: (t: number) => void) => (animate ? void this.tw.run(420, fn, ease.outBack) : fn(1));
    if (o.type === "door") {
      const leaf = g.getObjectByName("leaf");
      if (leaf) {
        const from = leaf.rotation.y;
        const to = o.open ? -Math.PI / 2 : 0;
        const fx = leaf.position.x;
        const tx = o.open ? -0.42 : 0;
        run((t) => {
          leaf.rotation.y = from + (to - from) * t;
          leaf.position.x = fx + (tx - fx) * t;
          leaf.position.z = o.open ? 0.42 * t : 0;
        });
      }
    }
    if ((o.type === "chest" || o.type === "treasury") && (o.used || o.open)) {
      const lid = g.getObjectByName("lid");
      if (lid) run((t) => (lid.rotation.x = -1.2 * t));
    }
    if (o.type === "lever" && o.used) {
      const st = g.getObjectByName("stick");
      if (st) run((t) => (st.rotation.z = 0.5 - 1 * t));
    }
    if (o.type === "campfire" && o.used) {
      const f = g.getObjectByName("fire") as THREE.PointLight | undefined;
      if (f) f.intensity = 1.5;
      const fl = g.getObjectByName("flame");
      if (fl) fl.scale.setScalar(0.5);
    }
    if (o.type === "trap" && (o.state === "disarmed" || o.state === "triggered")) g.traverse((c) => c instanceof THREE.Mesh && (c.material = this.mats.stoneLight!));
  }

  removeObject(id: string): void {
    const g = this.objects.get(id);
    if (!g) return;
    this.objects.delete(id);
    void this.tw.run(300, (t) => g.scale.setScalar(1 - t)).then(() => this.group.remove(g));
  }

  private partyOffset(i: number, n: number): THREE.Vector3 {
    if (n === 1) return new THREE.Vector3();
    const a = (i / n) * Math.PI * 2 + Math.PI / 4;
    return new THREE.Vector3(Math.cos(a) * 0.22, 0, Math.sin(a) * 0.22);
  }

  setParty(kinds: string[], x: number, y: number): void {
    if (kinds.join() !== this.partyKinds.join()) {
      for (const m of this.party) this.group.remove(m);
      this.party = kinds.map((k) => {
        const m = this.hooks.makeMini(k, "hero");
        m.scale.setScalar(kinds.length > 1 ? 0.62 : 0.8);
        this.group.add(m);
        return m;
      });
      this.partyKinds = kinds;
    }
    this.pos = { x, y };
    this.party.forEach((m, i) => m.position.copy(this.cellPos(x, y, 0.12)).add(this.partyOffset(i, this.party.length)));
    this.torch.position.copy(this.cellPos(x, y, 1.6));
  }

  /** Прыжки отряда по клеткам пути. */
  async walk(path: [number, number][], onStep?: (x: number, y: number) => void): Promise<void> {
    for (const [x, y] of path) {
      const from = this.party.map((m) => m.position.clone());
      const to = this.party.map((_, i) => this.cellPos(x, y, 0.12).add(this.partyOffset(i, this.party.length)));
      const tFrom = this.torch.position.clone();
      const tTo = this.cellPos(x, y, 1.6);
      await this.tw.run(170, (t) => {
        this.party.forEach((m, i) => {
          m.position.lerpVectors(from[i]!, to[i]!, t);
          m.position.y = 0.12 + Math.sin(t * Math.PI) * 0.18;
        });
        this.torch.position.lerpVectors(tFrom, tTo, t);
      }, ease.linear);
      this.pos = { x, y };
      onStep?.(x, y);
    }
  }

  addFoes(id: string, kinds: string[], x: number, y: number, animate: boolean): void {
    const g = new THREE.Group();
    kinds.forEach((k, i) => {
      const m = this.hooks.makeMini(k, "monster");
      m.scale.setScalar(0.62);
      m.position.set((i - (kinds.length - 1) / 2) * 0.42, 0, (i % 2) * 0.2);
      g.add(m);
    });
    g.position.copy(this.cellPos(x, y, 0.12));
    this.group.add(g);
    this.foes.set(id, g);
    if (animate) {
      g.position.y = 2.5;
      void this.tw.run(420, (t) => (g.position.y = 2.5 - 2.38 * t), ease.outBounce).then(() => this.hooks.onImpact(0.6));
    }
  }

  removeFoes(id: string): void {
    const g = this.foes.get(id);
    if (g) this.group.remove(g);
    this.foes.delete(id);
  }

  async flashCell(x: number, y: number, color: string): Promise<void> {
    const p = this.cellPos(x, y, 0.3);
    this.hooks.burst(p, color, 18);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.45, 24), new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(p).setY(0.15);
    this.group.add(ring);
    await this.tw.run(420, (t) => {
      ring.scale.setScalar(0.5 + t * 1.5);
      (ring.material as THREE.MeshBasicMaterial).opacity = 1 - t;
    });
    this.group.remove(ring);
  }

  showMarker(x: number, y: number): void {
    this.marker.position.copy(this.cellPos(x, y, 0.14));
    const mat = this.marker.material as THREE.MeshBasicMaterial;
    void this.tw.run(600, (t) => (mat.opacity = 1 - t));
  }

  /** Что под пальцем: объект или клетка пола. */
  pick(ray: THREE.Raycaster): { objectId?: string; cell?: [number, number] } {
    const hits = ray.intersectObjects(this.group.children, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o && !o.userData.objectId && !o.userData.cell) o = o.parent;
      if (!o) continue;
      if (o.userData.objectId) return { objectId: o.userData.objectId as string };
      if (o.userData.cell && o.userData.ch !== "#") return { cell: o.userData.cell as [number, number] };
    }
    return {};
  }

  tick(now: number): void {
    for (const g of this.objects.values()) {
      if (g.userData.obj?.type === "key") g.rotation.y = now / 600;
      const fire = g.getObjectByName("fire") as THREE.PointLight | undefined;
      if (fire && !g.userData.obj?.used) fire.intensity = 5 + Math.sin(now / 70) * 0.8 + Math.random() * 0.6;
    }
  }
}
