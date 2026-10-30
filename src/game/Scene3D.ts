import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { pointInPolygon, type Vec2 } from '../geo';
import { DITCH, headingAt, pointAt, project, VERGE, type Course, type Surface } from '../osm/course';
import { BALL_RADIUS, launchSpeed, mulberry32, type ThrowResult } from './physics';
import { grassTexture, labelTexture, roadTexture } from './textures';

/**
 * Die 3D-Welt: Straße aus OSM, Gräben, Bäume, Häuser, zwei Kugeln und die werfende Figur.
 * Lokale Strecken-Koordinaten (x Osten, y Norden) werden zu three.js (x, Höhe, −y).
 */

const SURFACE_COLOR: Record<Surface, number> = {
  asphalt: 0x55575c,
  paved: 0x9a5444, // ostfriesischer Klinker
  gravel: 0x9c9384,
  dirt: 0x86704f,
};
const SKY = 0xa9cdea;

const w3 = (p: Vec2, h = 0) => new THREE.Vector3(p.x, h, -p.y);

type Mode = 'idle' | 'aim' | 'runup' | 'flight' | 'settle';

interface Figure {
  root: THREE.Group;
  body: THREE.Group;
  arm: THREE.Group;
  legs: [THREE.Group, THREE.Group];
  shirt: THREE.MeshLambertMaterial;
}

export class Scene3D {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2500);
  private readonly sun = new THREE.DirectionalLight(0xfff4e0, 1.6);
  private readonly balls: THREE.Mesh[] = [];
  private readonly markers: THREE.Mesh[] = [];
  private readonly blobs: THREE.Mesh[] = [];
  private readonly figure: Figure;
  private readonly aimArrow: THREE.Mesh;
  private mode: Mode = 'idle';
  private clock = new THREE.Timer();
  private time = 0;
  private speed = 1;
  private disposed = false;

  // Wurf-Zustand
  private throwSpot = new THREE.Vector3();
  private throwDir = new THREE.Vector3(0, 0, -1);
  private throwRight = new THREE.Vector3(1, 0, 0);
  private result: ThrowResult | null = null;
  private activeBall = 0;
  private flightTime = 0;
  private settleTime = 0;
  private onThrowDone: (() => void) | null = null;
  private camLook = new THREE.Vector3();
  private chaseDir = new THREE.Vector3(0, 0, -1);

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly course: Course,
    teamColors: [string, string],
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 140, 900);

    this.scene.add(new THREE.HemisphereLight(0xdcefff, 0x5a7a3a, 1.3));
    this.sun.position.set(60, 120, 40);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -35;
    sc.right = sc.top = 35;
    sc.near = 1;
    sc.far = 300;
    this.scene.add(this.sun, this.sun.target);

    this.buildGround();
    this.buildRoad();
    this.buildBuildings();
    this.buildWater();
    this.buildTrees();
    this.buildMarkers();

    for (const color of teamColors) {
      const ball = new THREE.Mesh(
        new THREE.SphereGeometry(BALL_RADIUS, 20, 14),
        new THREE.MeshStandardMaterial({ color, roughness: 0.45 }),
      );
      ball.castShadow = true;
      this.scene.add(ball);
      this.balls.push(ball);
      const marker = new THREE.Mesh(
        new THREE.ConeGeometry(0.25, 0.6, 12).rotateX(Math.PI),
        new THREE.MeshBasicMaterial({ color, fog: false, transparent: true, opacity: 0.9 }),
      );
      this.scene.add(marker);
      this.markers.push(marker);
      const blob = new THREE.Mesh(
        new THREE.CircleGeometry(BALL_RADIUS * 1.3, 16).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }),
      );
      this.scene.add(blob);
      this.blobs.push(blob);
    }

    this.figure = this.buildFigure();
    this.scene.add(this.figure.root);

    this.aimArrow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.18, 1).rotateX(-Math.PI / 2).translate(0, 0.03, -0.5),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    this.aimArrow.visible = false;
    this.scene.add(this.aimArrow);

    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) {
        o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          (m as THREE.MeshBasicMaterial).map?.dispose();
          m.dispose();
        }
      }
    });
    this.renderer.dispose();
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w < h ? 72 : 58;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- Welt bauen

  private normals(): Vec2[] {
    const pts = this.course.points;
    return pts.map((_, i) => {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { x: -(b.y - a.y) / l, y: (b.x - a.x) / l };
    });
  }

  /** Band entlang der Strecke: je Punkt eine Reihe Spalten mit seitlichem Abstand, Höhe und Farbe. */
  private ribbon(cols: (i: number) => { d: number; h: number; c: THREE.Color }[], material: THREE.Material): THREE.Mesh {
    const { points, cum } = this.course;
    const n = this.normals();
    const pos: number[] = [];
    const uv: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    let width = 0;
    for (let i = 0; i < points.length; i++) {
      const row = cols(i);
      width = row.length;
      for (const { d, h, c } of row) {
        pos.push(points[i].x + n[i].x * d, h, -(points[i].y + n[i].y * d));
        uv.push(d / 3, cum[i] / 3);
        col.push(c.r, c.g, c.b);
      }
    }
    for (let i = 0; i < points.length - 1; i++) {
      for (let j = 0; j < width - 1; j++) {
        const a = i * width + j;
        const b = a + width;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, material);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    return mesh;
  }

  private buildGround(): void {
    const xs = this.course.points.map((p) => p.x);
    const ys = this.course.points.map((p) => p.y);
    const minX = Math.min(...xs) - 900;
    const maxX = Math.max(...xs) + 900;
    const minY = Math.min(...ys) - 900;
    const maxY = Math.max(...ys) + 900;
    const w = maxX - minX;
    const h = maxY - minY;
    const seg = 80;
    const g = new THREE.PlaneGeometry(w, h, seg, seg).rotateX(-Math.PI / 2);
    g.translate(minX + w / 2, -0.02, -(minY + h / 2));
    // großflächige Farbflecken = Weiden und Äcker
    const rand = mulberry32(42);
    const colors: number[] = [];
    const tint = new THREE.Color();
    for (let i = 0; i < g.attributes.position.count; i++) {
      const v = rand();
      tint.setHSL(0.22 + v * 0.06, 0.45 + v * 0.15, 0.62 + rand() * 0.12);
      colors.push(tint.r, tint.g, tint.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const tex = grassTexture();
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w / 6), uv.getY(i) * (h / 6));
    const ground = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: tex, vertexColors: true, depthWrite: false }));
    // Boden zuerst und ohne Tiefe zeichnen: so bleiben die tiefer liegenden Gräben sichtbar
    ground.renderOrder = -1;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  private buildRoad(): void {
    const c = this.course;
    const tex = roadTexture();
    const mat = new THREE.MeshLambertMaterial({ map: tex, vertexColors: true, side: THREE.DoubleSide });
    const surf = c.surface.map((s) => new THREE.Color(SURFACE_COLOR[s]));
    this.ribbon((i) => {
      const hw = c.halfWidth[i];
      return [
        { d: -hw, h: 0.0, c: surf[i] },
        { d: 0, h: 0.04, c: surf[i] },
        { d: hw, h: 0.0, c: surf[i] },
      ];
    }, mat);

    const verge = new THREE.Color(0x7fa65a);
    const bank = new THREE.Color(0x5d8240);
    const water = new THREE.Color(0x3d5a5c);
    const curb = new THREE.Color(0x9a958c);
    const walk = new THREE.Color(0xc9c2b4);
    const grass = new THREE.Color(0x8db866);
    const sideMat = new THREE.MeshLambertMaterial({ map: grassTexture(), vertexColors: true, side: THREE.DoubleSide });
    for (const side of [1, -1]) {
      this.ribbon((i) => {
        const hw = c.halfWidth[i];
        const at = (o: number) => side * (hw + o);
        if (c.roadside[i] === 'ditch') {
          return [
            { d: at(0), h: 0, c: verge },
            { d: at(0.05), h: 0, c: verge },
            { d: at(VERGE), h: -0.05, c: bank },
            { d: at(VERGE + 0.5), h: -0.55, c: water },
            { d: at(VERGE + DITCH - 0.5), h: -0.55, c: water },
            { d: at(VERGE + DITCH), h: 0, c: bank },
          ];
        }
        return [
          { d: at(0), h: 0, c: curb },
          { d: at(0.05), h: 0.12, c: curb },
          { d: at(VERGE), h: 0.12, c: walk },
          { d: at(VERGE + 0.5), h: 0.08, c: grass },
          { d: at(VERGE + DITCH - 0.5), h: 0.02, c: grass },
          { d: at(VERGE + DITCH), h: 0, c: grass },
        ];
      }, sideMat);
    }

    // Startlinie
    const start = pointAt(c, 0);
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(c.halfWidth[0] * 2, 0.15).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    line.position.copy(w3(start.p, 0.05));
    line.rotation.y = Math.atan2(-start.dir.x, start.dir.y);
    this.scene.add(line);
  }

  private buildBuildings(): void {
    const geos: THREE.BufferGeometry[] = [];
    const walls = [0x8e3b2c, 0xa24b33, 0x7c3426, 0xd8d2c4, 0xb55a3c];
    const roofs = [0x3b3b40, 0x6d2a22, 0x4a4f55];
    const rand = mulberry32(17);
    const wall = new THREE.Color();
    const roof = new THREE.Color();
    for (const b of this.course.buildings) {
      const shape = new THREE.Shape(b.footprint.map((p) => new THREE.Vector2(p.x, p.y)));
      const g = new THREE.ExtrudeGeometry(shape, { depth: b.height, bevelEnabled: false });
      g.rotateX(-Math.PI / 2);
      wall.setHex(walls[Math.floor(rand() * walls.length)]);
      roof.setHex(roofs[Math.floor(rand() * roofs.length)]);
      const normal = g.attributes.normal;
      const colors: number[] = [];
      for (let i = 0; i < normal.count; i++) {
        const c = normal.getY(i) > 0.5 ? roof : wall;
        colors.push(c.r, c.g, c.b);
      }
      g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      g.deleteAttribute('uv');
      geos.push(g);
    }
    if (!geos.length) return;
    const merged = mergeGeometries(geos);
    for (const g of geos) g.dispose();
    const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  private buildWater(): void {
    const mat = new THREE.MeshLambertMaterial({ color: 0x4f7f9a });
    for (const poly of this.course.water) {
      const shape = new THREE.Shape(poly.map((p) => new THREE.Vector2(p.x, p.y)));
      const g = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, 0.01, 0);
      const mesh = new THREE.Mesh(g, mat);
      mesh.renderOrder = -1;
      this.scene.add(mesh);
    }
  }

  /** Baumreihen an den Landstraßen – typisch für die Marsch. */
  private buildTrees(): void {
    const c = this.course;
    const n = this.normals();
    const rand = mulberry32(99);
    const spots: { p: Vec2; s: number }[] = [];
    const blocked = (p: Vec2) => {
      for (const b of c.buildings) if (pointInPolygon(p, b.footprint)) return true;
      const pr = project(c, p);
      return Math.abs(pr.d) < c.halfWidth[pr.idx] + VERGE + DITCH + 0.8;
    };
    for (let i = 4; i < c.points.length; i += 6 + Math.floor(rand() * 4)) {
      if (c.roadside[i] !== 'ditch') continue;
      for (const side of [1, -1]) {
        if (rand() < 0.35) continue;
        const off = side * (c.halfWidth[i] + VERGE + DITCH + 1.5 + rand() * 2);
        const p = { x: c.points[i].x + n[i].x * off, y: c.points[i].y + n[i].y * off };
        if (!blocked(p)) spots.push({ p, s: 0.8 + rand() * 0.6 });
      }
    }
    if (!spots.length) return;
    const trunk = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.15, 0.22, 3, 6).translate(0, 1.5, 0),
      new THREE.MeshLambertMaterial({ color: 0x5b4632 }),
      spots.length,
    );
    const crown = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(2.2, 0).translate(0, 4.4, 0),
      new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
      spots.length,
    );
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const color = new THREE.Color();
    spots.forEach((t, k) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI * 2);
      m.compose(w3(t.p), q, new THREE.Vector3(t.s, t.s * (0.9 + rand() * 0.4), t.s));
      trunk.setMatrixAt(k, m);
      crown.setMatrixAt(k, m);
      color.setHSL(0.24 + rand() * 0.08, 0.45, 0.28 + rand() * 0.1);
      crown.setColorAt(k, color);
    });
    trunk.castShadow = crown.castShadow = true;
    this.scene.add(trunk, crown);
  }

  /** Ziel-Bogen und Entfernungstafeln alle 100 m. */
  private buildMarkers(): void {
    const c = this.course;
    const end = pointAt(c, c.length);
    const dir = headingAt(c, Math.max(0, c.length - 10), 10);
    const hw = c.halfWidth[c.halfWidth.length - 1];
    const arch = new THREE.Group();
    const postGeo = new THREE.CylinderGeometry(0.08, 0.08, 4.2, 8).translate(0, 2.1, 0);
    const postMat = new THREE.MeshLambertMaterial({ color: 0xeeeeee });
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.x = side * (hw + 0.8);
      post.castShadow = true;
      arch.add(post);
    }
    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(hw * 2 + 1.6, 0.9),
      new THREE.MeshBasicMaterial({ map: labelTexture('ZIEL', '#c8102e', '#ffffff'), side: THREE.DoubleSide }),
    );
    banner.position.y = 3.7;
    arch.add(banner);
    const finishLine = new THREE.Mesh(
      new THREE.PlaneGeometry(hw * 2, 0.3).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    finishLine.position.y = 0.05;
    arch.add(finishLine);
    arch.position.copy(w3(end.p));
    arch.rotation.y = Math.atan2(-dir.x, dir.y);
    this.scene.add(arch);

    const n = this.normals();
    for (let s = 100; s < c.length - 20; s += 100) {
      const at = pointAt(c, s);
      const off = c.halfWidth[at.idx] + 0.6;
      const p = { x: at.p.x - n[at.idx].x * off, y: at.p.y - n[at.idx].y * off };
      const post = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 1, 0.1).translate(0, 0.5, 0),
        new THREE.MeshLambertMaterial({ color: 0xf2f2f2 }),
      );
      post.position.copy(w3(p));
      this.scene.add(post);
      const label = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: labelTexture(`${s} m`, '#ffffff', '#222222', 256, 96) }),
      );
      label.scale.set(1.2, 0.45, 1);
      label.position.copy(w3(p, 1.3));
      this.scene.add(label);
    }
  }

  private buildFigure(): Figure {
    const skin = new THREE.MeshLambertMaterial({ color: 0xe8b996 });
    const shirt = new THREE.MeshLambertMaterial({ color: 0xcc3333 });
    const pants = new THREE.MeshLambertMaterial({ color: 0x2c3a55 });
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const box = (w: number, h: number, d: number, mat: THREE.Material) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.castShadow = true;
      return m;
    };
    const legs: THREE.Group[] = [];
    for (const side of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(side * 0.11, 0.9, 0);
      const leg = box(0.15, 0.9, 0.17, pants);
      leg.position.y = -0.45;
      hip.add(leg);
      body.add(hip);
      legs.push(hip);
    }
    const torso = box(0.42, 0.62, 0.24, shirt);
    torso.position.y = 1.22;
    body.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), skin);
    head.position.y = 1.68;
    head.castShadow = true;
    body.add(head);
    const leftArm = box(0.1, 0.62, 0.1, shirt);
    leftArm.position.set(-0.27, 1.2, -0.05);
    leftArm.rotation.x = 0.4;
    body.add(leftArm);
    const arm = new THREE.Group();
    arm.position.set(0.27, 1.48, 0);
    const upper = box(0.1, 0.66, 0.1, shirt);
    upper.position.y = -0.33;
    arm.add(upper);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), skin);
    hand.position.y = -0.68;
    arm.add(hand);
    body.add(arm);
    return { root, body, arm, legs: legs as [THREE.Group, THREE.Group], shirt };
  }

  // ---------------------------------------------------------------- Steuerung von außen

  setBall(team: number, rest: { s: number; d: number }, z = 0): void {
    const at = pointAt(this.course, rest.s);
    const h = headingAt(this.course, rest.s);
    const p = { x: at.p.x - h.y * rest.d, y: at.p.y + h.x * rest.d };
    this.balls[team].position.copy(w3(p, z + BALL_RADIUS));
  }

  hideBall(team: number, hidden: boolean): void {
    this.balls[team].visible = !hidden;
  }

  /** Werfer an seine Kugel stellen und die Kamera hinter ihn setzen. */
  aim(team: number, color: string, rest: { s: number; d: number }): void {
    this.activeBall = team;
    this.figure.shirt.color.set(color);
    const at = pointAt(this.course, rest.s);
    const h = headingAt(this.course, rest.s);
    const spot = { x: at.p.x - h.y * rest.d, y: at.p.y + h.x * rest.d };
    this.throwSpot.copy(w3(spot));
    this.throwDir.set(h.x, 0, -h.y);
    this.throwRight.set(h.y, 0, h.x);
    this.setBall(team, rest);
    this.balls[team].visible = false; // liegt in der Hand
    this.placeFigure(-3.5, 0);
    this.mode = 'aim';
    this.time = 0;
    this.speed = 1;
  }

  /** Vorschaupfeil beim Wischen; `null` blendet ihn aus. */
  preview(aim: { yaw: number; power: number } | null): void {
    if (!aim) {
      this.aimArrow.visible = false;
      return;
    }
    const dir = this.throwDir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), aim.yaw);
    this.aimArrow.visible = true;
    this.aimArrow.position.copy(this.throwSpot);
    this.aimArrow.rotation.y = Math.atan2(-dir.x, -dir.z);
    this.aimArrow.scale.set(1, 1, 3 + launchSpeed(aim.power) * 1.2);
    (this.aimArrow.material as THREE.MeshBasicMaterial).color.setHSL(0.33 - aim.power * 0.33, 0.9, 0.6);
  }

  /** Anlauf, Wurf und Kugelflug abspielen. */
  playThrow(result: ThrowResult, onDone: () => void): void {
    this.result = result;
    this.onThrowDone = onDone;
    this.mode = 'runup';
    this.time = 0;
    this.flightTime = 0;
    this.settleTime = 0;
    this.aimArrow.visible = false;
  }

  /** Antippen während des Flugs: schneller vorspulen. */
  fastForward(): void {
    if (this.mode === 'flight' || this.mode === 'settle') this.speed = 4;
  }

  // ---------------------------------------------------------------- Animation

  private placeFigure(back: number, crouch: number): void {
    const f = this.figure;
    // Die Wurfhand (rechts) liegt beim Abwurf genau über der Kugel
    f.root.position
      .copy(this.throwSpot)
      .addScaledVector(this.throwDir, back)
      .addScaledVector(this.throwRight, -0.27);
    f.root.position.y = -crouch;
    f.root.rotation.y = Math.atan2(-this.throwDir.x, -this.throwDir.z);
  }

  private frame(): void {
    if (this.disposed) return;
    this.clock.update();
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.time += dt;
    const f = this.figure;
    const cam = this.camera;

    if (this.mode === 'aim') {
      this.placeFigure(-3.5, 0);
      f.arm.rotation.x = 0.15 * Math.sin(this.time * 1.5);
      f.legs[0].rotation.x = f.legs[1].rotation.x = 0;
      f.body.rotation.x = 0;
      this.overShoulder(f.root.position, 1);
    } else if (this.mode === 'runup') {
      const RUN = 0.9;
      const SWING = 0.32;
      const t = this.time;
      if (t < RUN) {
        const k = t / RUN;
        this.placeFigure(-3.5 + 3.2 * k * k * (3 - 2 * k), 0);
        const stride = Math.sin(t * 16);
        f.legs[0].rotation.x = stride * 0.7;
        f.legs[1].rotation.x = -stride * 0.7;
        f.arm.rotation.x = -2.3 * k; // weit nach hinten ausholen
        f.body.rotation.x = 0;
      } else {
        const k = Math.min(1, (t - RUN) / SWING);
        this.placeFigure(-0.3 + 0.3 * k, 0.35 * Math.sin(k * Math.PI * 0.8));
        f.legs[0].rotation.x = -0.9 * k;
        f.legs[1].rotation.x = 0.6 * k;
        f.body.rotation.x = -0.35 * k;
        f.arm.rotation.x = -2.3 + 3.0 * k;
        if (k >= 1) {
          this.mode = 'flight';
          this.flightTime = 0;
          this.balls[this.activeBall].visible = true;
          this.chaseDir.copy(this.throwDir);
        }
      }
      this.overShoulder(f.root.position, 1);
    } else if (this.mode === 'flight' || this.mode === 'settle') {
      const r = this.result!;
      this.flightTime += dt * this.speed;
      const fi = Math.min(r.frames.length - 1, this.flightTime * 60);
      const i0 = Math.floor(fi);
      const i1 = Math.min(r.frames.length - 1, i0 + 1);
      const a = r.frames[i0];
      const b = r.frames[i1];
      const k = fi - i0;
      const ball = this.balls[this.activeBall];
      ball.position.set(a.x + (b.x - a.x) * k, a.z + (b.z - a.z) * k + BALL_RADIUS, -(a.y + (b.y - a.y) * k));
      const vel = new THREE.Vector3(b.x - a.x, 0, -(b.y - a.y));
      if (vel.lengthSq() > 1e-6) this.chaseDir.lerp(vel.normalize(), 1 - Math.exp(-dt * 4)).normalize();
      // Nachlauf-Pose halten, Figur richtet sich langsam auf
      f.arm.rotation.x += (0.7 - f.arm.rotation.x) * dt * 2;
      this.chase(ball.position, dt);
      if (fi >= r.frames.length - 1) {
        if (this.mode === 'flight') {
          this.mode = 'settle';
          this.settleTime = 0;
        }
        this.settleTime += dt * this.speed;
        if (this.settleTime > 1.3) {
          this.mode = 'idle';
          const done = this.onThrowDone;
          this.onThrowDone = null;
          done?.();
        }
      }
    }

    this.updateMarkers();
    // Schatten folgen dem Blickpunkt
    this.sun.target.position.copy(this.camLook);
    this.sun.position.copy(this.camLook).add(new THREE.Vector3(40, 90, 30));
    cam.lookAt(this.camLook);
    this.renderer.render(this.scene, cam);
  }

  /** Ich-Perspektive knapp hinter und über dem Werfer. */
  private overShoulder(at: THREE.Vector3, smooth: number): void {
    // über die linke Schulter, damit der Wurfarm rechts im Bild bleibt
    const target = at.clone().addScaledVector(this.throwDir, -3.4).addScaledVector(this.throwRight, -0.75);
    target.y = 2.25;
    const look = this.throwSpot.clone().addScaledVector(this.throwDir, 30);
    look.y = 0.3;
    if (smooth >= 1) {
      this.camera.position.copy(target);
      this.camLook.copy(look);
    }
  }

  private chase(ball: THREE.Vector3, dt: number): void {
    const target = ball.clone().addScaledVector(this.chaseDir, -6.5);
    target.y = Math.max(ball.y, 0) + 2.3;
    const k = 1 - Math.exp(-dt * 3.5 * this.speed);
    this.camera.position.lerp(target, k);
    const look = ball.clone().addScaledVector(this.chaseDir, 4);
    this.camLook.lerp(look, k * 1.5 > 1 ? 1 : k * 1.5);
  }

  private updateMarkers(): void {
    const cam = this.camera.position;
    this.balls.forEach((ball, i) => {
      const marker = this.markers[i];
      const blob = this.blobs[i];
      const d = cam.distanceTo(ball.position);
      marker.visible = ball.visible && d > 6;
      const s = Math.max(0.4, Math.min(8, d * 0.03));
      marker.scale.setScalar(s);
      marker.position.set(ball.position.x, ball.position.y + 0.4 + s * 0.6 + Math.sin(this.time * 3 + i) * 0.1 * s, ball.position.z);
      blob.visible = ball.visible && ball.position.y > -0.1;
      blob.position.set(ball.position.x, 0.05, ball.position.z);
      const lift = Math.max(0, ball.position.y - BALL_RADIUS);
      (blob.material as THREE.MeshBasicMaterial).opacity = Math.max(0.05, 0.35 - lift * 0.25);
    });
  }
}
