import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { dist, pointInPolygon, type Vec2 } from '../geo';
import {
  DITCH,
  headingAt,
  pointAt,
  project,
  VERGE,
  type AreaKind,
  type Building,
  type Course,
  type Surface,
  type Tree,
  type TreeKind,
} from '../osm/course';
import type { Assets, Part, TextureName } from './assets';
import type { Obstacle } from './obstacles';
import { mulberry32 } from '../random';
import { labelTexture } from './textures';

/**
 * Baut die Landschaft einer Strecke aus den OSM-Daten: Flächen, Straße mit Bankette und Graben,
 * Häuser mit Dächern, Bäume, Hecken, Gewässer und Weidetiere. Lokale Strecken-Koordinaten
 * (x Osten, y Norden) werden zu three.js (x, Höhe, −y).
 */

export const w3 = (p: Vec2, h = 0) => new THREE.Vector3(p.x, h, -p.y);

const SURFACE_TEX: Record<Surface, { tex: TextureName; tile: number; tint: number }> = {
  asphalt: { tex: 'asphalt', tile: 4, tint: 0xd8d8d8 },
  paved: { tex: 'klinker', tile: 2, tint: 0xffffff },
  gravel: { tex: 'gravel', tile: 3, tint: 0xe8e0d0 },
  dirt: { tex: 'dirt', tile: 4, tint: 0xffffff },
};

/** Zeichenreihenfolge und Aussehen der Flächen (alle flach auf dem Boden). */
const AREA_STYLE: Record<AreaKind, { tex: TextureName; tint: number; tile: number; order: number }> = {
  residential: { tex: 'grass', tint: 0xf0f4e8, tile: 6, order: 0 },
  farmland: { tex: 'field', tint: 0xffffff, tile: 10, order: 1 },
  meadow: { tex: 'grass', tint: 0xe4f0d8, tile: 7, order: 2 },
  grass: { tex: 'grass', tint: 0xf4f8ec, tile: 6, order: 2 },
  orchard: { tex: 'grass', tint: 0xe0ecd0, tile: 6, order: 2 },
  farmyard: { tex: 'gravel', tint: 0xffffff, tile: 4, order: 3 },
  scrub: { tex: 'grass', tint: 0xb8c8a0, tile: 6, order: 3 },
  forest: { tex: 'dirt', tint: 0x9aa080, tile: 6, order: 4 },
};

const WATER = 0x4a6f80;
const CHUNK = 160;
const VISIBLE = 520;
const SHADOW = 110;

interface Chunk {
  center: THREE.Vector3;
  meshes: THREE.InstancedMesh[];
}

export class World {
  private readonly chunks: Chunk[] = [];
  private readonly normals: Vec2[];
  readonly ground: THREE.Mesh;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly course: Course,
    private readonly assets: Assets,
  ) {
    this.normals = this.computeNormals();
    this.ground = this.buildGround();
    this.buildAreas();
    this.buildWater();
    this.buildRoad();
    this.buildBuildings();
    this.buildTrees();
    this.buildHedges();
    this.buildAnimals();
    this.buildMarkers();
  }

  /** Ferne Baumgruppen ausblenden, Schatten nur in der Nähe. */
  update(camera: THREE.Vector3): void {
    for (const c of this.chunks) {
      const d = c.center.distanceTo(camera);
      const visible = d < VISIBLE;
      const shadow = d < SHADOW;
      for (const m of c.meshes) {
        m.visible = visible;
        m.castShadow = shadow;
      }
    }
  }

  private tex(name: TextureName): THREE.Texture {
    return this.assets.textures[name];
  }

  private computeNormals(): Vec2[] {
    const pts = this.course.points;
    return pts.map((_, i) => {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { x: -(b.y - a.y) / l, y: (b.x - a.x) / l };
    });
  }

  // ------------------------------------------------------------ Boden und Flächen

  private buildGround(): THREE.Mesh {
    const xs = this.course.points.map((p) => p.x);
    const ys = this.course.points.map((p) => p.y);
    const minX = Math.min(...xs) - 900;
    const maxX = Math.max(...xs) + 900;
    const minY = Math.min(...ys) - 900;
    const maxY = Math.max(...ys) + 900;
    const w = maxX - minX;
    const h = maxY - minY;
    const g = new THREE.PlaneGeometry(w, h, 60, 60).rotateX(-Math.PI / 2);
    g.translate(minX + w / 2, -0.03, -(minY + h / 2));
    const rand = mulberry32(42);
    const colors: number[] = [];
    const tint = new THREE.Color();
    for (let i = 0; i < g.attributes.position.count; i++) {
      tint.setHSL(0.2 + rand() * 0.06, 0.25 + rand() * 0.15, 0.82 + rand() * 0.1);
      colors.push(tint.r, tint.g, tint.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * w) / 7, (uv.getY(i) * h) / 7);
    const ground = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: this.tex('grass'), vertexColors: true, depthWrite: false }));
    // Flächen ohne Tiefe zuerst zeichnen: so bleiben die tiefer liegenden Gräben sichtbar
    ground.renderOrder = -10;
    ground.receiveShadow = true;
    this.scene.add(ground);
    return ground;
  }

  /** Flaches Polygon mit Welt-UVs (Kachelgröße `tile` Meter). */
  private flat(poly: Vec2[], y: number, tile: number): THREE.BufferGeometry | undefined {
    if (poly.length < 3) return undefined;
    const contour = poly.map((p) => new THREE.Vector2(p.x, p.y));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    if (!tris.length) return undefined;
    const pos: number[] = [];
    const uv: number[] = [];
    for (const t of tris) {
      for (const i of t) {
        pos.push(poly[i].x, y, -poly[i].y);
        uv.push(poly[i].x / tile, poly[i].y / tile);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    return g;
  }

  private buildAreas(): void {
    const byKind = new Map<AreaKind, THREE.BufferGeometry[]>();
    for (const a of this.course.areas ?? []) {
      const g = this.flat(a.poly, -0.025, AREA_STYLE[a.kind].tile);
      if (!g) continue;
      if (!byKind.has(a.kind)) byKind.set(a.kind, []);
      byKind.get(a.kind)!.push(g);
    }
    for (const [kind, geos] of byKind) {
      const style = AREA_STYLE[kind];
      const merged = mergeGeometries(geos);
      geos.forEach((g) => g.dispose());
      const mesh = new THREE.Mesh(
        merged,
        new THREE.MeshLambertMaterial({ map: this.tex(style.tex), color: style.tint, depthWrite: false }),
      );
      mesh.renderOrder = -9 + style.order;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
  }

  private buildWater(): void {
    const mat = new THREE.MeshStandardMaterial({ color: WATER, roughness: 0.15, metalness: 0.1, depthWrite: false });
    const geos: THREE.BufferGeometry[] = [];
    for (const poly of this.course.water) {
      const g = this.flat(poly, -0.02, 10);
      if (g) geos.push(g);
    }
    // Gräben, Bäche und Kanäle aus OSM als Wasserbänder
    for (const w of this.course.waterways ?? []) {
      const g = this.strip(w.line, w.width, -0.02);
      if (g) geos.push(g);
    }
    if (!geos.length) return;
    const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
    mesh.renderOrder = -3;
    this.scene.add(mesh);
  }

  /** Band entlang einer beliebigen Linie (Gewässer). */
  private strip(line: Vec2[], width: number, y: number): THREE.BufferGeometry | undefined {
    if (line.length < 2) return undefined;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    let along = 0;
    line.forEach((p, i) => {
      const a = line[Math.max(0, i - 1)];
      const b = line[Math.min(line.length - 1, i + 1)];
      const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const n = { x: (-(b.y - a.y) / l) * (width / 2), y: ((b.x - a.x) / l) * (width / 2) };
      if (i > 0) along += dist(line[i - 1], p);
      pos.push(p.x + n.x, y, -(p.y + n.y), p.x - n.x, y, -(p.y - n.y));
      uv.push(0, along / 10, 1, along / 10);
      if (i > 0) idx.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i, 2 * i - 1, 2 * i + 1);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setIndex(idx);
    return g.toNonIndexed();
  }

  // ------------------------------------------------------------ Straße

  /** Band entlang der Strecke von Punkt `from` bis `to`: je Punkt Spalten mit Abstand, Höhe, Farbe. */
  private ribbon(
    from: number,
    to: number,
    cols: (i: number) => { d: number; h: number; c: THREE.Color }[],
    tile: number,
    material: THREE.Material,
  ): void {
    const { points, cum } = this.course;
    const n = this.normals;
    const pos: number[] = [];
    const uv: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    let width = 0;
    for (let i = from; i <= to; i++) {
      const row = cols(i);
      width = row.length;
      for (const { d, h, c } of row) {
        pos.push(points[i].x + n[i].x * d, h, -(points[i].y + n[i].y * d));
        uv.push(d / tile, cum[i] / tile);
        col.push(c.r, c.g, c.b);
      }
    }
    for (let r = 0; r < to - from; r++) {
      for (let j = 0; j < width - 1; j++) {
        const a = r * width + j;
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
  }

  /** Abschnitte gleicher Eigenschaft (Belag, Randbebauung) – überlappen um einen Punkt. */
  private runs<T>(values: T[]): { from: number; to: number; value: T }[] {
    const out: { from: number; to: number; value: T }[] = [];
    let start = 0;
    for (let i = 1; i <= values.length; i++) {
      if (i === values.length || values[i] !== values[start]) {
        out.push({ from: start, to: Math.min(i, values.length - 1), value: values[start] });
        start = i;
      }
    }
    return out;
  }

  private buildRoad(): void {
    const c = this.course;
    const white = new THREE.Color(0xffffff);
    for (const run of this.runs(c.surface)) {
      const style = SURFACE_TEX[run.value];
      const mat = new THREE.MeshLambertMaterial({ map: this.tex(style.tex), color: style.tint, vertexColors: true, side: THREE.DoubleSide });
      this.ribbon(
        run.from,
        run.to,
        (i) => {
          const hw = c.halfWidth[i];
          return [
            { d: -hw, h: 0, c: white },
            { d: 0, h: 0.04, c: white },
            { d: hw, h: 0, c: white },
          ];
        },
        style.tile,
        mat,
      );
    }

    const verge = new THREE.Color(0xf4fff0);
    const bank = new THREE.Color(0xc8dcb8);
    const water = new THREE.Color(0x5a8090);
    const grassMat = new THREE.MeshLambertMaterial({ map: this.tex('grass'), vertexColors: true, side: THREE.DoubleSide });
    const curb = new THREE.Color(0x9a958c);
    const walk = new THREE.Color(0xffffff);
    const lawn = new THREE.Color(0xf0f8e8);
    const walkMat = new THREE.MeshLambertMaterial({ map: this.tex('klinker'), vertexColors: true, side: THREE.DoubleSide });
    for (const run of this.runs(c.roadside)) {
      for (const side of [1, -1]) {
        const at = (i: number, o: number) => side * (c.halfWidth[i] + o);
        if (run.value === 'ditch') {
          // Wo der Graben aufhört (Ortseingang), läuft er flach aus statt offen zu enden
          const depth = (i: number) =>
            -0.55 * Math.min(1, run.from === 0 ? 1 : (i - run.from) / 4, run.to === c.points.length - 1 ? 1 : (run.to - i) / 4);
          this.ribbon(
            run.from,
            run.to,
            (i) => [
              { d: at(i, 0), h: 0, c: verge },
              { d: at(i, VERGE), h: -0.05, c: bank },
              { d: at(i, VERGE + 0.5), h: depth(i), c: water },
              { d: at(i, VERGE + DITCH - 0.5), h: depth(i), c: water },
              { d: at(i, VERGE + DITCH), h: 0, c: bank },
            ],
            2.5,
            grassMat,
          );
        } else {
          this.ribbon(
            run.from,
            run.to,
            (i) => [
              { d: at(i, 0), h: 0, c: curb },
              { d: at(i, 0.02), h: 0.12, c: curb },
              { d: at(i, VERGE), h: 0.12, c: walk },
              { d: at(i, VERGE + 0.4), h: 0.04, c: lawn },
              { d: at(i, VERGE + DITCH), h: 0, c: lawn },
            ],
            1.5,
            walkMat,
          );
        }
      }
    }
  }

  // ------------------------------------------------------------ Häuser

  private buildBuildings(): void {
    const walls: Record<'brick' | 'plaster', THREE.BufferGeometry[]> = { brick: [], plaster: [] };
    const roofs: THREE.BufferGeometry[] = [];
    for (const b of this.course.buildings) {
      const { wall, roof } = buildingGeometry(b);
      walls[b.material ?? 'brick'].push(wall);
      if (roof) roofs.push(roof);
    }
    const add = (geos: THREE.BufferGeometry[], map: THREE.Texture, brighten = 1) => {
      if (!geos.length) return;
      const mat = new THREE.MeshLambertMaterial({ map, vertexColors: true, side: THREE.DoubleSide });
      mat.color.setScalar(brighten);
      const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
      geos.forEach((g) => g.dispose());
      mesh.castShadow = mesh.receiveShadow = true;
      this.scene.add(mesh);
    };
    // Texturen sind recht dunkel fotografiert – etwas aufhellen
    add(walls.brick, this.tex('brick'), 1.6);
    add(walls.plaster, this.tex('plaster'), 1.1);
    add(roofs, this.tex('roof'), 1.4);
  }

  // ------------------------------------------------------------ Bäume, Hecken, Tiere

  /** Instanzen in Kacheln aufteilen, damit ferne Gruppen ausgeblendet werden können. */
  private instanced(items: { p: Vec2; parts: Part[]; scale: number; yaw: number }[], shadow = true): void {
    const groups = new Map<string, typeof items>();
    for (const it of items) {
      const key = `${Math.floor(it.p.x / CHUNK)},${Math.floor(it.p.y / CHUNK)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(it);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (const [key, list] of groups) {
      const [cx, cy] = key.split(',').map(Number);
      const chunk: Chunk = { center: w3({ x: (cx + 0.5) * CHUNK, y: (cy + 0.5) * CHUNK }), meshes: [] };
      // je Modell (gleiche Teile-Liste) ein InstancedMesh pro Teil
      const byModel = new Map<Part[], typeof items>();
      for (const it of list) {
        if (!byModel.has(it.parts)) byModel.set(it.parts, []);
        byModel.get(it.parts)!.push(it);
      }
      for (const [parts, models] of byModel) {
        for (const part of parts) {
          const mesh = new THREE.InstancedMesh(part.geometry, part.material, models.length);
          models.forEach((it, k) => {
            q.setFromAxisAngle(up, it.yaw);
            m.compose(w3(it.p), q, new THREE.Vector3(it.scale, it.scale, it.scale)).multiply(part.matrix);
            mesh.setMatrixAt(k, m);
          });
          mesh.computeBoundingSphere();
          mesh.castShadow = shadow;
          mesh.receiveShadow = true;
          this.scene.add(mesh);
          chunk.meshes.push(mesh);
        }
      }
      this.chunks.push(chunk);
    }
  }

  private buildTrees(): void {
    const rand = mulberry32(99);
    const trees: Tree[] = this.course.trees ?? [];
    this.instanced(
      trees.map((t) => ({ p: t.p, parts: this.assets.trees[t.kind as TreeKind], scale: t.scale, yaw: rand() * Math.PI * 2 })),
    );
  }

  private buildHedges(): void {
    const geos: THREE.BufferGeometry[] = [];
    for (const line of this.course.hedges ?? []) {
      for (let i = 0; i < line.length - 1; i++) {
        const a = line[i];
        const b = line[i + 1];
        const len = dist(a, b);
        if (len < 0.3) continue;
        const g = new THREE.BoxGeometry(len + 0.6, 1.7, 1.1);
        const uv = g.attributes.uv as THREE.BufferAttribute;
        for (let k = 0; k < uv.count; k++) uv.setXY(k, (uv.getX(k) * len) / 3, uv.getY(k) * 0.6);
        g.rotateY(Math.atan2(b.y - a.y, b.x - a.x));
        g.translate((a.x + b.x) / 2, 0.85, -(a.y + b.y) / 2);
        geos.push(g);
      }
    }
    if (!geos.length) return;
    const mesh = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshLambertMaterial({ map: this.tex('grass'), color: 0x5f8a3c }));
    geos.forEach((g) => g.dispose());
    mesh.castShadow = mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  /** Kühe und Schafe auf Weiden nahe der Strecke – ganz Ostfriesland. */
  private buildAnimals(): void {
    const items: { p: Vec2; parts: Part[]; scale: number; yaw: number }[] = [];
    const c = this.course;
    (c.areas ?? []).forEach((a, idx) => {
      if (a.kind !== 'meadow' && a.kind !== 'grass') return;
      const rand = mulberry32(500 + idx);
      if (rand() < 0.35) return;
      const sheep = rand() < 0.4;
      const xs = a.poly.map((p) => p.x);
      const ys = a.poly.map((p) => p.y);
      const herd = 2 + Math.floor(rand() * 6);
      // eine Herde um einen zufälligen Punkt in der Weide
      for (let tries = 0, placed = 0; tries < 60 && placed < herd; tries++) {
        const p = {
          x: Math.min(...xs) + rand() * (Math.max(...xs) - Math.min(...xs)),
          y: Math.min(...ys) + rand() * (Math.max(...ys) - Math.min(...ys)),
        };
        if (!pointInPolygon(p, a.poly)) continue;
        const pr = project(c, p);
        if (Math.abs(pr.d) < c.halfWidth[pr.idx] + VERGE + DITCH + 6 || Math.abs(pr.d) > 150) continue;
        items.push({ p, parts: sheep ? this.assets.sheep : this.assets.cow, scale: 0.9 + rand() * 0.2, yaw: rand() * Math.PI * 2 });
        placed++;
      }
    });
    if (items.length) this.instanced(items.slice(0, 120));
  }

  // ------------------------------------------------------------ Hindernisse

  /** Höhe der gewölbten Fahrbahn bei seitlichem Abstand `d`. */
  private roadHeight(o: Obstacle): number {
    const hw = this.course.halfWidth[pointAt(this.course, o.s).idx];
    return 0.04 * Math.max(0, 1 - Math.abs(o.d) / hw);
  }

  /** Unregelmäßige Scheibe (Schlagloch, Pfütze) flach auf der Straße. */
  private blob(o: Obstacle, radius: number, squash: number, seed: number): THREE.BufferGeometry {
    const rand = mulberry32(seed);
    const n = 14;
    const shape = new THREE.Shape();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = radius * (0.75 + rand() * 0.35);
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r * squash;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    return new THREE.ShapeGeometry(shape).rotateZ(o.angle).rotateX(-Math.PI / 2);
  }

  addObstacles(list: Obstacle[]): THREE.Object3D {
    const group = new THREE.Group();
    const rim = new THREE.MeshLambertMaterial({ color: 0x8a867e, polygonOffset: true, polygonOffsetFactor: -2 });
    const hole = new THREE.MeshLambertMaterial({ color: 0x1e1e20, polygonOffset: true, polygonOffsetFactor: -4 });
    const water = new THREE.MeshPhongMaterial({
      color: 0x7f9bab,
      specular: 0xffffff,
      shininess: 90,
      transparent: true,
      opacity: 0.85,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    });
    const mud = new THREE.MeshLambertMaterial({ color: 0x5a5040, polygonOffset: true, polygonOffsetFactor: -2 });
    const stone = new THREE.MeshLambertMaterial({ color: 0x8c8780, flatShading: true });
    list.forEach((o, i) => {
      const y = this.roadHeight(o) + 0.005;
      const at = w3(o);
      if (o.kind === 'stone') {
        const m = new THREE.Mesh(new THREE.IcosahedronGeometry(o.r, 0), stone);
        m.scale.set(1, 0.65, 0.9);
        m.rotation.y = i;
        m.position.copy(at).setY(y + o.r * 0.45);
        m.castShadow = true;
        group.add(m);
        return;
      }
      const squash = o.kind === 'puddle' ? 0.6 : 0.85;
      const outer = new THREE.Mesh(this.blob(o, o.r * 1.15, squash, i * 7 + 1), o.kind === 'puddle' ? mud : rim);
      outer.position.copy(at).setY(y);
      const inner = new THREE.Mesh(this.blob(o, o.r, squash, i * 7 + 2), o.kind === 'puddle' ? water : hole);
      inner.position.copy(at).setY(y + 0.003);
      outer.receiveShadow = inner.receiveShadow = true;
      group.add(outer, inner);
    });
    this.scene.add(group);
    return group;
  }

  // ------------------------------------------------------------ Start, Ziel, Tafeln

  private buildMarkers(): void {
    const c = this.course;
    const start = pointAt(c, 0);
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(c.halfWidth[0] * 2, 0.15).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    line.position.copy(w3(start.p, 0.05));
    line.rotation.y = Math.atan2(-start.dir.x, start.dir.y);
    this.scene.add(line);

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

    const n = this.normals;
    const postGeo2 = new THREE.BoxGeometry(0.1, 1, 0.1).translate(0, 0.5, 0);
    const postMat2 = new THREE.MeshLambertMaterial({ color: 0xf2f2f2 });
    for (let s = 100; s < c.length - 20; s += 100) {
      const at = pointAt(c, s);
      const off = c.halfWidth[at.idx] + 0.6;
      const p = { x: at.p.x - n[at.idx].x * off, y: at.p.y - n[at.idx].y * off };
      const post = new THREE.Mesh(postGeo2, postMat2);
      post.position.copy(w3(p));
      this.scene.add(post);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(`${s} m`, '#ffffff', '#222222', 256, 96) }));
      label.scale.set(1.2, 0.45, 1);
      label.position.copy(w3(p, 1.3));
      this.scene.add(label);
    }
  }
}

// ------------------------------------------------------------ Hausgeometrie

const TILE_WALL = 2.5;
const TILE_ROOF = 2;

/**
 * Wände und Dach eines Hauses. Sattel- und Walmdach setzen ein Rechteck voraus
 * (`scenery.ts` vereinfacht fast-rechteckige Grundrisse entsprechend), sonst Flachdach.
 */
export function buildingGeometry(b: Building): { wall: THREE.BufferGeometry; roof?: THREE.BufferGeometry } {
  const fp = b.footprint;
  const h = b.height;
  const wallTint = new THREE.Color(b.wallColor && b.material === 'plaster' ? b.wallColor : 0xffffff);
  const roofTint = new THREE.Color(b.roofColor ?? '#8a3324').lerp(new THREE.Color(0xffffff), 0.25);
  const wp: number[] = [];
  const wuv: number[] = [];
  const quad = (a: Vec2, bb: Vec2, u0: number, u1: number) => {
    const v = h / TILE_WALL;
    wp.push(a.x, 0, -a.y, bb.x, 0, -bb.y, bb.x, h, -bb.y, a.x, 0, -a.y, bb.x, h, -bb.y, a.x, h, -a.y);
    wuv.push(u0, 0, u1, 0, u1, v, u0, 0, u1, v, u0, v);
  };
  let u = 0;
  for (let i = 0; i < fp.length; i++) {
    const a = fp[i];
    const bb = fp[(i + 1) % fp.length];
    const l = dist(a, bb) / TILE_WALL;
    quad(a, bb, u, u + l);
    u += l;
  }

  const rp: number[] = [];
  const ruv: number[] = [];
  const tri = (pts: THREE.Vector3[], target: number[], uvs: number[], uvOf: (p: THREE.Vector3) => [number, number]) => {
    for (const p of pts) {
      target.push(p.x, p.y, p.z);
      uvs.push(...uvOf(p));
    }
  };
  const top = (p: Vec2, y = h) => new THREE.Vector3(p.x, y, -p.y);
  const roofH = b.roofHeight ?? 0;

  if (b.roof && b.roof !== 'flat' && fp.length === 4 && roofH > 0) {
    // Firstrichtung entlang der längeren Seite
    let [A, B, C, D] = fp;
    if (dist(A, B) < dist(B, C)) [A, B, C, D] = [B, C, D, A];
    const len = dist(A, B);
    const short = dist(B, C);
    const ax = { x: (B.x - A.x) / len, y: (B.y - A.y) / len };
    const inset = b.roof === 'hipped' ? Math.min(short / 2, len / 2 - 0.5) : 0;
    const m1 = { x: (D.x + A.x) / 2 + ax.x * inset, y: (D.y + A.y) / 2 + ax.y * inset };
    const m2 = { x: (B.x + C.x) / 2 - ax.x * inset, y: (B.y + C.y) / 2 - ax.y * inset };
    const R1 = top(m1, h + roofH);
    const R2 = top(m2, h + roofH);
    const roofUv = (p: THREE.Vector3): [number, number] => {
      const q = { x: p.x, y: -p.z };
      return [(q.x * ax.x + q.y * ax.y) / TILE_ROOF, (p.y + Math.abs(-q.x * ax.y + q.y * ax.x)) / TILE_ROOF];
    };
    // Dachflächen
    tri([top(A), top(B), R2, top(A), R2, R1], rp, ruv, roofUv);
    tri([top(C), top(D), R1, top(C), R1, R2], rp, ruv, roofUv);
    if (b.roof === 'hipped') {
      tri([top(D), top(A), R1], rp, ruv, roofUv);
      tri([top(B), top(C), R2], rp, ruv, roofUv);
    } else {
      // Giebeldreiecke gehören zur Wand
      const wallUv = (p: THREE.Vector3): [number, number] => [(p.x + p.z) / TILE_WALL, p.y / TILE_WALL];
      tri([top(D), top(A), R1], wp, wuv, wallUv);
      tri([top(B), top(C), R2], wp, wuv, wallUv);
    }
  } else {
    const contour = fp.map((p) => new THREE.Vector2(p.x, p.y));
    for (const t of THREE.ShapeUtils.triangulateShape(contour, [])) {
      tri(
        t.map((i) => top(fp[i])),
        rp,
        ruv,
        (p) => [p.x / 6, p.z / 6],
      );
    }
  }

  const make = (pos: number[], uv: number[], tint: THREE.Color) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: pos.length / 3 }).flatMap(() => [tint.r, tint.g, tint.b]), 3));
    g.computeVertexNormals();
    return g;
  };
  const flatRoof = !(b.roof && b.roof !== 'flat' && fp.length === 4 && roofH > 0);
  return {
    wall: make(wp, wuv, wallTint),
    roof: rp.length ? make(rp, ruv, flatRoof ? new THREE.Color(0x77777a) : roofTint) : undefined,
  };
}
