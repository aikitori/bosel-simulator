import * as THREE from 'three';
import { mulberry32 } from './physics';

/** Kleine prozedurale Texturen, damit das Spiel ohne Bilddateien auskommt. */

function noiseCanvas(size: number, base: [number, number, number], spread: number, seed: number, specks = 0) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const rand = mulberry32(seed);
  for (let i = 0; i < size * size; i++) {
    const n = (rand() - 0.5) * spread;
    img.data[i * 4] = base[0] + n;
    img.data[i * 4 + 1] = base[1] + n;
    img.data[i * 4 + 2] = base[2] + n;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  for (let i = 0; i < specks; i++) {
    const v = 150 + rand() * 80;
    ctx.fillStyle = `rgba(${v},${v},${v},0.5)`;
    ctx.fillRect(rand() * size, rand() * size, 1 + rand() * 2, 1 + rand() * 2);
  }
  return c;
}

function repeatTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Helles Grau mit Körnung – wird per Vertexfarbe zu Asphalt, Klinker, Schotter … eingefärbt. */
export function roadTexture(): THREE.CanvasTexture {
  return repeatTexture(noiseCanvas(128, [200, 200, 200], 60, 3, 120));
}

export function grassTexture(): THREE.CanvasTexture {
  const c = noiseCanvas(256, [110, 160, 70], 40, 5);
  const ctx = c.getContext('2d')!;
  const rand = mulberry32(9);
  for (let i = 0; i < 1400; i++) {
    const g = 120 + rand() * 70;
    ctx.strokeStyle = `rgba(${g * 0.6},${g},${g * 0.4},0.6)`;
    const x = rand() * 256;
    const y = rand() * 256;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rand() - 0.5) * 3, y - 2 - rand() * 4);
    ctx.stroke();
  }
  return repeatTexture(c);
}

/** Schriftzug als Textur (Zielbanner, Entfernungstafeln). */
export function labelTexture(text: string, bg: string, fg: string, w = 512, h = 128): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = fg;
  ctx.font = `bold ${Math.round(h * 0.62)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + h * 0.04);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
