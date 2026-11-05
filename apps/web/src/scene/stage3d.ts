import type { Face } from "@kf/schema";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import manifest from "../assets/manifest.json";
import trajectories from "../dice/trajectories.json";
import { drawFace } from "./glyphs";
import { ease, Tweens } from "./tween";

export interface UnitVis {
  id: string;
  kind: string;
  side: "hero" | "monster";
  row: "front" | "back";
  boss?: boolean;
  small?: boolean;
  status: "up" | "downed" | "gone";
}

export interface DieRollSpec {
  /** Номер кубика героя (0..2) — он же дорожка в записанной траектории. */
  die: number;
  faces: Face[];
  result: number;
}

export interface StageHooks {
  onFrame?: () => void;
  onImpact?: (strength: number) => void;
}

type Traj = number[][];
const T = trajectories as unknown as { fps: number; d6: Traj[]; d20: Traj[]; d6Half: number; d20Radius: number };

// Плоскость стола: u — вправо по экрану, v — от игрока вглубь. Камера изометрическая (yaw 45°).
const U = new THREE.Vector3(1, 0, -1).normalize();
const V = new THREE.Vector3(-1, 0, -1).normalize();
const at = (col: number, depth: number, y = 0) => new THREE.Vector3().addScaledVector(U, col).addScaledVector(V, depth).setY(y);

const DEPTH = { monster: { front: 2.25, back: 3.35 }, hero: { front: 0.45, back: -0.55 } } as const;
const EXPLORE_SHIFT = -0.9;
const TRAY_DEPTH = -2.55;
/** Лоток уменьшен относительно записи траекторий — кубики и броски масштабируются вместе с ним. */
const TRAY_SCALE = 0.78;

const INK: Record<string, string> = {
  M: "#3a2a1a",
  L: "#3d5a12",
  I: "#5a2fb0",
  B: "#1f4f9e",
  H: "#1d7a3c",
  STAR: "#a46f00",
  SKULL: "#3a3a3a",
};

interface Mini {
  vis: UnitVis;
  root: THREE.Group; // позиция на столе
  pivot: THREE.Group; // наклоны/падение
  sprite: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  shadow: THREE.Mesh;
  height: number;
}

interface DieObj {
  mesh: THREE.Mesh;
  labels: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[];
  normals: THREE.Vector3[];
}

export class Stage3D {
  readonly tw = new Tweens();
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private minis = new Map<string, Mini>();
  private dice: DieObj[] = [];
  private d20: DieObj | null = null;
  private trayRoot = new THREE.Group();
  private raf = 0;
  private last = performance.now();
  private disposed = false;
  private baseZoom = 1;
  private shakeAmp = 0;
  private camTarget = new THREE.Vector3();
  private torch: THREE.PointLight;
  private fpsSamples: number[] = [];
  private lowQuality = false;
  private faceTexCache = new Map<string, THREE.CanvasTexture>();
  private particles: { pts: THREE.Points; vel: Float32Array; life: number }[] = [];
  /** Множитель от пропуска (1 или 4) и замедление крита (0.35). */
  private skipSpeed = 1;
  private critSlow = 1;
  exploring = true;

  constructor(
    private host: HTMLElement,
    private hooks: StageHooks = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";

    this.camera = new THREE.OrthographicCamera(-3, 3, 4, -4, 0.1, 100);
    this.scene.background = new THREE.Color("#120c08");

    this.scene.add(new THREE.HemisphereLight("#ffe2b8", "#2a1a10", 0.9));
    const sun = new THREE.DirectionalLight("#fff1dc", 1.4);
    sun.position.set(-3, 9, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -6;
    sc.right = 6;
    sc.top = 6;
    sc.bottom = -6;
    sun.target.position.copy(at(0, -1));
    this.scene.add(sun, sun.target);
    this.torch = new THREE.PointLight("#ff9a3c", 18, 9, 1.6);
    this.torch.position.copy(at(0, 0.2, 2.6));
    this.scene.add(this.torch);

    this.buildTable();
    this.buildTray();
    this.resize();
    window.addEventListener("resize", this.resize);
    this.loop();
  }

  // ───────── Окружение ─────────

  private canvasTex(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void, repeat = 1): THREE.CanvasTexture {
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    draw(cv.getContext("2d")!);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    if (repeat !== 1) {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(repeat, repeat);
    }
    return tex;
  }

  private buildTable(): void {
    const wood = this.canvasTex(512, 512, (c) => {
      c.fillStyle = "#4a2e1a";
      c.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 8; i++) {
        c.fillStyle = i % 2 ? "#563620" : "#4f311c";
        c.fillRect(0, i * 64, 512, 62);
        c.fillStyle = "#2b190d";
        c.fillRect(0, i * 64 + 62, 512, 2);
        for (let k = 0; k < 30; k++) {
          c.strokeStyle = `rgba(30,15,5,${0.08 + Math.random() * 0.1})`;
          c.beginPath();
          const y = i * 64 + Math.random() * 62;
          c.moveTo(0, y);
          c.bezierCurveTo(170, y + 6 - Math.random() * 12, 340, y + 6 - Math.random() * 12, 512, y);
          c.stroke();
        }
      }
    }, 4);
    const table = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ map: wood, roughness: 0.85 }));
    table.rotation.x = -Math.PI / 2;
    table.receiveShadow = true;
    this.scene.add(table);

    // Плитки подземелья — модульные квадраты, стоящие на столе.
    const stone = this.canvasTex(256, 256, (c) => {
      c.fillStyle = "#3b3631";
      c.fillRect(0, 0, 256, 256);
      for (let x = 0; x < 2; x++)
        for (let y = 0; y < 2; y++) {
          const g = 60 + Math.random() * 14;
          c.fillStyle = `rgb(${g},${g - 4},${g - 9})`;
          c.fillRect(x * 128 + 3, y * 128 + 3, 122, 122);
          c.fillStyle = "rgba(0,0,0,0.12)";
          for (let k = 0; k < 6; k++) c.fillRect(x * 128 + Math.random() * 110, y * 128 + Math.random() * 110, 14, 3);
        }
    });
    const tileMat = new THREE.MeshStandardMaterial({ map: stone, roughness: 0.95 });
    const tileGeo = new THREE.BoxGeometry(1, 0.12, 1);
    const cols = [-2, -1, 0, 1, 2];
    for (let d = -1; d <= 4; d++)
      for (const c of cols) {
        if (Math.abs(c) === 2 && (d === -1 || d === 4)) continue;
        const t = new THREE.Mesh(tileGeo, tileMat);
        t.position.copy(at(c, d + 0.05, 0.06));
        t.rotation.y = Math.PI / 4;
        t.receiveShadow = true;
        this.scene.add(t);
      }
  }

  private buildTray(): void {
    const felt = this.canvasTex(256, 256, (c) => {
      c.fillStyle = "#1e3a2c";
      c.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 1500; i++) {
        c.fillStyle = `rgba(255,255,255,${Math.random() * 0.04})`;
        c.fillRect(Math.random() * 256, Math.random() * 256, 1, 1);
      }
    }, 2);
    const { w, d } = { w: 4.8, d: 3.0 };
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ map: felt, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.01;
    floor.receiveShadow = true;
    this.trayRoot.add(floor);
    const rimMat = new THREE.MeshStandardMaterial({ color: "#2f1b0e", roughness: 0.7 });
    const rim = (sx: number, sz: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.22, sz), rimMat);
      m.position.set(x, 0.11, z);
      m.castShadow = m.receiveShadow = true;
      this.trayRoot.add(m);
    };
    rim(w + 0.3, 0.15, 0, -d / 2 - 0.075);
    rim(w + 0.3, 0.15, 0, d / 2 + 0.075);
    rim(0.15, d, -w / 2 - 0.075, 0);
    rim(0.15, d, w / 2 + 0.075, 0);
    // Локальные оси лотка: x → U, z → к игроку (−V).
    this.trayRoot.position.copy(at(0, TRAY_DEPTH));
    this.trayRoot.rotation.y = Math.PI / 4;
    this.trayRoot.scale.setScalar(TRAY_SCALE);
    this.scene.add(this.trayRoot);
  }

  private resize = (): void => {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    const aspect = w / h;
    // Ширина стола помещается всегда, высота подстраивается под экран.
    let halfW = 2.25;
    let halfH = halfW / aspect;
    if (halfH < 2.75) {
      halfH = 2.75;
      halfW = halfH * aspect;
    }
    Object.assign(this.camera, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
    const elev = Math.atan(1 / Math.SQRT2); // классическая изометрия ≈35.26°
    const dir = new THREE.Vector3(Math.cos(elev) * Math.SQRT1_2, Math.sin(elev), Math.cos(elev) * Math.SQRT1_2);
    this.camTarget.copy(at(0, 0.45, 0));
    this.camera.position.copy(this.camTarget).addScaledVector(dir, 30);
    this.camera.lookAt(this.camTarget);
    this.camera.updateProjectionMatrix();
  };

  // ───────── Цикл ─────────

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(100, now - this.last);
    this.last = now;
    this.tw.speed = this.skipSpeed * this.critSlow;
    this.tw.tick(dt);
    this.torch.intensity = this.torchBase * (0.9 + Math.sin(now / 90) * 0.04 + Math.sin(now / 37) * 0.03 + Math.random() * 0.03);
    this.stepParticles(dt);
    if (this.shakeAmp > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.shakeAmp;
      this.camera.position.z += (Math.random() - 0.5) * this.shakeAmp;
      this.shakeAmp *= 0.86;
    }
    this.renderer.render(this.scene, this.camera);
    this.hooks.onFrame?.();
    this.watchFps(dt);
  };

  /** Автоматическое снижение качества, если долго держится меньше 30 кадров/с. */
  private watchFps(dt: number): void {
    if (this.lowQuality) return;
    this.fpsSamples.push(1000 / Math.max(1, dt));
    if (this.fpsSamples.length < 90) return;
    const avg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
    this.fpsSamples = [];
    if (avg < 30) {
      this.lowQuality = true;
      this.renderer.setPixelRatio(1);
      this.renderer.shadowMap.enabled = false;
      this.resize();
    }
  }

  setSkip(on: boolean): void {
    this.skipSpeed = on ? 4 : 1;
  }

  private torchBase = 18;
  /** Сила света факела следует за шкалой Факела. */
  setLight(light: number): void {
    this.torchBase = 6 + Math.min(40, light) * 0.4;
  }

  // ───────── Миниатюры ─────────

  /** Готовый арт из манифеста; пока файл грузится или если его нет — заглушка, нарисованная кодом. */
  private miniTexture(kind: string, height: number, mat?: THREE.MeshBasicMaterial): THREE.Texture {
    const entry = (manifest.miniatures as Record<string, { sprite: string | null; placeholder: { color: string; glyph: string } }>)[kind];
    const placeholder = this.placeholderTexture(kind, height);
    if (entry?.sprite && mat) {
      new THREE.TextureLoader().load(
        `${import.meta.env.BASE_URL}${entry.sprite}`,
        (t) => {
          t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = 4;
          mat.map = t;
          mat.needsUpdate = true;
        },
        undefined,
        () => {
          /* файла нет — остаётся заглушка */
        },
      );
    }
    return placeholder;
  }

  private placeholderTexture(kind: string, height: number): THREE.Texture {
    const entry = (manifest.miniatures as Record<string, { placeholder: { color: string; glyph: string } }>)[kind];
    const color = entry?.placeholder.color ?? "#999";
    const glyph = entry?.placeholder.glyph ?? "?";
    return this.canvasTex(128, Math.round(128 * height), (c) => {
      const H = c.canvas.height;
      // Раскрашенная фигурка: голова, плечи, плащ.
      const g = c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, shade(color, 30));
      g.addColorStop(1, shade(color, -40));
      c.fillStyle = g;
      c.strokeStyle = "#1a120c";
      c.lineWidth = 6;
      c.beginPath();
      c.arc(64, H * 0.2, 22, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      c.beginPath();
      c.moveTo(30, H * 0.36);
      c.quadraticCurveTo(64, H * 0.28, 98, H * 0.36);
      c.lineTo(112, H * 0.97);
      c.lineTo(16, H * 0.97);
      c.closePath();
      c.fill();
      c.stroke();
      c.fillStyle = "rgba(0,0,0,0.55)";
      c.font = "bold 30px Georgia, serif";
      c.textAlign = "center";
      c.fillText(glyph, 64, H * 0.66);
    });
  }

  private basePos(v: UnitVis, index: number, count: number): THREE.Vector3 {
    const spacing = v.side === "monster" ? 1.15 : 1.05;
    const col = (index - (count - 1) / 2) * spacing;
    let depth: number = DEPTH[v.side][v.row];
    if (v.side === "hero" && this.exploring) depth += EXPLORE_SHIFT;
    return at(col, depth, 0.12);
  }

  private createMini(v: UnitVis): Mini {
    const scale = v.boss ? 1.35 : v.small ? 0.7 : 1;
    // Пропорции совпадают с готовым артом 256×384.
    const height = (v.side === "hero" ? 1.15 : 1.05) * scale;
    const width = height / 1.5;
    const geo = new THREE.PlaneGeometry(width, height);
    geo.translate(0, height / 2 + 0.06, 0);
    const mat = new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.1 });
    mat.map = this.miniTexture(v.kind, height / width, mat);
    const sprite = new THREE.Mesh(geo, mat);
    const pivot = new THREE.Group();
    pivot.add(sprite);
    // Подставка с ободком цвета стороны.
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3 * scale, 0.33 * scale, 0.07, 24),
      new THREE.MeshStandardMaterial({ color: v.side === "hero" ? "#2e4a6b" : "#5a1f1f", roughness: 0.5 }),
    );
    base.position.y = 0.035;
    base.castShadow = true;
    pivot.add(base);
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.42 * scale, 24),
      new THREE.MeshBasicMaterial({ color: "#000", transparent: true, opacity: 0.35, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.005;
    const root = new THREE.Group();
    root.add(pivot, shadow);
    // Спрайт повёрнут к камере.
    sprite.rotation.y = Math.PI / 4;
    this.scene.add(root);
    return { vis: v, root, pivot, sprite, shadow, height: height + 0.1 };
  }

  /** Расставить юнитов без анимации (старт, переподключение, конец очереди). */
  setUnits(units: UnitVis[]): void {
    const live = new Set(units.filter((u) => u.status !== "gone").map((u) => u.id));
    for (const [id, m] of this.minis)
      if (!live.has(id)) {
        this.scene.remove(m.root);
        this.minis.delete(id);
      }
    const groups = new Map<string, UnitVis[]>();
    for (const u of units) {
      if (u.status === "gone") continue;
      const k = `${u.side}:${u.row}`;
      groups.set(k, [...(groups.get(k) ?? []), u]);
    }
    for (const list of groups.values())
      list.forEach((u, i) => {
        let m = this.minis.get(u.id);
        if (!m || m.vis.kind !== u.kind || !!m.vis.small !== !!u.small) {
          if (m) this.scene.remove(m.root);
          m = this.createMini(u);
          this.minis.set(u.id, m);
        }
        m.vis = u;
        m.root.position.copy(this.basePos(u, i, list.length));
        m.root.visible = true;
        m.sprite.material.opacity = 1;
        m.sprite.material.color.setRGB(1, 1, 1);
        m.pivot.rotation.set(0, 0, u.status === "downed" ? 1.35 : 0);
        m.pivot.position.set(0, 0, 0);
      });
  }

  private targetPositions(units: UnitVis[]): Map<string, THREE.Vector3> {
    const out = new Map<string, THREE.Vector3>();
    const groups = new Map<string, UnitVis[]>();
    for (const u of units) {
      if (u.status === "gone") continue;
      const k = `${u.side}:${u.row}`;
      groups.set(k, [...(groups.get(k) ?? []), u]);
    }
    for (const list of groups.values()) list.forEach((u, i) => out.set(u.id, this.basePos(u, i, list.length)));
    return out;
  }

  /** Плавно перестроиться (новые юниты, смена ряда, вход в бой). Прыжки между клетками. */
  async regroup(units: UnitVis[], hop = false): Promise<void> {
    const target = this.targetPositions(units);
    const jobs: Promise<void>[] = [];
    for (const [id, to] of target) {
      const m = this.minis.get(id);
      if (!m) continue;
      const from = m.root.position.clone();
      if (from.distanceTo(to) < 0.01) continue;
      const hops = hop ? Math.max(1, Math.round(from.distanceTo(to) / 0.45)) : 1;
      jobs.push(
        (async () => {
          for (let h = 0; h < hops; h++) {
            const a = from.clone().lerp(to, h / hops);
            const b = from.clone().lerp(to, (h + 1) / hops);
            await this.tw.run(hop ? 190 : 260, (k) => {
              m.root.position.lerpVectors(a, b, k);
              m.pivot.position.y = hop ? Math.sin(k * Math.PI) * 0.22 : 0;
            }, ease.linear);
            if (hop) await this.squash(m);
          }
        })(),
      );
    }
    await Promise.all(jobs);
  }

  private squash(m: Mini): Promise<void> {
    return this.tw.run(110, (k) => {
      const s = 1 - Math.sin(k * Math.PI) * 0.12;
      m.sprite.scale.set(1 + (1 - s), s, 1);
    }, ease.linear);
  }

  /** Появление: миниатюра опускается на стол сверху с ударом. */
  async spawn(units: UnitVis[], id: string): Promise<void> {
    this.setUnits(units);
    const m = this.minis.get(id);
    if (!m) return;
    m.pivot.position.y = 3;
    await this.tw.run(380, (k) => (m.pivot.position.y = 3 * (1 - k)), ease.outBounce);
    this.shakeAmp = Math.max(this.shakeAmp, 0.05);
    this.hooks.onImpact?.(0.5);
    await this.squash(m);
  }

  async lunge(srcId: string, dstId: string): Promise<void> {
    const a = this.minis.get(srcId);
    const b = this.minis.get(dstId);
    if (!a || !b) return;
    const from = a.root.position.clone();
    const to = from.clone().lerp(b.root.position, 0.55);
    await this.tw.run(140, (k) => a.root.position.lerpVectors(from, to, k), ease.inOutCubic);
    await this.tw.run(180, (k) => a.root.position.lerpVectors(to, from, k), ease.outCubic);
  }

  async shoot(srcId: string, dstId: string, color: string): Promise<void> {
    const a = this.minis.get(srcId);
    const b = this.minis.get(dstId);
    if (!a || !b) return;
    // Наклон стрелка и летящий снаряд.
    void this.tw.run(260, (k) => (a.pivot.rotation.x = -Math.sin(k * Math.PI) * 0.25));
    const bolt = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 10), new THREE.MeshBasicMaterial({ color }));
    const from = a.root.position.clone().setY(a.height * 0.6);
    const to = b.root.position.clone().setY(b.height * 0.5);
    this.scene.add(bolt);
    await this.tw.run(240, (k) => {
      bolt.position.lerpVectors(from, to, k);
      bolt.position.y += Math.sin(k * Math.PI) * 0.4;
    }, ease.linear);
    this.scene.remove(bolt);
    this.burst(to, color, 10);
  }

  /** Получение урона: тряска и белая вспышка. */
  async hurt(id: string): Promise<void> {
    const m = this.minis.get(id);
    if (!m) return;
    const base = m.root.position.clone();
    await this.tw.run(260, (k) => {
      const f = (1 - k) * 0.09;
      m.root.position.set(base.x + Math.sin(k * 40) * f, base.y, base.z + Math.cos(k * 33) * f);
      const w = 1 + 2.5 * (1 - k);
      m.sprite.material.color.setRGB(w, w, w);
    }, ease.linear);
    m.root.position.copy(base);
    m.sprite.material.color.setRGB(1, 1, 1);
  }

  async flash(id: string, color: string): Promise<void> {
    const m = this.minis.get(id);
    if (!m) return;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.25, 0.42, 32),
      new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.position.copy(m.root.position).setY(m.height * 0.55);
    ring.rotation.y = Math.PI / 4;
    this.scene.add(ring);
    await this.tw.run(320, (k) => {
      ring.scale.setScalar(0.6 + k * 0.9);
      (ring.material as THREE.MeshBasicMaterial).opacity = 1 - k;
      m.pivot.position.y = Math.sin(k * Math.PI) * 0.06; // отскок
    });
    this.scene.remove(ring);
  }

  /** Падение героя: наклон и остаётся на боку. */
  async down(id: string, isDown: boolean): Promise<void> {
    const m = this.minis.get(id);
    if (!m) return;
    const from = m.pivot.rotation.z;
    const to = isDown ? 1.35 : 0;
    await this.tw.run(420, (k) => (m.pivot.rotation.z = from + (to - from) * k), isDown ? ease.outBounce : ease.outBack);
  }

  /** Смерть монстра: падение, исчезновение и частицы. */
  async kill(id: string): Promise<void> {
    const m = this.minis.get(id);
    if (!m) return;
    this.burst(m.root.position.clone().setY(0.4), "#c9b79a", 26);
    await this.tw.run(420, (k) => {
      m.pivot.rotation.x = -k * 1.4;
      m.sprite.material.opacity = 1 - k;
    });
    m.root.visible = false;
  }

  private burst(at3: THREE.Vector3, color: string, n: number): void {
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos.set([at3.x, at3.y, at3.z], i * 3);
      vel.set([(Math.random() - 0.5) * 3, Math.random() * 3 + 1, (Math.random() - 0.5) * 3], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({ color, size: 0.07, transparent: true }));
    this.scene.add(pts);
    this.particles.push({ pts, vel, life: 1 });
  }

  private stepParticles(dt: number): void {
    const s = (dt / 1000) * this.tw.speed;
    for (const p of [...this.particles]) {
      p.life -= s * 1.4;
      const a = p.pts.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < a.count; i++) {
        p.vel[i * 3 + 1]! -= 9 * s;
        a.setXYZ(i, a.getX(i) + p.vel[i * 3]! * s, Math.max(0.02, a.getY(i) + p.vel[i * 3 + 1]! * s), a.getZ(i) + p.vel[i * 3 + 2]! * s);
      }
      a.needsUpdate = true;
      (p.pts.material as THREE.PointsMaterial).opacity = Math.max(0, p.life);
      if (p.life <= 0) {
        this.scene.remove(p.pts);
        p.pts.geometry.dispose();
        this.particles.splice(this.particles.indexOf(p), 1);
      }
    }
  }

  sideOf(id: string): "hero" | "monster" | null {
    return this.minis.get(id)?.vis.side ?? null;
  }

  /** Экранная точка над миниатюрой (CSS-пиксели) — для подписей, полос здоровья и чисел урона. */
  screenPos(id: string, where: "top" | "base" = "top"): { x: number; y: number } | null {
    const m = this.minis.get(id);
    if (!m || !m.root.visible) return null;
    const p = m.root.position.clone();
    p.y = where === "top" ? m.height + m.pivot.position.y : 0;
    if (where === "base") p.addScaledVector(V, -0.32);
    if (where === "top" && Math.abs(m.pivot.rotation.z) > 0.5) p.y = 0.45;
    p.project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: ((p.x + 1) / 2) * r.width, y: ((1 - p.y) / 2) * r.height };
  }

  // ───────── Кубики ─────────

  private faceTexture(face: Face): THREE.CanvasTexture {
    const key = JSON.stringify(face);
    let t = this.faceTexCache.get(key);
    if (!t) {
      t = this.canvasTex(128, 128, (c) => drawFace(c, face, 128, INK[face.t]!));
      this.faceTexCache.set(key, t);
    }
    return t;
  }

  private numberTexture(n: number): THREE.CanvasTexture {
    const key = `n${n}`;
    let t = this.faceTexCache.get(key);
    if (!t) {
      t = this.canvasTex(128, 128, (c) => {
        c.fillStyle = "#f3c969";
        c.font = `bold ${n >= 10 ? 62 : 74}px Georgia, serif`;
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText(String(n), 64, 70);
        if (n === 6 || n === 9) c.fillRect(44, 104, 40, 6);
      });
      this.faceTexCache.set(key, t);
    }
    return t;
  }

  private makeD6(): DieObj {
    const s = T.d6Half * 2;
    const mesh = new THREE.Mesh(
      new RoundedBoxGeometry(s, s, s, 3, 0.07),
      new THREE.MeshStandardMaterial({ color: "#efe4cc", roughness: 0.45 }),
    );
    mesh.castShadow = true;
    const normals = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((a) => new THREE.Vector3(...(a as [number, number, number])));
    const labels = normals.map((n) => {
      const l = new THREE.Mesh(new THREE.PlaneGeometry(s * 0.78, s * 0.78), new THREE.MeshBasicMaterial({ transparent: true }));
      l.position.copy(n).multiplyScalar(T.d6Half + 0.002);
      l.lookAt(n.clone().multiplyScalar(2));
      mesh.add(l);
      return l;
    });
    this.trayRoot.add(mesh);
    return { mesh, labels, normals };
  }

  private makeD20(): DieObj {
    const geo = new THREE.IcosahedronGeometry(T.d20Radius, 0);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: "#6e1c1c", roughness: 0.35, metalness: 0.1, flatShading: true }));
    mesh.castShadow = true;
    const p = geo.getAttribute("position");
    const normals: THREE.Vector3[] = [];
    const labels: DieObj["labels"] = [];
    for (let i = 0; i < p.count; i += 3) {
      const a = new THREE.Vector3().fromBufferAttribute(p, i);
      const b = new THREE.Vector3().fromBufferAttribute(p, i + 1);
      const c = new THREE.Vector3().fromBufferAttribute(p, i + 2);
      const n = new THREE.Vector3().subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b)).normalize();
      const center = a.clone().add(b).add(c).divideScalar(3);
      normals.push(n);
      const l = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), new THREE.MeshBasicMaterial({ transparent: true }));
      l.position.copy(center).addScaledVector(n, 0.003);
      // «Верх» цифры — к первой вершине грани.
      l.up.copy(a.clone().sub(center).normalize());
      l.lookAt(center.clone().add(n));
      mesh.add(l);
      labels.push(l);
    }
    this.trayRoot.add(mesh);
    return { mesh, labels, normals };
  }

  private upSlot(normals: THREE.Vector3[], q: THREE.Quaternion): number {
    let best = 0;
    let bestY = -2;
    normals.forEach((n, i) => {
      const y = n.clone().applyQuaternion(q).y;
      if (y > bestY) {
        bestY = y;
        best = i;
      }
    });
    return best;
  }

  private frameAt(traj: Traj, lane: number, f: number): { p: THREE.Vector3; q: THREE.Quaternion } {
    const i = Math.min(traj.length - 1, Math.floor(f));
    const j = Math.min(traj.length - 1, i + 1);
    const k = f - Math.floor(f);
    const a = traj[i]!.slice(lane * 7, lane * 7 + 7);
    const b = traj[j]!.slice(lane * 7, lane * 7 + 7);
    const p = new THREE.Vector3(a[0], a[1], a[2]).lerp(new THREE.Vector3(b[0], b[1], b[2]), k);
    const q = new THREE.Quaternion(a[3], a[4], a[5], a[6]).slerp(new THREE.Quaternion(b[3], b[4], b[5], b[6]), k);
    return { p, q };
  }

  /** Кадры удара о стол по траектории: для звука и вибрации. */
  private impacts(traj: Traj, lane: number, half: number): { frame: number; strength: number }[] {
    const out: { frame: number; strength: number }[] = [];
    for (let f = 2; f < traj.length; f++) {
      const y0 = traj[f - 2]![lane * 7 + 1]!;
      const y1 = traj[f - 1]![lane * 7 + 1]!;
      const y2 = traj[f]![lane * 7 + 1]!;
      const v1 = y1 - y0;
      const v2 = y2 - y1;
      if (v1 < -0.02 && v2 >= -0.005 && y1 < half + 0.25) out.push({ frame: f - 1, strength: Math.min(1, -v1 / 0.35) });
    }
    return out;
  }

  clearDice(): void {
    for (const d of this.dice) this.trayRoot.remove(d.mesh);
    this.dice = [];
    if (this.d20) this.trayRoot.remove(this.d20.mesh);
    this.d20 = null;
  }

  private async playTraj(traj: Traj, lanes: { lane: number; obj: DieObj }[], half: number, crit: boolean): Promise<void> {
    const total = traj.length - 1;
    const durMs = (total / T.fps) * 1000;
    const hits = lanes.flatMap(({ lane }) => this.impacts(traj, lane, half));
    let nextHit = 0;
    hits.sort((a, b) => a.frame - b.frame);
    let slowed = false;
    await this.tw.run(durMs, (k) => {
      const f = k * total;
      for (const { lane, obj } of lanes) {
        const { p, q } = this.frameAt(traj, lane, f);
        obj.mesh.position.copy(p);
        obj.mesh.quaternion.copy(q);
      }
      while (nextHit < hits.length && hits[nextHit]!.frame <= f) this.hooks.onImpact?.(hits[nextHit++]!.strength);
      // Натуральные 1 и 20: вторая половина броска замедляется до 35%, камера приближается.
      if (crit && !slowed && k > 0.45) {
        slowed = true;
        this.critSlow = 0.35;
        void this.zoomTo(1.55, at(0, TRAY_DEPTH + 0.3, 0), 500);
      }
    }, ease.linear);
    this.critSlow = 1;
  }

  /** Бросок кубиков героя: нужная грань подставляется так, чтобы выпасть сверху. */
  async rollD6(traj: number, specs: DieRollSpec[]): Promise<void> {
    const tr = T.d6[traj % T.d6.length]!;
    while (this.dice.length < 3) this.dice.push(this.makeD6());
    // Оставленные кубики отъезжают к краю лотка, чтобы не мешать.
    const rolling = new Set(specs.map((s) => s.die));
    const kept = this.dice.map((d, i) => ({ d, i })).filter((x) => !rolling.has(x.i));
    await Promise.all(
      kept.map(({ d, i }) => {
        const from = d.mesh.position.clone();
        const to = new THREE.Vector3(-1.85 + i * 0.7, T.d6Half, 1.15);
        return this.tw.run(220, (k) => d.mesh.position.lerpVectors(from, to, k));
      }),
    );
    for (const s of specs) {
      const obj = this.dice[s.die]!;
      const end = this.frameAt(tr, s.die, tr.length - 1).q;
      const up = this.upSlot(obj.normals, end);
      // Верхней становится выпавшая грань, остальные — по порядку.
      const order = s.faces.map((_, i) => i).filter((i) => i !== s.result);
      obj.labels.forEach((l, slot) => {
        const faceIdx = slot === up ? s.result : order[slot < up ? slot : slot - 1]!;
        l.material.map = this.faceTexture(s.faces[faceIdx]!);
        l.material.needsUpdate = true;
      });
      obj.mesh.visible = true;
    }
    await this.playTraj(tr, specs.map((s) => ({ lane: s.die, obj: this.dice[s.die]! })), T.d6Half, false);
  }

  async rollD20(traj: number, natural: number): Promise<void> {
    const tr = T.d20[traj % T.d20.length]!;
    for (const d of this.dice) d.mesh.visible = false;
    if (!this.d20) this.d20 = this.makeD20();
    const obj = this.d20;
    const up = this.upSlot(obj.normals, this.frameAt(tr, 0, tr.length - 1).q);
    const rest = Array.from({ length: 20 }, (_, i) => i + 1).filter((n) => n !== natural);
    obj.labels.forEach((l, slot) => {
      l.material.map = this.numberTexture(slot === up ? natural : rest[slot < up ? slot : slot - 1]!);
      l.material.needsUpdate = true;
    });
    obj.mesh.visible = true;
    const crit = natural === 1 || natural === 20;
    await this.playTraj(tr, [{ lane: 0, obj }], T.d20Radius * 0.8, crit);
    if (crit) await this.tableFx(natural === 20 ? "crit" : "fumble");
  }

  private async zoomTo(z: number, focus: THREE.Vector3, ms: number): Promise<void> {
    const z0 = this.camera.zoom;
    const t0 = this.camTarget.clone();
    const dir = this.camera.position.clone().sub(this.camTarget).normalize();
    await this.tw.run(ms, (k) => {
      this.camera.zoom = z0 + (z - z0) * k;
      const t = t0.clone().lerp(focus, k);
      this.camera.position.copy(t).addScaledVector(dir, 30);
      this.camera.lookAt(t);
      this.camera.updateProjectionMatrix();
    }, ease.inOutCubic);
    this.camTarget.copy(focus);
  }

  /** Короткий эффект стола после натуральной 1 или 20. */
  async tableFx(kind: "crit" | "fumble"): Promise<void> {
    this.shakeAmp = kind === "crit" ? 0.18 : 0.25;
    const color = kind === "crit" ? "#ffd45c" : "#c0392b";
    if (this.d20) this.burst(this.trayRoot.localToWorld(this.d20.mesh.position.clone()), color, 40);
    const glow = new THREE.PointLight(color, 0, 6);
    glow.position.copy(at(0, TRAY_DEPTH, 1.2));
    this.scene.add(glow);
    await this.tw.run(700, (k) => (glow.intensity = Math.sin(k * Math.PI) * 40));
    this.scene.remove(glow);
    await this.tw.wait(250);
    await this.zoomTo(this.baseZoom, at(0, 0.45, 0), 450);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
    this.tw.flush();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, v + amt));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

export function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}
