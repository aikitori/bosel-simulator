import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { TreeKind } from '../osm/course';

/**
 * Modelle (Quaternius, CC0) und Texturen (Poly Haven, CC0) – siehe CREDITS.md.
 * Wird einmal geladen und dann für jede Partie wiederverwendet.
 */

export type TextureName = 'asphalt' | 'klinker' | 'gravel' | 'dirt' | 'grass' | 'field' | 'brick' | 'plaster' | 'roof';

/** Teil eines Modells, fertig für ein InstancedMesh. */
export interface Part {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  /** Lage des Teils im normierten Modell (Fuß auf y = 0, Zielgröße). */
  matrix: THREE.Matrix4;
}

export interface Assets {
  character: GLTF;
  trees: Record<TreeKind, Part[]>;
  cow: Part[];
  sheep: Part[];
  textures: Record<TextureName, THREE.Texture>;
}

/** Typische Höhe in Metern, auf die jedes Modell gebracht wird. */
const TREE_HEIGHT: Record<TreeKind, number> = { birch: 11, round: 9, poplar: 17, oak: 12, bush: 1.8 };

const TEXTURES: TextureName[] = ['asphalt', 'klinker', 'gravel', 'dirt', 'grass', 'field', 'brick', 'plaster', 'roof'];

let cache: Promise<Assets> | null = null;

export function loadAssets(): Promise<Assets> {
  cache ??= load().catch((e) => {
    cache = null;
    throw e;
  });
  return cache;
}

function parts(root: THREE.Object3D, height: number, lengthAxis = false): Part[] {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const k = height / (lengthAxis ? Math.max(size.x, size.z) : size.y);
  const norm = new THREE.Matrix4()
    .makeScale(k, k, k)
    .multiply(new THREE.Matrix4().makeTranslation(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2));
  const out: Part[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) out.push({ geometry: o.geometry, material: o.material, matrix: norm.clone().multiply(o.matrixWorld) });
  });
  return out;
}

async function load(): Promise<Assets> {
  const loader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  const glb = (name: string) => loader.loadAsync(`./models/${name}.glb`);
  const [character, birch, round, poplar, oak, bush, cow, sheep, ...tex] = await Promise.all([
    glb('character'),
    glb('tree-birch'),
    glb('tree-round'),
    glb('tree-poplar'),
    glb('tree-oak'),
    glb('bush'),
    glb('cow'),
    glb('sheep'),
    ...TEXTURES.map((t) => texLoader.loadAsync(`./textures/${t}.jpg`)),
  ]);
  const textures = {} as Record<TextureName, THREE.Texture>;
  TEXTURES.forEach((name, i) => {
    const t = tex[i] as THREE.Texture;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    textures[name] = t;
  });
  const scene = (g: unknown) => (g as GLTF).scene;
  return {
    character: character as GLTF,
    trees: {
      birch: parts(scene(birch), TREE_HEIGHT.birch),
      round: parts(scene(round), TREE_HEIGHT.round),
      poplar: parts(scene(poplar), TREE_HEIGHT.poplar),
      oak: parts(scene(oak), TREE_HEIGHT.oak),
      bush: parts(scene(bush), TREE_HEIGHT.bush),
    },
    cow: parts(scene(cow), 2.3, true),
    sheep: parts(scene(sheep), 1.3, true),
    textures,
  };
}
