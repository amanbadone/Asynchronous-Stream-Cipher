import * as THREE from 'three';

export type BitVisualMode =
  | 'cipher'
  | 'corrupt'
  | 'plain_ok'
  | 'plain_err'
  | 'key_ok'
  | 'key_err'
  | 'reg_ok'
  | 'reg_sync'
  | 'reg_corrupt';

export interface TextPlaneOptions {
  cw?: number;
  ch?: number;
  font?: string;
  color?: string;
  bg?: string;
  border?: string;
  radius?: number;
  letterSpacing?: number;
}

export interface TextPlaneMesh extends THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
  userData: {
    ctx: CanvasRenderingContext2D;
    canvas: HTMLCanvasElement;
    tex: THREE.CanvasTexture;
    opts: TextPlaneOptions;
    lastText?: string;
    lastColor?: string;
  };
}

export interface BitStyleSpec {
  bg: string;
  bgInner: string;
  border: string;
  text: string;
  emissive: number;
  emissiveIntensity: number;
  rimColor: number;
}

export const BIT_STYLES: Record<BitVisualMode, BitStyleSpec> = {
  cipher: {
    bg: '#083352',
    bgInner: '#0c4a6e',
    border: '#38bdf8',
    text: '#f0f9ff',
    emissive: 0x0284c7,
    emissiveIntensity: 0.32,
    rimColor: 0x38bdf8,
  },
  corrupt: {
    bg: '#5f1116',
    bgInner: '#991b1b',
    border: '#fca5a5',
    text: '#fef2f2',
    emissive: 0xef4444,
    emissiveIntensity: 0.85,
    rimColor: 0xf87171,
  },
  plain_ok: {
    bg: '#053a2d',
    bgInner: '#065f46',
    border: '#34d399',
    text: '#ecfdf5',
    emissive: 0x10b981,
    emissiveIntensity: 0.34,
    rimColor: 0x34d399,
  },
  plain_err: {
    bg: '#5f1116',
    bgInner: '#991b1b',
    border: '#f87171',
    text: '#fef2f2',
    emissive: 0xef4444,
    emissiveIntensity: 0.72,
    rimColor: 0xf87171,
  },
  key_ok: {
    bg: '#5c2809',
    bgInner: '#92400e',
    border: '#fbbf24',
    text: '#fffbeb',
    emissive: 0xd97706,
    emissiveIntensity: 0.36,
    rimColor: 0xfbbf24,
  },
  key_err: {
    bg: '#651e0f',
    bgInner: '#9a3412',
    border: '#fb923c',
    text: '#fff7ed',
    emissive: 0xef4444,
    emissiveIntensity: 0.65,
    rimColor: 0xfb923c,
  },
  reg_ok: {
    bg: '#0b2238',
    bgInner: '#123454',
    border: '#38bdf8',
    text: '#e0f2fe',
    emissive: 0x0284c7,
    emissiveIntensity: 0.24,
    rimColor: 0x38bdf8,
  },
  reg_sync: {
    bg: '#053a2d',
    bgInner: '#065f46',
    border: '#34d399',
    text: '#ecfdf5',
    emissive: 0x10b981,
    emissiveIntensity: 0.42,
    rimColor: 0x34d399,
  },
  reg_corrupt: {
    bg: '#631015',
    bgInner: '#991b1b',
    border: '#fecaca',
    text: '#ffffff',
    emissive: 0xef4444,
    emissiveIntensity: 0.92,
    rimColor: 0xfca5a5,
  },
};

export class ProceduralAssetLibrary {
  private readonly maxAnisotropy: number;
  private readonly bitTextures = new Map<string, THREE.CanvasTexture>();
  private readonly disposableTextures: THREE.Texture[] = [];

  constructor(maxAnisotropy: number) {
    this.maxAnisotropy = maxAnisotropy;
  }

  getBitTexture(digit: number, mode: BitVisualMode): THREE.CanvasTexture {
    const key = `${digit}_${mode}`;
    const cached = this.bitTextures.get(key);
    if (cached) return cached;

    const style = BIT_STYLES[mode];
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    // Brushed metallic-glass gradient base
    const grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, style.bgInner);
    grad.addColorStop(1, style.bg);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // Subtle precision inner bevel frame
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 4;
    ctx.strokeRect(24, 24, size - 48, size - 48);

    // Outer technical border
    ctx.strokeStyle = style.border;
    ctx.lineWidth = 14;
    ctx.strokeRect(7, 7, size - 14, size - 14);

    // Corner precision ticks
    ctx.fillStyle = style.border;
    const tick = 18;
    ctx.fillRect(16, 16, tick, 4);
    ctx.fillRect(16, 16, 4, tick);
    ctx.fillRect(size - 16 - tick, 16, tick, 4);
    ctx.fillRect(size - 20, 16, 4, tick);
    ctx.fillRect(16, size - 20, tick, 4);
    ctx.fillRect(16, size - 16 - tick, 4, tick);
    ctx.fillRect(size - 16 - tick, size - 20, tick, 4);
    ctx.fillRect(size - 20, size - 16 - tick, 4, tick);

    // Crisp numeral
    ctx.fillStyle = style.text;
    ctx.font = '700 138px "IBM Plex Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(digit), size / 2, size / 2 + 5);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.maxAnisotropy;
    this.bitTextures.set(key, tex);
    this.disposableTextures.push(tex);
    return tex;
  }

  createDeckTexture(accentHex: string): THREE.CanvasTexture {
    const w = 1024;
    const h = 512;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;

    // Dark brushed slate base
    ctx.fillStyle = '#0e1628';
    ctx.fillRect(0, 0, w, h);

    // Subtle horizontal brushed-metal micro-grain
    for (let y = 0; y < h; y += 3) {
      ctx.fillStyle = y % 6 === 0 ? 'rgba(255,255,255,0.018)' : 'rgba(0,0,0,0.025)';
      ctx.fillRect(0, y, w, 1);
    }

    // Subtle engineering grid lines
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
    ctx.lineWidth = 1;
    for (let x = 32; x < w; x += 64) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 32; y < h; y += 64) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Circuit trace accents
    ctx.strokeStyle = accentHex;
    ctx.globalAlpha = 0.28;
    ctx.lineWidth = 3;
    ctx.strokeRect(20, 20, w - 40, h - 40);

    ctx.beginPath();
    ctx.moveTo(64, h - 56);
    ctx.lineTo(w * 0.35, h - 56);
    ctx.lineTo(w * 0.4, h - 96);
    ctx.lineTo(w - 64, h - 96);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(80, 64);
    ctx.lineTo(w * 0.62, 64);
    ctx.lineTo(w * 0.66, 98);
    ctx.lineTo(w - 80, 98);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.maxAnisotropy;
    this.disposableTextures.push(tex);
    return tex;
  }

  createFloorGridTexture(): THREE.CanvasTexture {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    ctx.fillStyle = '#090f1d';
    ctx.fillRect(0, 0, size, size);

    // Minor subdivisions
    ctx.strokeStyle = 'rgba(51, 65, 85, 0.24)';
    ctx.lineWidth = 1;
    const sub = size / 4;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(i * sub, 0);
      ctx.lineTo(i * sub, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i * sub);
      ctx.lineTo(size, i * sub);
      ctx.stroke();
    }

    // Major perimeter
    ctx.strokeStyle = 'rgba(71, 85, 105, 0.48)';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, size, size);

    // Tiny intersection crosshair
    ctx.fillStyle = 'rgba(148, 163, 184, 0.35)';
    ctx.fillRect(0, 0, 5, 5);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(22, 16);
    tex.anisotropy = this.maxAnisotropy;
    this.disposableTextures.push(tex);
    return tex;
  }

  createContactShadowTexture(): THREE.CanvasTexture {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    const grad = ctx.createRadialGradient(
      size / 2,
      size / 2,
      size * 0.12,
      size / 2,
      size / 2,
      size * 0.5
    );
    grad.addColorStop(0, 'rgba(2, 6, 15, 0.85)');
    grad.addColorStop(0.55, 'rgba(2, 6, 15, 0.38)');
    grad.addColorStop(1, 'rgba(2, 6, 15, 0.0)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.disposableTextures.push(tex);
    return tex;
  }

  makeTextPlane(text: string, w: number, h: number, opts: TextPlaneOptions = {}): TextPlaneMesh {
    const canvas = document.createElement('canvas');
    canvas.width = opts.cw ?? 512;
    canvas.height = opts.ch ?? 128;
    const ctx = canvas.getContext('2d')!;
    drawLabelCanvas(ctx, canvas.width, canvas.height, text, opts);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.maxAnisotropy;
    this.disposableTextures.push(tex);

    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat) as TextPlaneMesh;
    mesh.userData = {
      ctx,
      canvas,
      tex,
      opts,
      lastText: text,
      lastColor: opts.color,
    };
    return mesh;
  }

  updateTextPlane(mesh: TextPlaneMesh, text: string, optsOverride: TextPlaneOptions = {}): void {
    const nextColor = optsOverride.color ?? mesh.userData.opts.color;
    if (mesh.userData.lastText === text && mesh.userData.lastColor === nextColor) {
      return;
    }
    const merged: TextPlaneOptions = { ...mesh.userData.opts, ...optsOverride };
    drawLabelCanvas(
      mesh.userData.ctx,
      mesh.userData.canvas.width,
      mesh.userData.canvas.height,
      text,
      merged
    );
    mesh.userData.tex.needsUpdate = true;
    mesh.userData.lastText = text;
    mesh.userData.lastColor = nextColor;
  }

  dispose(): void {
    for (const tex of this.disposableTextures) {
      tex.dispose();
    }
    this.disposableTextures.length = 0;
    this.bitTextures.clear();
  }
}

function drawLabelCanvas(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  text: string,
  opts: TextPlaneOptions
): void {
  ctx.clearRect(0, 0, cw, ch);
  const r = opts.radius ?? 16;

  if (opts.bg) {
    ctx.fillStyle = opts.bg;
    ctx.beginPath();
    ctx.roundRect(4, 4, cw - 8, ch - 8, r);
    ctx.fill();
  }
  if (opts.border) {
    ctx.strokeStyle = opts.border;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(4, 4, cw - 8, ch - 8, r);
    ctx.stroke();
  }

  ctx.fillStyle = opts.color ?? '#e2e8f0';
  ctx.font = opts.font ?? '700 44px "Plus Jakarta Sans", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cw / 2, ch / 2 + 1);
}
