import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { headingAt, pointAt, type Course } from '../osm/course';
import type { Assets } from './assets';
import type { Obstacle, ObstacleKind } from './obstacles';
import { buzz, sound } from './audio';
import { BALL_RADIUS, launchSpeed, type ThrowResult } from './physics';
import { w3, World } from './world';

/**
 * Die 3D-Ansicht: Landschaft (`World`), zwei Kugeln und die werfende Figur (Quaternius,
 * mit Lauf-Animation; der Unterhandwurf wird über den Armknochen gesteuert).
 */

const SKY = 0xb4d3ec;

type Mode = 'idle' | 'intro' | 'aim' | 'runup' | 'flight' | 'settle';

const RUN = 0.95;
const TRAIL = 50;
const SWING = 0.34;

export class Thrower {
  readonly root = new THREE.Group();
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions: Record<'idle' | 'run' | 'stand', THREE.AnimationAction>;
  private current: THREE.AnimationAction;
  private readonly shirts: THREE.MeshStandardMaterial[] = [];
  readonly upperArm: THREE.Bone;
  readonly lowerArm: THREE.Bone;
  readonly wrist: THREE.Bone;

  constructor(assets: Assets) {
    const model = cloneSkinned(assets.character.scene);
    model.rotation.y = Math.PI; // Modell schaut nach +Z, unsere Figuren nach −Z
    model.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.castShadow = true;
      o.frustumCulled = false;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const copies = mats.map((m) => {
        const c = (m as THREE.MeshStandardMaterial).clone();
        if (c.name === 'LightBrown') this.shirts.push(c); // das Shirt
        return c;
      });
      o.material = Array.isArray(o.material) ? copies : copies[0];
    });
    this.root.add(model);
    // GLTFLoader entfernt Punkte aus Knotennamen: „UpperArm.R“ heißt hier „UpperArmR“
    const bone = (name: string) => model.getObjectByName(name) as THREE.Bone;
    this.upperArm = bone('UpperArmR');
    this.lowerArm = bone('LowerArmR');
    this.wrist = bone('WristR');
    this.mixer = new THREE.AnimationMixer(model);
    const clip = (name: string) => this.mixer.clipAction(THREE.AnimationClip.findByName(assets.character.animations, `CharacterArmature|${name}`)!);
    this.actions = { idle: clip('Idle'), run: clip('Run'), stand: clip('Idle_Neutral') };
    this.actions.run.timeScale = 1.35;
    this.current = this.actions.idle;
    this.current.play();
  }

  setColor(color: string): void {
    for (const m of this.shirts) m.color.set(color).multiplyScalar(0.6);
  }

  play(name: 'idle' | 'run' | 'stand', fade = 0.15): void {
    const next = this.actions[name];
    if (next === this.current) return;
    next.reset().play();
    this.current.crossFadeTo(next, fade, false);
    this.current = next;
  }

  update(dt: number): void {
    this.mixer.update(dt);
    this.root.updateMatrixWorld(true);
  }

  /**
   * Wurfarm ausrichten: `angle` 0 = senkrecht nach unten, positiv = nach hinten,
   * negativ = nach vorn (in Blickrichtung).
   */
  swingArm(angle: number): void {
    const local = new THREE.Vector3(0.12, -Math.cos(angle), Math.sin(angle)).normalize();
    const world = local.applyQuaternion(this.root.getWorldQuaternion(new THREE.Quaternion()));
    for (const bone of [this.upperArm, this.lowerArm]) {
      bone.updateWorldMatrix(true, false);
      const wq = bone.getWorldQuaternion(new THREE.Quaternion());
      const cur = new THREE.Vector3(0, 1, 0).applyQuaternion(wq);
      const target = wq.clone().premultiply(new THREE.Quaternion().setFromUnitVectors(cur, world));
      const parent = bone.parent!.getWorldQuaternion(new THREE.Quaternion());
      bone.quaternion.copy(parent.invert().multiply(target));
      bone.updateWorldMatrix(false, true);
    }
  }

  handPosition(target: THREE.Vector3): THREE.Vector3 {
    return this.wrist.getWorldPosition(target);
  }
}

/** Geräusche und Vibrationen eines Wurfs, zeitlich an die Bildfolge gebunden. */
function soundEvents(r: ThrowResult): { frame: number; play: () => void }[] {
  const out: { frame: number; play: () => void }[] = [];
  const f = r.frames;
  for (let i = 1; i < f.length; i++) {
    const vz = (f[i - 1].z - f[i].z) * 60;
    if (f[i].z <= 0.001 && f[i - 1].z > 0.001 && vz > 0.3) {
      out.push({ frame: i, play: () => (sound.bounce(vz / 4), buzz(Math.min(25, 5 + vz * 4))) });
    }
  }
  for (const h of r.hits) {
    const play =
      h.kind === 'puddle' ? () => (sound.splash(), buzz(30)) : h.kind === 'stone' ? () => (sound.clack(), buzz(40)) : () => (sound.bounce(1), buzz(50));
    out.push({ frame: h.frame, play });
  }
  if (r.outcome === 'ditch') out.push({ frame: f.length - 12, play: () => (sound.splash(), buzz(120)) });
  return out.sort((a, b) => a.frame - b.frame);
}

export class Scene3D {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1400);
  private readonly sun = new THREE.DirectionalLight(0xfff2dc, 2.2);
  private readonly world: World;
  private readonly balls: THREE.Mesh[] = [];
  private readonly markers: THREE.Mesh[] = [];
  private readonly blobs: THREE.Mesh[] = [];
  private readonly thrower: Thrower;
  private readonly aimArrow: THREE.Mesh;
  private mode: Mode = 'idle';
  private readonly timer = new THREE.Timer();
  private time = 0;
  private speed = 1;
  private disposed = false;

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
  private ballInHand = false;
  private readonly particles: { mesh: THREE.Mesh; v: THREE.Vector3; life: number }[] = [];
  private readonly particleGeo = new THREE.SphereGeometry(0.03, 5, 4);
  private nextHit = 0;
  private nextSound = 0;
  private throwPower = 0;
  private sounds: { frame: number; play: () => void }[] = [];
  private readonly trail: THREE.Line;
  private readonly trailPoints: THREE.Vector3[] = [];
  private onIntroDone: (() => void) | null = null;
  private perf = { frames: 0, time: 0, done: false };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly course: Course,
    assets: Assets,
    teamColors: [string, string],
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 150, 700);

    this.scene.add(new THREE.HemisphereLight(0xdcefff, 0x6a7a4a, 1.4));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.03;
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -45;
    sc.right = sc.top = 45;
    sc.near = 1;
    sc.far = 300;
    this.scene.add(this.sun, this.sun.target);

    this.world = new World(this.scene, course, assets);

    for (const color of teamColors) {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS, 20, 14), new THREE.MeshStandardMaterial({ color, roughness: 0.4 }));
      ball.castShadow = true;
      ball.visible = false;
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

    this.thrower = new Thrower(assets);
    this.scene.add(this.thrower.root);

    this.aimArrow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.18, 1).rotateX(-Math.PI / 2).translate(0, 0.06, -0.5),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    this.aimArrow.visible = false;
    this.scene.add(this.aimArrow);

    // Flugspur hinter der Kugel
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(TRAIL * 3), 3));
    this.trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
    this.trail.frustumCulled = false;
    this.trail.visible = false;
    this.scene.add(this.trail);

    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  dispose(): void {
    this.disposed = true;
    sound.rolling(0);
    this.renderer.setAnimationLoop(null);
    // Geteilte Modelle und Texturen (Assets) bleiben für die nächste Partie erhalten
    this.renderer.dispose();
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w < h ? 70 : 55;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- Steuerung von außen

  private spotOf(rest: { s: number; d: number }): THREE.Vector3 {
    const at = pointAt(this.course, rest.s);
    const h = headingAt(this.course, rest.s);
    return w3({ x: at.p.x - h.y * rest.d, y: at.p.y + h.x * rest.d });
  }

  setBall(team: number, rest: { s: number; d: number }): void {
    this.balls[team].position.copy(this.spotOf(rest)).setY(BALL_RADIUS);
  }

  hideBall(team: number, hidden: boolean): void {
    this.balls[team].visible = !hidden;
  }

  setObstacles(list: Obstacle[]): void {
    this.world.addObstacles(list);
  }

  /** Spritzer (Pfütze) oder Splitt (Stein, Schlagloch) an der Kugel. */
  private burst(at: THREE.Vector3, kind: ObstacleKind): void {
    const color = kind === 'puddle' ? 0xcfe4f2 : 0x7a746c;
    const n = kind === 'puddle' ? 22 : 10;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(this.particleGeo, mat);
      mesh.position.copy(at);
      const a = Math.random() * Math.PI * 2;
      const sp = kind === 'puddle' ? 1 + Math.random() * 2 : 0.5 + Math.random();
      this.particles.push({ mesh, v: new THREE.Vector3(Math.cos(a) * sp, 1.5 + Math.random() * 2.5, Math.sin(a) * sp), life: 0.8 });
      this.scene.add(mesh);
    }
  }

  private updateParticles(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      p.v.y -= 9.81 * dt;
      p.mesh.position.addScaledVector(p.v, dt);
      if (p.life <= 0 || p.mesh.position.y < -0.1) {
        this.scene.remove(p.mesh);
        this.particles.splice(i, 1);
      }
    }
  }

  /** Werfer an seine Kugel stellen und die Kamera hinter ihn setzen. */
  aim(team: number, color: string, rest: { s: number; d: number }): void {
    this.activeBall = team;
    this.thrower.setColor(color);
    const h = headingAt(this.course, rest.s);
    this.throwSpot.copy(this.spotOf(rest));
    this.throwDir.set(h.x, 0, -h.y);
    this.throwRight.set(h.y, 0, h.x);
    this.balls[team].visible = true;
    this.ballInHand = true;
    this.thrower.play('idle', 0.3);
    this.placeFigure(-4, 0, 0);
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
  playThrow(result: ThrowResult, power: number, onDone: () => void): void {
    this.result = result;
    this.throwPower = power;
    this.onThrowDone = onDone;
    this.mode = 'runup';
    this.time = 0;
    this.flightTime = 0;
    this.settleTime = 0;
    this.nextHit = 0;
    this.aimArrow.visible = false;
    this.thrower.play('run', 0.12);
    this.trailPoints.length = 0;
    this.sounds = soundEvents(result);
    this.nextSound = 0;
  }

  /** Streckenflug zum Start: von oben die ganze Strecke entlang, Antippen überspringt. */
  intro(onDone: () => void): void {
    this.mode = 'intro';
    this.time = 0;
    this.onIntroDone = onDone;
  }

  private flyover(): void {
    const c = this.course;
    const duration = Math.max(4, Math.min(9, c.length / 350));
    const k = Math.min(1, this.time / duration);
    const e = k * k * (3 - 2 * k);
    const s = e * c.length;
    const p = w3(pointAt(c, s).p);
    const dir = headingAt(c, s, 60);
    const d3 = new THREE.Vector3(dir.x, 0, -dir.y);
    this.camera.position.copy(p).addScaledVector(d3, -70).setY(55 - 25 * e);
    this.camLook.copy(w3(pointAt(c, Math.min(c.length, s + 120)).p));
    if (k >= 1) this.endIntro();
  }

  private endIntro(): void {
    if (this.mode !== 'intro') return;
    this.mode = 'idle';
    const done = this.onIntroDone;
    this.onIntroDone = null;
    done?.();
  }

  /** Antippen während des Flugs: schneller vorspulen. */
  fastForward(): void {
    if (this.mode === 'intro') this.endIntro();
    if (this.mode === 'flight' || this.mode === 'settle') this.speed = 4;
  }

  // ---------------------------------------------------------------- Animation

  private placeFigure(back: number, crouch: number, lean: number): void {
    const r = this.thrower.root;
    // Die Wurfhand (rechts) läuft beim Abwurf genau über die Kugel
    r.position.copy(this.throwSpot).addScaledVector(this.throwDir, back).addScaledVector(this.throwRight, -0.22);
    r.position.y = -crouch;
    r.rotation.set(lean, Math.atan2(-this.throwDir.x, -this.throwDir.z), 0, 'YXZ');
  }

  private frame(): void {
    if (this.disposed) return;
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.05);
    this.time += dt;
    const t = this.thrower;

    if (this.mode === 'intro') {
      t.update(dt);
      this.flyover();
    } else if (this.mode === 'aim') {
      this.adaptQuality(dt);
      this.placeFigure(-4, 0, 0);
      t.update(dt);
      this.overShoulder();
    } else if (this.mode === 'runup') {
      const tt = this.time;
      if (tt < RUN) {
        const k = tt / RUN;
        this.placeFigure(-4 + 3.7 * k * (2 - k), 0, 0);
        t.update(dt);
        // im Laufen weit nach hinten ausholen
        if (k > 0.45) t.swingArm(2.2 * ((k - 0.45) / 0.55));
      } else {
        const k = Math.min(1, (tt - RUN) / SWING);
        if (k < 0.1) t.play('stand', 0.1);
        this.placeFigure(-0.3 + 0.3 * k, 0.4 * Math.sin(Math.min(1, k * 1.3) * Math.PI * 0.5), -0.3 * k);
        t.update(dt);
        t.swingArm(2.2 - 3.0 * k);
        if (k >= 1) {
          this.mode = 'flight';
          this.flightTime = 0;
          this.ballInHand = false;
          this.chaseDir.copy(this.throwDir);
          sound.whoosh(this.throwPower);
        }
      }
      this.overShoulder();
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
      while (this.nextHit < r.hits.length && r.hits[this.nextHit].frame <= fi) this.burst(ball.position, r.hits[this.nextHit++].kind);
      while (this.nextSound < this.sounds.length && this.sounds[this.nextSound].frame <= fi) this.sounds[this.nextSound++].play();
      // Rollgeräusch nach Tempo, nur am Boden
      const v = Math.hypot(b.x - a.x, b.y - a.y) * 60;
      sound.rolling(a.z < 0.01 && this.mode === 'flight' ? v : 0);
      this.updateTrail(ball.position);
      const vel = new THREE.Vector3(b.x - a.x, 0, -(b.y - a.y));
      if (vel.lengthSq() > 1e-6) this.chaseDir.lerp(vel.normalize(), 1 - Math.exp(-dt * 4)).normalize();
      // Figur bleibt kurz in der Abwurfhaltung, dann steht sie auf
      const after = this.flightTime / this.speed;
      if (after > 0.6) t.play('idle', 0.5);
      this.placeFigure(0, after < 0.6 ? 0.4 * (1 - after / 0.6) : 0, after < 0.6 ? -0.3 * (1 - after / 0.6) : 0);
      t.update(dt);
      if (after < 0.6) t.swingArm(-0.8 - 0.4 * (after / 0.6));
      this.chase(ball.position, dt);
      if (fi >= r.frames.length - 1) {
        if (this.mode === 'flight') {
          this.mode = 'settle';
          this.settleTime = 0;
          sound.rolling(0);
        }
        this.settleTime += dt * this.speed;
        if (this.settleTime > 1.3) {
          this.mode = 'idle';
          this.trail.visible = false;
          const done = this.onThrowDone;
          this.onThrowDone = null;
          done?.();
        }
      }
    } else {
      t.update(dt);
    }

    if (this.ballInHand) {
      const ball = this.balls[this.activeBall];
      t.handPosition(ball.position);
      ball.position.addScaledVector(this.throwDir, 0.04).y -= 0.06;
    }

    this.updateParticles(dt * this.speed);
    this.updateMarkers();
    this.world.update(this.camera.position);
    // Schatten folgen dem Blickpunkt
    this.sun.target.position.copy(this.camLook);
    this.sun.position.copy(this.camLook).add(new THREE.Vector3(50, 90, 35));
    this.camera.lookAt(this.camLook);
    this.renderer.render(this.scene, this.camera);
  }

  private updateTrail(at: THREE.Vector3): void {
    const last = this.trailPoints[this.trailPoints.length - 1];
    if (!last || last.distanceToSquared(at) > 0.04) this.trailPoints.push(at.clone());
    if (this.trailPoints.length > TRAIL) this.trailPoints.shift();
    const attr = this.trail.geometry.attributes.position as THREE.BufferAttribute;
    this.trailPoints.forEach((p, i) => attr.setXYZ(i, p.x, p.y, p.z));
    attr.needsUpdate = true;
    this.trail.geometry.setDrawRange(0, this.trailPoints.length);
    this.trail.visible = this.trailPoints.length > 1;
  }

  /**
   * Läuft es zu langsam (schwaches Handy), einmalig die Auflösung und die Schattenkarte
   * verkleinern. Gemessen wird in den ersten Sekunden des Zielens.
   */
  private adaptQuality(dt: number): void {
    const p = this.perf;
    if (p.done) return;
    p.frames++;
    p.time += dt;
    if (p.frames < 90) return;
    p.done = true;
    if (p.time / p.frames < 1 / 38) return;
    this.renderer.setPixelRatio(1);
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.resize();
  }

  /** Blick über die linke Schulter, damit der Wurfarm rechts im Bild bleibt. */
  private overShoulder(): void {
    const at = this.thrower.root.position;
    this.camera.position.copy(at).addScaledVector(this.throwDir, -3.2).addScaledVector(this.throwRight, -0.8).setY(2.2);
    this.camLook.copy(this.throwSpot).addScaledVector(this.throwDir, 30).setY(0.3);
  }

  private chase(ball: THREE.Vector3, dt: number): void {
    const target = ball.clone().addScaledVector(this.chaseDir, -6.5);
    target.y = Math.max(ball.y, 0) + 2.3;
    const k = 1 - Math.exp(-dt * 3.5 * this.speed);
    this.camera.position.lerp(target, k);
    const look = ball.clone().addScaledVector(this.chaseDir, 4);
    this.camLook.lerp(look, Math.min(1, k * 1.5));
  }

  private updateMarkers(): void {
    const cam = this.camera.position;
    this.balls.forEach((ball, i) => {
      const marker = this.markers[i];
      const blob = this.blobs[i];
      const d = cam.distanceTo(ball.position);
      const held = this.ballInHand && i === this.activeBall;
      marker.visible = ball.visible && d > 6 && !held;
      const s = Math.max(0.4, Math.min(8, d * 0.03));
      marker.scale.setScalar(s);
      marker.position.set(ball.position.x, ball.position.y + 0.4 + s * 0.6 + Math.sin(this.time * 3 + i) * 0.1 * s, ball.position.z);
      blob.visible = ball.visible && ball.position.y > -0.1 && !held;
      blob.position.set(ball.position.x, 0.05, ball.position.z);
      const lift = Math.max(0, ball.position.y - BALL_RADIUS);
      (blob.material as THREE.MeshBasicMaterial).opacity = Math.max(0.05, 0.35 - lift * 0.25);
    });
  }
}
