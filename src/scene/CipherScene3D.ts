import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  DURATION,
  STEPS,
  evaluateSimulationSnapshot,
  type SimulationSnapshot,
} from '../simulation/cipherSimulation';
import {
  BIT_STYLES,
  ProceduralAssetLibrary,
  type BitVisualMode,
  type TextPlaneMesh,
} from './proceduralMaterials';

export type CameraMode = 'auto' | 'orbit';

export interface SceneCallbacks {
  onSnapshot: (snapshot: SimulationSnapshot, isPlaying: boolean) => void;
  onCameraModeChange: (mode: CameraMode) => void;
  onContextLost: (lost: boolean) => void;
}

interface BitToken {
  group: THREE.Group;
  cube: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  rim: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
  lastDigit: number;
  lastMode: BitVisualMode | null;
}

interface RegisterSlot {
  baseX: number;
  cage: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
  pedestalMat: THREE.MeshStandardMaterial;
  token: BitToken;
}

interface StepVisualPool {
  cipherToken: BitToken;
  plainInToken: BitToken;
  keySenderToken: BitToken;
  keyRecToken: BitToken;
  plainOutToken: BitToken;
  outBadge: TextPlaneMesh;
}

const SENDER_REG_X = [-5.3, -6.25, -7.2, -8.15] as const;
const RECEIVER_REG_X = [4.9, 5.85, 6.8, 7.75] as const;
const REG_Y = -1.25;
const FLOOR_Y = -2.85;
const CHANNEL_Y = 2.0;

// Module-scope scratch objects for zero-GC animation loop
const _targetCamPos = new THREE.Vector3();
const _targetLookAt = new THREE.Vector3();
const _upAxis = new THREE.Vector3(0, 1, 0);
const _tmpDir = new THREE.Vector3();

function detectSoftwareGl(): boolean {
  try {
    const probeCanvas = document.createElement('canvas');
    const gl = probeCanvas.getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) ?? '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

function lerp(a: number, b: number, t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return a + (b - a) * c;
}

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

export class CipherScene3D {
  private readonly container: HTMLElement;
  private readonly callbacks: SceneCallbacks;
  private readonly isSoftwareGl: boolean;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly assets: ProceduralAssetLibrary;
  private readonly envRT: THREE.WebGLRenderTarget;
  private readonly resizeObserver: ResizeObserver;

  private readonly senderRegSlots: RegisterSlot[];
  private readonly receiverRegSlots: RegisterSlot[];
  private readonly stepVisuals: StepVisualPool[];

  private readonly senderXorCoreMat: THREE.MeshPhysicalMaterial;
  private readonly receiverXorCoreMat: THREE.MeshPhysicalMaterial;
  private readonly receiverFnBezelMat: THREE.MeshStandardMaterial;
  private readonly receiverFnCoreMat: THREE.MeshStandardMaterial;
  private readonly receiverRailMat: THREE.MeshStandardMaterial;
  private readonly channelCoreMat: THREE.MeshStandardMaterial;

  private readonly noiseGroup: THREE.Group;
  private readonly noiseOuterRing: THREE.Mesh<THREE.TorusGeometry, THREE.MeshStandardMaterial>;
  private readonly noiseInnerRing: THREE.Mesh<THREE.TorusGeometry, THREE.MeshStandardMaterial>;
  private readonly noiseArcLine: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly noiseArcPositions: Float32Array;
  private readonly noisePointLight: THREE.PointLight;
  private readonly noiseLabel: TextPlaneMesh;

  private readonly flushedLabel: TextPlaneMesh;
  private readonly flushedToken: BitToken;

  private simTime = 0;
  private isPlaying = true;
  private playbackSpeed = 1.0;
  private cameraMode: CameraMode = 'auto';
  private isDisposed = false;
  private isContextLost = false;
  private frameId = 0;
  private lastNow = performance.now();
  private lastHudEmit = 0;

  private readonly onContextLostBound: (e: Event) => void;
  private readonly onContextRestoredBound: () => void;

  constructor(container: HTMLElement, callbacks: SceneCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.isSoftwareGl = detectSoftwareGl();

    const width = Math.max(1, container.clientWidth || window.innerWidth);
    const height = Math.max(1, container.clientHeight || window.innerHeight);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x080d18);
    this.scene.fog = new THREE.FogExp2(0x080d18, 0.0135);

    this.camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 120);
    this.camera.position.set(0, 3.0, 18.2);

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    // Studio environment map via RoomEnvironment on every device
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = this.envRT.texture;
    pmrem.dispose();

    this.assets = new ProceduralAssetLibrary(
      this.isSoftwareGl ? 1 : Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
    );

    // OrbitControls for interactive inspection
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = !this.isSoftwareGl;
    this.controls.dampingFactor = 0.07;
    this.controls.minDistance = 8.5;
    this.controls.maxDistance = 30.0;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minPolarAngle = 0.18;
    this.controls.target.set(0, 0.65, 0);
    this.controls.addEventListener('start', () => {
      if (this.cameraMode !== 'orbit') {
        this.cameraMode = 'orbit';
        this.callbacks.onCameraModeChange('orbit');
      }
    });

    // Build studio lighting & stage floor
    this.buildLightingAndStage();

    // Build composite Sender & Receiver platforms
    this.buildStationPlatform(-6.8, 0x38bdf8, '#38bdf8', 'SENDER', 'Encrypts & feeds ciphertext');
    this.receiverRailMat = this.buildStationPlatform(
      6.8,
      0x2dd4bf,
      '#2dd4bf',
      'RECEIVER',
      'Decrypts via feedback register'
    );

    // Build composite XOR gates
    this.senderXorCoreMat = this.buildXorAssembly(-5.1, CHANNEL_Y, 0x38bdf8);
    this.receiverXorCoreMat = this.buildXorAssembly(5.1, CHANNEL_Y, 0x2dd4bf);

    // Build composite Keystream Generator modules f(K, Reg)
    this.buildKeyFnAssembly(-5.1, 0.35);
    const recFn = this.buildKeyFnAssembly(5.1, 0.35);
    this.receiverFnBezelMat = recFn.bezelMat;
    this.receiverFnCoreMat = recFn.coreMat;

    // Build composite 4-bay feedback shift registers
    this.senderRegSlots = this.buildRegisterAssembly(
      SENDER_REG_X,
      'Sender Feedback Register (4 bits)',
      false
    );
    this.receiverRegSlots = this.buildRegisterAssembly(
      RECEIVER_REG_X,
      'Receiver Feedback Register (4 bits)',
      true
    );

    // Build signal pipes, collars & central glass-jacketed channel
    this.channelCoreMat = this.buildSignalConduits();

    // Build channel noise interference unit (Scene 2)
    const noise = this.buildChannelNoiseUnit();
    this.noiseGroup = noise.group;
    this.noiseOuterRing = noise.outerRing;
    this.noiseInnerRing = noise.innerRing;
    this.noiseArcLine = noise.arcLine;
    this.noiseArcPositions = noise.arcPositions;
    this.noisePointLight = noise.pointLight;
    this.noiseLabel = noise.label;

    // Flushed bit ejection visual & callout
    this.flushedLabel = this.assets.makeTextPlane('CORRUPTED BIT FLUSHED!', 3.35, 0.5, {
      cw: 520,
      ch: 78,
      font: '700 32px "Plus Jakarta Sans", sans-serif',
      color: '#a7f3d0',
      bg: 'rgba(6, 78, 59, 0.94)',
      border: '#34d399',
    });
    this.flushedLabel.position.set(7.6, -0.05, 0.72);
    this.flushedLabel.material.opacity = 0;
    this.scene.add(this.flushedLabel);

    this.flushedToken = this.createBitToken(0.56);
    this.styleBitToken(this.flushedToken, 0, 'corrupt');
    this.flushedToken.group.visible = false;
    this.scene.add(this.flushedToken.group);

    // Pre-allocate flying bit cube pools (zero runtime allocations)
    this.stepVisuals = STEPS.map(() => {
      const cipherToken = this.createBitToken(0.58);
      cipherToken.group.visible = false;
      this.scene.add(cipherToken.group);

      const plainInToken = this.createBitToken(0.46);
      plainInToken.group.visible = false;
      this.scene.add(plainInToken.group);

      const keySenderToken = this.createBitToken(0.42);
      keySenderToken.group.visible = false;
      this.scene.add(keySenderToken.group);

      const keyRecToken = this.createBitToken(0.42);
      keyRecToken.group.visible = false;
      this.scene.add(keyRecToken.group);

      const plainOutToken = this.createBitToken(0.50);
      plainOutToken.group.visible = false;
      this.scene.add(plainOutToken.group);

      const outBadge = this.assets.makeTextPlane('✓', 0.54, 0.54, {
        cw: 96,
        ch: 96,
        font: '700 66px "Plus Jakarta Sans", sans-serif',
        color: '#34d399',
      });
      outBadge.visible = false;
      this.scene.add(outBadge);

      return {
        cipherToken,
        plainInToken,
        keySenderToken,
        keyRecToken,
        plainOutToken,
        outBadge,
      };
    });

    // Pre-warm shaders on hardware GPUs
    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    // WebGL context loss safety
    this.onContextLostBound = (e: Event) => {
      e.preventDefault();
      this.isContextLost = true;
      this.callbacks.onContextLost(true);
    };
    this.onContextRestoredBound = () => {
      this.isContextLost = false;
      this.callbacks.onContextLost(false);
    };
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLostBound);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestoredBound);

    // Responsive container observer
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    // Initial state & kick off loop
    const initialSnap = this.updateSimulation(0, 0.016, true);
    this.callbacks.onSnapshot(initialSnap, this.isPlaying);
    this.lastNow = performance.now();
    this.scheduleNextTick();
  }

  private buildLightingAndStage(): void {
    // Cool sky / deep slate ground hemisphere fill
    const hemi = new THREE.HemisphereLight(0x9ec5ff, 0x0b1222, 0.85);
    this.scene.add(hemi);

    // Warm key light with calibrated shadows
    const keyLight = new THREE.DirectionalLight(0xfff3e0, 1.45);
    keyLight.position.set(6, 13, 11);
    if (!this.isSoftwareGl) {
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.set(1024, 1024);
      keyLight.shadow.camera.near = 2;
      keyLight.shadow.camera.far = 36;
      keyLight.shadow.camera.left = -14;
      keyLight.shadow.camera.right = 14;
      keyLight.shadow.camera.top = 10;
      keyLight.shadow.camera.bottom = -8;
      keyLight.shadow.bias = -0.0005;
      keyLight.shadow.normalBias = 0.02;
    }
    this.scene.add(keyLight);

    // Cool cyan rim light from rear-left for crisp hardware edge separation
    const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.72);
    rimLight.position.set(-11, 6, -8);
    this.scene.add(rimLight);

    // Subtle cool right bounce
    const bounceLight = new THREE.DirectionalLight(0x2dd4bf, 0.42);
    bounceLight.position.set(12, 4, -5);
    this.scene.add(bounceLight);

    // Precision drafting studio floor plane
    const floorTex = this.assets.createFloorGridTexture();
    const floorMat = new THREE.MeshStandardMaterial({
      map: floorTex,
      roughness: 0.78,
      metalness: 0.18,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(72, 52), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y;
    floor.receiveShadow = !this.isSoftwareGl;
    this.scene.add(floor);
  }

  private buildStationPlatform(
    x: number,
    colorHex: number,
    cssHex: string,
    title: string,
    subtitle: string
  ): THREE.MeshStandardMaterial {
    const group = new THREE.Group();
    group.position.set(x, 0, 0);

    // Soft contact shadow plane directly above floor (+0.02 Y offset prevents z-fighting)
    const shadowMat = new THREE.MeshBasicMaterial({
      map: this.assets.createContactShadowTexture(),
      transparent: true,
      depthWrite: false,
      opacity: 0.72,
    });
    const contactShadow = new THREE.Mesh(new THREE.PlaneGeometry(8.6, 4.8), shadowMat);
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.position.set(0, FLOOR_Y + 0.02, 0);
    group.add(contactShadow);

    // 4 machined rubberized feet sitting flush on FLOOR_Y (-2.85 to -2.65)
    const footMat = new THREE.MeshStandardMaterial({
      color: 0x0b101d,
      roughness: 0.85,
      metalness: 0.15,
    });
    const footGeo = new THREE.CylinderGeometry(0.24, 0.28, 0.2, 16);
    const footCoords: [number, number][] = [
      [-2.9, -1.25],
      [2.9, -1.25],
      [-2.9, 1.25],
      [2.9, 1.25],
    ];
    for (const [fx, fz] of footCoords) {
      const foot = new THREE.Mesh(footGeo, footMat);
      foot.position.set(fx, FLOOR_Y + 0.1, fz);
      foot.castShadow = !this.isSoftwareGl;
      group.add(foot);
    }

    // Beveled extruded anodized aluminum plinth (y = -2.65 to -2.35)
    const chassisW = 6.7;
    const chassisD = 3.3;
    const shape = new THREE.Shape();
    const hw = chassisW / 2;
    const hd = chassisD / 2;
    const cr = 0.22;
    shape.moveTo(-hw + cr, -hd);
    shape.lineTo(hw - cr, -hd);
    shape.quadraticCurveTo(hw, -hd, hw, -hd + cr);
    shape.lineTo(hw, hd - cr);
    shape.quadraticCurveTo(hw, hd, hw - cr, hd);
    shape.lineTo(-hw + cr, hd);
    shape.quadraticCurveTo(-hw, hd, -hw, hd - cr);
    shape.lineTo(-hw, -hd + cr);
    shape.quadraticCurveTo(-hw, -hd, -hw + cr, -hd);

    const chassisGeo = new THREE.ExtrudeGeometry(shape, {
      depth: 0.22,
      bevelEnabled: true,
      bevelThickness: 0.05,
      bevelSize: 0.05,
      bevelSegments: 2,
    });
    chassisGeo.rotateX(Math.PI / 2);

    const chassisMat = new THREE.MeshStandardMaterial({
      color: 0x162033,
      roughness: 0.34,
      metalness: 0.72,
    });
    const chassis = new THREE.Mesh(chassisGeo, chassisMat);
    chassis.position.set(0, -2.38, 0);
    chassis.castShadow = !this.isSoftwareGl;
    chassis.receiveShadow = !this.isSoftwareGl;
    group.add(chassis);

    // Brushed top circuit deck inset (sits cleanly at y = -2.325)
    const deckMat = new THREE.MeshStandardMaterial({
      map: this.assets.createDeckTexture(cssHex),
      roughness: 0.42,
      metalness: 0.48,
    });
    const deck = new THREE.Mesh(new THREE.BoxGeometry(6.35, 0.04, 2.95), deckMat);
    deck.position.set(0, -2.32, 0);
    deck.receiveShadow = !this.isSoftwareGl;
    group.add(deck);

    // Front illuminated status rail
    const railMat = new THREE.MeshStandardMaterial({
      color: colorHex,
      emissive: colorHex,
      emissiveIntensity: 0.65,
      roughness: 0.25,
      metalness: 0.3,
    });
    const frontRail = new THREE.Mesh(new THREE.BoxGeometry(5.8, 0.055, 0.06), railMat);
    frontRail.position.set(0, -2.47, 1.69);
    group.add(frontRail);

    // Twin vertical machined backplane struts anchoring the upper apparatus to the chassis
    const strutMat = new THREE.MeshStandardMaterial({
      color: 0x26354d,
      roughness: 0.32,
      metalness: 0.82,
    });
    for (const sx of [-2.35, 2.35]) {
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.14, 6.25, 0.14), strutMat);
      strut.position.set(sx, 0.78, -0.78);
      strut.castShadow = !this.isSoftwareGl;
      group.add(strut);

      const baseFlange = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.14, 0.32), strutMat);
      baseFlange.position.set(sx, -2.26, -0.78);
      group.add(baseFlange);
    }

    // Horizontal top crossbar gantry holding the header nameplate
    const crossbar = new THREE.Mesh(new THREE.BoxGeometry(4.86, 0.1, 0.12), strutMat);
    crossbar.position.set(0, 3.88, -0.78);
    group.add(crossbar);

    const header = this.assets.makeTextPlane(title, 4.15, 0.82, {
      cw: 512,
      ch: 104,
      font: '700 46px "Plus Jakarta Sans", sans-serif',
      color: '#f8fafc',
      bg: 'rgba(13, 21, 38, 0.94)',
      border: cssHex,
    });
    header.position.set(0, 4.12, -0.52);
    group.add(header);

    const sub = this.assets.makeTextPlane(subtitle, 4.7, 0.44, {
      cw: 580,
      ch: 64,
      font: '600 26px "Plus Jakarta Sans", sans-serif',
      color: '#94a3b8',
    });
    sub.position.set(0, 3.53, -0.52);
    group.add(sub);

    this.scene.add(group);
    return railMat;
  }

  private buildXorAssembly(x: number, y: number, accentHex: number): THREE.MeshPhysicalMaterial {
    const group = new THREE.Group();
    group.position.set(x, y, 0);

    // Outer machined gunmetal bezel torus
    const bezel = new THREE.Mesh(
      new THREE.TorusGeometry(0.49, 0.095, 16, 36),
      new THREE.MeshStandardMaterial({
        color: 0x334155,
        metalness: 0.86,
        roughness: 0.22,
      })
    );
    bezel.castShadow = !this.isSoftwareGl;
    group.add(bezel);

    // Recessed glowing optical core
    const coreMat = new THREE.MeshPhysicalMaterial({
      color: 0x16243b,
      emissive: accentHex,
      emissiveIntensity: 0.28,
      roughness: 0.18,
      metalness: 0.12,
      clearcoat: 1.0,
      clearcoatRoughness: 0.15,
    });
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.43, 24, 24), coreMat);
    group.add(core);

    // 3 machined port collar flanges (left, right, bottom)
    const collarGeo = new THREE.CylinderGeometry(0.12, 0.14, 0.18, 16);
    const collarMat = new THREE.MeshStandardMaterial({
      color: 0x475569,
      metalness: 0.88,
      roughness: 0.25,
    });

    const leftCollar = new THREE.Mesh(collarGeo, collarMat);
    leftCollar.rotation.z = Math.PI / 2;
    leftCollar.position.set(-0.54, 0, 0);
    group.add(leftCollar);

    const rightCollar = new THREE.Mesh(collarGeo, collarMat);
    rightCollar.rotation.z = Math.PI / 2;
    rightCollar.position.set(0.54, 0, 0);
    group.add(rightCollar);

    const bottomCollar = new THREE.Mesh(collarGeo, collarMat);
    bottomCollar.position.set(0, -0.54, 0);
    group.add(bottomCollar);

    // Rear support arm to backplane strut plane
    const arm = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.055, 0.78, 12),
      collarMat
    );
    arm.rotation.x = Math.PI / 2;
    arm.position.set(0, 0, -0.4);
    group.add(arm);

    // Crisp XOR glyph reticle
    const lbl = this.assets.makeTextPlane('⊕', 0.88, 0.88, {
      cw: 128,
      ch: 128,
      font: '700 88px "Plus Jakarta Sans", sans-serif',
      color: '#f8fafc',
    });
    lbl.position.set(0, 0, 0.47);
    group.add(lbl);

    this.scene.add(group);
    return coreMat;
  }

  private buildKeyFnAssembly(
    x: number,
    y: number
  ): { bezelMat: THREE.MeshStandardMaterial; coreMat: THREE.MeshStandardMaterial } {
    const group = new THREE.Group();
    group.position.set(x, y, 0);

    // Main brushed dark titanium processor body
    const coreMat = new THREE.MeshStandardMaterial({
      color: 0x192338,
      emissive: 0xd97706,
      emissiveIntensity: 0.2,
      roughness: 0.34,
      metalness: 0.68,
    });
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.26, 0.82, 0.84), coreMat);
    body.castShadow = !this.isSoftwareGl;
    body.receiveShadow = !this.isSoftwareGl;
    group.add(body);

    // Glowing anodized status bezel strip around front face
    const bezelMat = new THREE.MeshStandardMaterial({
      color: 0xfbbf24,
      emissive: 0xf59e0b,
      emissiveIntensity: 0.55,
      roughness: 0.25,
      metalness: 0.5,
    });
    const topTrim = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.05, 0.88), bezelMat);
    topTrim.position.set(0, 0.41, 0);
    group.add(topTrim);

    const bottomTrim = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.05, 0.88), bezelMat);
    bottomTrim.position.set(0, -0.41, 0);
    group.add(bottomTrim);

    // 5 brushed metallic heat-sink cooling fins along top crest
    const finMat = new THREE.MeshStandardMaterial({
      color: 0x64748b,
      metalness: 0.88,
      roughness: 0.24,
    });
    const finGeo = new THREE.BoxGeometry(0.06, 0.14, 0.66);
    for (let i = -2; i <= 2; i++) {
      const fin = new THREE.Mesh(finGeo, finMat);
      fin.position.set(i * 0.42, 0.48, -0.02);
      group.add(fin);
    }

    // 4 machined lower terminal sockets receiving register tap conduits
    const pinGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.12, 12);
    for (let i = 0; i < 4; i++) {
      const pin = new THREE.Mesh(pinGeo, finMat);
      pin.position.set((i - 1.5) * 0.36, -0.46, 0);
      group.add(pin);
    }

    // Front illuminated faceplate
    const lbl = this.assets.makeTextPlane('f(K, Reg)', 2.1, 0.66, {
      cw: 320,
      ch: 100,
      font: '700 44px "IBM Plex Mono", Consolas, monospace',
      color: '#fef3c7',
    });
    lbl.position.set(0, 0, 0.445);
    group.add(lbl);

    this.scene.add(group);
    return { bezelMat, coreMat };
  }

  private buildRegisterAssembly(
    xPositions: readonly [number, number, number, number],
    labelText: string,
    isReceiver: boolean
  ): RegisterSlot[] {
    const slots: RegisterSlot[] = [];
    const avgX = (xPositions[0] + xPositions[3]) / 2;
    const accentHex = isReceiver ? 0x2dd4bf : 0x38bdf8;

    // Grounded machined carriage rails spanning all 4 bays
    const railMetal = new THREE.MeshStandardMaterial({
      color: 0x334155,
      metalness: 0.85,
      roughness: 0.24,
    });
    const railLen = Math.abs(xPositions[3] - xPositions[0]) + 1.05;
    for (const rz of [-0.36, 0.36]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(railLen, 0.08, 0.09), railMetal);
      rail.position.set(avgX, REG_Y - 0.46, rz);
      rail.castShadow = !this.isSoftwareGl;
      this.scene.add(rail);
    }

    // Vertical stanchions grounding the register carriage cleanly to the platform deck (y = -2.30)
    const stanchionHeight = REG_Y - 0.46 - -2.3;
    for (const sx of [xPositions[0], xPositions[3]]) {
      const leg = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, stanchionHeight, 0.78),
        railMetal
      );
      leg.position.set(sx, -2.3 + stanchionHeight / 2, 0);
      leg.castShadow = !this.isSoftwareGl;
      this.scene.add(leg);
    }

    // Subtle shared glass cover material (sorted cleanly with depthWrite: false)
    const glassMat = new THREE.MeshStandardMaterial({
      color: isReceiver ? 0x5eead4 : 0x7dd3fc,
      transparent: true,
      opacity: 0.08,
      roughness: 0.12,
      metalness: 0.1,
      depthWrite: false,
    });

    for (let i = 0; i < 4; i++) {
      const sx = xPositions[i];

      // Machined slot pedestal cradle
      const pedestalMat = new THREE.MeshStandardMaterial({
        color: 0x1e293b,
        emissive: accentHex,
        emissiveIntensity: 0.12,
        metalness: 0.62,
        roughness: 0.36,
      });
      const pedestal = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.1, 0.78), pedestalMat);
      pedestal.position.set(sx, REG_Y - 0.42, 0);
      this.scene.add(pedestal);

      // Translucent protective optical bay enclosure
      const enclosure = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.76, 0.76), glassMat);
      enclosure.position.set(sx, REG_Y, 0);
      enclosure.renderOrder = 3;
      this.scene.add(enclosure);

      // Precision wireframe cage
      const cage = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(0.78, 0.78, 0.78)),
        new THREE.LineBasicMaterial({ color: accentHex })
      );
      cage.position.set(sx, REG_Y, 0);
      this.scene.add(cage);

      // Active 3D bit token inside slot
      const token = this.createBitToken(0.58);
      token.group.position.set(sx, REG_Y, 0);
      this.scene.add(token.group);

      // Slot index micro-label (R0..R3)
      const slotLbl = this.assets.makeTextPlane(`R${i}`, 0.42, 0.24, {
        cw: 96,
        ch: 54,
        font: '700 32px "IBM Plex Mono", monospace',
        color: '#94a3b8',
      });
      slotLbl.position.set(sx, REG_Y - 0.62, 0.38);
      this.scene.add(slotLbl);

      // Directional shift arrow between adjacent bays
      if (i < 3) {
        const midX = (xPositions[i] + xPositions[i + 1]) / 2;
        const dir = isReceiver ? 1 : -1;
        this.addPipeArrow(
          [
            [midX - 0.08 * dir, REG_Y, 0],
            [midX + 0.08 * dir, REG_Y, 0],
          ],
          accentHex,
          0.025,
          true
        );
      }

      slots.push({ baseX: sx, cage, pedestalMat, token });
    }

    const regLbl = this.assets.makeTextPlane(labelText, 4.1, 0.42, {
      cw: 560,
      ch: 62,
      font: '700 28px "Plus Jakarta Sans", sans-serif',
      color: '#cbd5e1',
    });
    regLbl.position.set(avgX, REG_Y - 0.92, 0.42);
    this.scene.add(regLbl);

    // Receiver exit deflector chute for flushed-out old bits
    if (isReceiver) {
      const chuteMat = new THREE.MeshStandardMaterial({
        color: 0x334155,
        metalness: 0.78,
        roughness: 0.32,
      });
      const chuteBase = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.06, 0.74), chuteMat);
      chuteBase.position.set(8.62, REG_Y - 0.45, 0);
      chuteBase.rotation.z = -0.18;
      this.scene.add(chuteBase);

      this.addPipeArrow(
        [
          [8.18, REG_Y, 0],
          [9.18, REG_Y, 0],
        ],
        0x64748b,
        0.03,
        true
      );

      const flushHint = this.assets.makeTextPlane('OLD BITS OUT', 1.65, 0.36, {
        cw: 260,
        ch: 56,
        font: '700 24px "Plus Jakarta Sans", sans-serif',
        color: '#94a3b8',
      });
      flushHint.position.set(9.05, REG_Y - 0.74, 0.25);
      this.scene.add(flushHint);
    }

    return slots;
  }

  private addPipeArrow(
    points: [number, number, number][],
    color = 0x38bdf8,
    radius = 0.042,
    addArrow = true
  ): THREE.MeshStandardMaterial {
    const vecs = points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    const curve = new THREE.CatmullRomCurve3(vecs);
    const tubeGeo = new THREE.TubeGeometry(curve, Math.max(12, points.length * 14), radius, 10, false);
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.28,
      roughness: 0.32,
      metalness: 0.45,
    });
    const tube = new THREE.Mesh(tubeGeo, mat);
    this.scene.add(tube);

    if (addArrow && vecs.length >= 2) {
      const pEnd = vecs[vecs.length - 1];
      const pPrev = vecs[vecs.length - 2];
      _tmpDir.subVectors(pEnd, pPrev).normalize();
      const cone = new THREE.Mesh(new THREE.ConeGeometry(radius * 2.5, radius * 5.6, 12), mat);
      cone.position.copy(pEnd);
      cone.quaternion.setFromUnitVectors(_upAxis, _tmpDir);
      this.scene.add(cone);
    }

    return mat;
  }

  private buildSignalConduits(): THREE.MeshStandardMaterial {
    // 1. Sender Plaintext -> XOR
    this.addPipeArrow(
      [
        [-8.95, CHANNEL_Y, 0],
        [-5.72, CHANNEL_Y, 0],
      ],
      0x10b981,
      0.04,
      true
    );
    const pInLbl = this.assets.makeTextPlane('Plaintext p', 2.05, 0.42, {
      cw: 280,
      ch: 58,
      font: '700 28px "Plus Jakarta Sans", sans-serif',
      color: '#34d399',
    });
    pInLbl.position.set(-7.65, 2.52, 0);
    this.scene.add(pInLbl);

    // 2. Sender Register taps -> f(K, Reg) -> XOR
    for (let i = 0; i < 4; i++) {
      this.addPipeArrow(
        [
          [SENDER_REG_X[i], REG_Y + 0.42, 0],
          [-5.1 + (1.5 - i) * 0.36, -0.1, 0],
        ],
        0x64748b,
        0.022,
        false
      );
    }
    this.addPipeArrow(
      [
        [-5.1, 0.82, 0],
        [-5.1, 1.38, 0],
      ],
      0xfbbf24,
      0.036,
      true
    );

    // 3. Sender XOR -> Channel & Feedback loop to Sender R0
    this.addPipeArrow(
      [
        [-4.55, CHANNEL_Y, 0],
        [-3.32, CHANNEL_Y, 0],
      ],
      0x38bdf8,
      0.045,
      true
    );
    this.addPipeArrow(
      [
        [-4.08, CHANNEL_Y, 0],
        [-4.08, 0.35, 0],
        [-4.08, REG_Y, 0],
        [-4.82, REG_Y, 0],
      ],
      0x38bdf8,
      0.032,
      true
    );

    // 4. Central Ciphertext Channel with machined couplings & glass sleeve
    const channelCoreMat = this.addPipeArrow(
      [
        [-3.25, CHANNEL_Y, 0],
        [3.25, CHANNEL_Y, 0],
      ],
      0x1d4ed8,
      0.056,
      true
    );

    const glassSleeve = new THREE.Mesh(
      new THREE.CylinderGeometry(0.24, 0.24, 6.2, 20, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0x7dd3fc,
        transparent: true,
        opacity: 0.13,
        roughness: 0.12,
        metalness: 0.1,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    glassSleeve.rotation.z = Math.PI / 2;
    glassSleeve.position.set(0, CHANNEL_Y, 0);
    glassSleeve.renderOrder = 2;
    this.scene.add(glassSleeve);

    const flangeMat = new THREE.MeshStandardMaterial({
      color: 0x475569,
      metalness: 0.88,
      roughness: 0.24,
    });
    for (const fx of [-3.12, 3.12]) {
      const flange = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.29, 0.16, 20), flangeMat);
      flange.rotation.z = Math.PI / 2;
      flange.position.set(fx, CHANNEL_Y, 0);
      this.scene.add(flange);
    }

    const chanLbl = this.assets.makeTextPlane('Ciphertext Channel', 3.45, 0.44, {
      cw: 440,
      ch: 60,
      font: '700 28px "Plus Jakarta Sans", sans-serif',
      color: '#7dd3fc',
    });
    chanLbl.position.set(0, 2.66, 0);
    this.scene.add(chanLbl);

    // 5. Receiver incoming tap -> Feedback R0 & Receiver XOR
    this.addPipeArrow(
      [
        [3.32, CHANNEL_Y, 0],
        [4.48, CHANNEL_Y, 0],
      ],
      0x2dd4bf,
      0.045,
      true
    );
    this.addPipeArrow(
      [
        [3.88, CHANNEL_Y, 0],
        [3.88, 0.35, 0],
        [3.88, REG_Y, 0],
        [4.42, REG_Y, 0],
      ],
      0x2dd4bf,
      0.032,
      true
    );

    // 6. Receiver Register taps -> f(K, Reg) -> XOR
    for (let i = 0; i < 4; i++) {
      this.addPipeArrow(
        [
          [RECEIVER_REG_X[i], REG_Y + 0.42, 0],
          [5.1 + (i - 1.5) * 0.36, -0.1, 0],
        ],
        0x64748b,
        0.022,
        false
      );
    }
    this.addPipeArrow(
      [
        [5.1, 0.82, 0],
        [5.1, 1.38, 0],
      ],
      0xfbbf24,
      0.036,
      true
    );

    // 7. Receiver XOR -> Decrypted Plaintext Output
    this.addPipeArrow(
      [
        [5.66, CHANNEL_Y, 0],
        [9.1, CHANNEL_Y, 0],
      ],
      0x10b981,
      0.04,
      true
    );
    const pOutLbl = this.assets.makeTextPlane('Decrypted p̃', 2.25, 0.42, {
      cw: 300,
      ch: 58,
      font: '700 28px "Plus Jakarta Sans", sans-serif',
      color: '#34d399',
    });
    pOutLbl.position.set(7.65, 2.52, 0);
    this.scene.add(pOutLbl);

    return channelCoreMat;
  }

  private buildChannelNoiseUnit() {
    const group = new THREE.Group();
    group.position.set(0, CHANNEL_Y, 0);

    const outerRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.92, 0.048, 12, 36),
      new THREE.MeshStandardMaterial({
        color: 0xef4444,
        emissive: 0xef4444,
        emissiveIntensity: 1.2,
        transparent: true,
        opacity: 0,
      })
    );
    group.add(outerRing);

    const innerRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.64, 0.032, 10, 28),
      new THREE.MeshStandardMaterial({
        color: 0xfca5a5,
        emissive: 0xf87171,
        emissiveIntensity: 1.0,
        transparent: true,
        opacity: 0,
      })
    );
    group.add(innerRing);

    const segments = 28;
    const arcPositions = new Float32Array((segments + 1) * 3);
    const arcGeo = new THREE.BufferGeometry();
    arcGeo.setAttribute('position', new THREE.BufferAttribute(arcPositions, 3));
    const arcLine = new THREE.Line(
      arcGeo,
      new THREE.LineBasicMaterial({
        color: 0xfca5a5,
        transparent: true,
        opacity: 0,
      })
    );
    group.add(arcLine);

    const pointLight = new THREE.PointLight(0xef4444, 0, 7.5, 2);
    pointLight.position.set(0, 0, 0.6);
    group.add(pointLight);

    const label = this.assets.makeTextPlane('NOISE: BIT FLIPPED (1 → 0)', 3.9, 0.56, {
      cw: 540,
      ch: 78,
      font: '700 34px "Plus Jakarta Sans", sans-serif',
      color: '#fecaca',
      bg: 'rgba(127, 29, 29, 0.94)',
      border: '#f87171',
    });
    label.position.set(0, 1.38, 0.25);
    label.material.opacity = 0;
    group.add(label);

    this.scene.add(group);
    return { group, outerRing, innerRing, arcLine, arcPositions, pointLight, label };
  }

  private createBitToken(size: number): BitToken {
    const group = new THREE.Group();
    const geo = new THREE.BoxGeometry(size, size, size);
    const mat = new THREE.MeshStandardMaterial({
      map: this.assets.getBitTexture(0, 'cipher'),
      roughness: 0.28,
      metalness: 0.22,
      emissive: new THREE.Color(0x0284c7),
      emissiveIntensity: 0.3,
    });
    const cube = new THREE.Mesh(geo, mat);
    cube.castShadow = !this.isSoftwareGl;
    group.add(cube);

    const rim = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(size + 0.015, size + 0.015, size + 0.015)),
      new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.85 })
    );
    group.add(rim);

    return { group, cube, rim, lastDigit: -1, lastMode: null };
  }

  private styleBitToken(token: BitToken, digit: number, mode: BitVisualMode): void {
    if (token.lastDigit === digit && token.lastMode === mode) return;
    const style = BIT_STYLES[mode];
    token.cube.material.map = this.assets.getBitTexture(digit, mode);
    token.cube.material.emissive.setHex(style.emissive);
    token.cube.material.emissiveIntensity = style.emissiveIntensity;
    token.cube.material.needsUpdate = true;
    token.rim.material.color.setHex(style.rimColor);
    token.lastDigit = digit;
    token.lastMode = mode;
  }

  private updateSimulation(t: number, dt: number, snapCamera = false): SimulationSnapshot {
    const snap = evaluateSimulationSnapshot(t);
    const {
      latestLaunchedIdx,
      latestArrivedIdx,
      activeSReg,
      activeRReg,
      corruptPos,
      isOutOfSync,
      syncRestored,
      flushTime,
    } = snap;

    // 1. Update Sender Feedback Register 3D bays
    let shiftSenderProgress = 1;
    if (latestLaunchedIdx >= 0) {
      shiftSenderProgress = Math.min(1, (t - STEPS[latestLaunchedIdx].launch) / 0.24);
    }
    const senderSlide = (1 - smoothstep(shiftSenderProgress)) * 0.72;
    for (let slot = 0; slot < 4; slot++) {
      const sObj = this.senderRegSlots[slot];
      this.styleBitToken(sObj.token, activeSReg[slot], 'reg_ok');
      sObj.token.group.position.x = sObj.baseX + senderSlide;
    }

    // 2. Update Receiver Feedback Register 3D bays
    let shiftRecProgress = 1;
    if (latestArrivedIdx >= 0) {
      shiftRecProgress = Math.min(1, (t - STEPS[latestArrivedIdx].arrive) / 0.3);
    }
    const recSlide = (1 - smoothstep(shiftRecProgress)) * -0.72;
    for (let slot = 0; slot < 4; slot++) {
      const rObj = this.receiverRegSlots[slot];
      const isThisCorrupt = corruptPos === slot;
      if (isThisCorrupt) {
        this.styleBitToken(rObj.token, activeRReg[slot], 'reg_corrupt');
        rObj.cage.material.color.setHex(0xef4444);
        rObj.pedestalMat.emissive.setHex(0xef4444);
        rObj.pedestalMat.emissiveIntensity = 0.55;
        const pulse = 1.0 + 0.08 * Math.sin(t * 12);
        rObj.token.group.scale.setScalar(pulse);
      } else {
        this.styleBitToken(rObj.token, activeRReg[slot], syncRestored ? 'reg_sync' : 'reg_ok');
        const col = syncRestored ? 0x34d399 : 0x2dd4bf;
        rObj.cage.material.color.setHex(col);
        rObj.pedestalMat.emissive.setHex(col);
        rObj.pedestalMat.emissiveIntensity = syncRestored ? 0.3 : 0.14;
        rObj.token.group.scale.setScalar(1.0);
      }
      rObj.token.group.position.x = rObj.baseX + recSlide;
    }

    // 3. Flushed corrupted red bit tumbling out of Receiver chute (13.95s - 15.95s)
    if (t >= flushTime && t <= flushTime + 2.0) {
      const fp = (t - flushTime) / 2.0;
      this.flushedToken.group.visible = true;
      this.flushedToken.group.position.set(
        lerp(7.75, 9.75, smoothstep(Math.min(1, fp * 1.35))),
        REG_Y - fp * fp * 1.45,
        0
      );
      this.flushedToken.group.rotation.z = -fp * 2.5;
      this.flushedToken.group.rotation.x = fp * 1.4;
      const sc = Math.max(0.01, 1 - Math.max(0, (fp - 0.52) * 2.1));
      this.flushedToken.group.scale.setScalar(sc);
      this.flushedLabel.material.opacity = Math.sin(Math.min(1, fp) * Math.PI);
    } else {
      this.flushedToken.group.visible = false;
      this.flushedLabel.material.opacity = 0;
    }

    // 4. Channel Noise Electromagnetic Interference (Scene 2: 5.0s - 7.2s)
    if (t >= 5.0 && t <= 7.2) {
      const intensity = Math.sin(((t - 5.0) / 2.2) * Math.PI);
      this.noiseOuterRing.material.opacity = intensity * 0.92;
      this.noiseInnerRing.material.opacity = intensity * 0.85;
      this.noiseArcLine.material.opacity = intensity * 0.95;
      this.noiseLabel.material.opacity = Math.min(1, intensity * 1.5);
      this.noisePointLight.intensity = intensity * 4.5;

      this.noiseOuterRing.rotation.z = t * 4.2;
      this.noiseInnerRing.rotation.z = -t * 6.5;
      this.noiseInnerRing.rotation.x = Math.sin(t * 7.0) * 0.65;
      this.noiseOuterRing.scale.setScalar(0.92 + 0.16 * Math.sin(t * 18));

      // Jagged radial interference arc
      const segs = 28;
      for (let k = 0; k <= segs; k++) {
        const angle = (k / segs) * Math.PI * 2 + t * 3.5;
        const jag = k % 2 === 0 ? 1.12 : 0.62;
        const jitter = 0.08 * Math.sin(k * 5.3 + t * 32);
        const r = jag + jitter;
        this.noiseArcPositions[k * 3] = Math.cos(angle) * r;
        this.noiseArcPositions[k * 3 + 1] = Math.sin(angle) * r;
        this.noiseArcPositions[k * 3 + 2] = 0.08 * Math.cos(k * 3.1 + t * 24);
      }
      this.noiseArcLine.geometry.attributes.position.needsUpdate = true;

      this.channelCoreMat.color.setHex(0xef4444);
      this.channelCoreMat.emissive.setHex(0xef4444);
      this.channelCoreMat.emissiveIntensity = 0.85;
    } else {
      this.noiseOuterRing.material.opacity = 0;
      this.noiseInnerRing.material.opacity = 0;
      this.noiseArcLine.material.opacity = 0;
      this.noiseLabel.material.opacity = 0;
      this.noisePointLight.intensity = 0;
      this.channelCoreMat.color.setHex(0x1d4ed8);
      this.channelCoreMat.emissive.setHex(0x0284c7);
      this.channelCoreMat.emissiveIntensity = 0.3;
    }

    // 5. Receiver f(K, Reg) and platform rail dynamic status glow
    if (isOutOfSync) {
      this.receiverFnCoreMat.emissive.setHex(0xef4444);
      this.receiverFnCoreMat.emissiveIntensity = 0.45;
      this.receiverFnBezelMat.color.setHex(0xf87171);
      this.receiverFnBezelMat.emissive.setHex(0xef4444);
      this.receiverRailMat.color.setHex(0xef4444);
      this.receiverRailMat.emissive.setHex(0xef4444);
    } else if (syncRestored) {
      this.receiverFnCoreMat.emissive.setHex(0x10b981);
      this.receiverFnCoreMat.emissiveIntensity = 0.34;
      this.receiverFnBezelMat.color.setHex(0x34d399);
      this.receiverFnBezelMat.emissive.setHex(0x10b981);
      this.receiverRailMat.color.setHex(0x34d399);
      this.receiverRailMat.emissive.setHex(0x10b981);
    } else {
      this.receiverFnCoreMat.emissive.setHex(0xd97706);
      this.receiverFnCoreMat.emissiveIntensity = 0.22;
      this.receiverFnBezelMat.color.setHex(0xfbbf24);
      this.receiverFnBezelMat.emissive.setHex(0xf59e0b);
      this.receiverRailMat.color.setHex(0x2dd4bf);
      this.receiverRailMat.emissive.setHex(0x2dd4bf);
    }

    // 6. Animate flying bit tokens & XOR gate flashes
    let senderXorPulse = 0;
    let receiverXorPulse = 0;
    let receiverXorErr = false;

    for (let i = 0; i < STEPS.length; i++) {
      const st = STEPS[i];
      const vis = this.stepVisuals[i];
      const dtPre = 0.45;
      const dtPost = 0.85;

      // Sender XOR arrival pulse
      const dLaunch = Math.abs(t - st.launch);
      if (dLaunch < 0.16) {
        senderXorPulse = Math.max(senderXorPulse, 1 - dLaunch / 0.16);
      }

      // Receiver XOR arrival pulse
      const dArrive = Math.abs(t - st.arrive);
      if (dArrive < 0.18) {
        receiverXorPulse = Math.max(receiverXorPulse, 1 - dArrive / 0.18);
        if (!st.decCorrect) receiverXorErr = true;
      }

      // 1) Plaintext & Keystream entering Sender XOR
      if (t >= st.launch - dtPre && t < st.launch) {
        const u = smoothstep((t - (st.launch - dtPre)) / dtPre);
        vis.plainInToken.group.visible = true;
        this.styleBitToken(vis.plainInToken, st.p, 'plain_ok');
        vis.plainInToken.group.position.set(lerp(-8.65, -5.2, u), CHANNEL_Y, 0);

        vis.keySenderToken.group.visible = true;
        this.styleBitToken(vis.keySenderToken, st.zS, 'key_ok');
        vis.keySenderToken.group.position.set(-5.1, lerp(0.82, 1.84, u), 0);
      } else {
        vis.plainInToken.group.visible = false;
        vis.keySenderToken.group.visible = false;
      }

      // 2) Ciphertext cube traveling through glass-jacketed channel
      if (t >= st.launch && t < st.arrive) {
        const u = (t - st.launch) / (st.arrive - st.launch);
        vis.cipherToken.group.visible = true;
        const flipped = st.isCorruptBit && u >= 0.5;
        this.styleBitToken(vis.cipherToken, flipped ? st.cRx : st.cTx, flipped ? 'corrupt' : 'cipher');
        vis.cipherToken.group.position.set(lerp(-4.55, 4.55, u), CHANNEL_Y, 0);
        vis.cipherToken.group.rotation.y = u * Math.PI * 2;
        vis.cipherToken.group.rotation.x = Math.sin(u * Math.PI) * 0.22;
      } else {
        vis.cipherToken.group.visible = false;
      }

      // 3) Receiver Keystream rising into Receiver XOR
      if (t >= st.arrive - dtPre && t < st.arrive) {
        const u = smoothstep((t - (st.arrive - dtPre)) / dtPre);
        vis.keyRecToken.group.visible = true;
        this.styleBitToken(vis.keyRecToken, st.zR, st.keyMatch ? 'key_ok' : 'key_err');
        vis.keyRecToken.group.position.set(5.1, lerp(0.82, 1.84, u), 0);
      } else {
        vis.keyRecToken.group.visible = false;
      }

      // 4) Decrypted Plaintext exiting Receiver XOR
      if (t >= st.arrive && t <= st.arrive + dtPost) {
        const u = smoothstep((t - st.arrive) / dtPost);
        vis.plainOutToken.group.visible = true;
        this.styleBitToken(vis.plainOutToken, st.pDec, st.decCorrect ? 'plain_ok' : 'plain_err');
        vis.plainOutToken.group.position.set(lerp(5.65, 8.95, u), CHANNEL_Y, 0);

        vis.outBadge.visible = true;
        this.assets.updateTextPlane(vis.outBadge, st.decCorrect ? '✓' : '✗', {
          color: st.decCorrect ? '#34d399' : '#f87171',
        });
        vis.outBadge.position.set(vis.plainOutToken.group.position.x, 2.58, 0.15);
      } else {
        vis.plainOutToken.group.visible = false;
        vis.outBadge.visible = false;
      }
    }

    this.senderXorCoreMat.emissiveIntensity = 0.28 + senderXorPulse * 0.85;
    this.receiverXorCoreMat.emissive.setHex(receiverXorErr ? 0xef4444 : 0x2dd4bf);
    this.receiverXorCoreMat.emissiveIntensity = 0.28 + receiverXorPulse * 0.9;

    // 7. Smooth frame-rate independent camera choreography in 'auto' mode
    if (this.cameraMode === 'auto') {
      if (t < 5.0) {
        _targetCamPos.set(0, 2.9, 18.2);
        _targetLookAt.set(0, 0.65, 0);
      } else if (t < 9.0) {
        _targetCamPos.set(1.4, 2.35, 15.2);
        _targetLookAt.set(1.4, 0.72, 0);
      } else if (t < 16.0) {
        _targetCamPos.set(3.2, 1.35, 13.8);
        _targetLookAt.set(3.4, 0.15, 0);
      } else {
        _targetCamPos.set(0, 2.9, 18.2);
        _targetLookAt.set(0, 0.65, 0);
      }

      if (snapCamera) {
        this.camera.position.copy(_targetCamPos);
        this.controls.target.copy(_targetLookAt);
      } else {
        const lambda = 3.2;
        this.camera.position.x = THREE.MathUtils.damp(this.camera.position.x, _targetCamPos.x, lambda, dt);
        this.camera.position.y = THREE.MathUtils.damp(this.camera.position.y, _targetCamPos.y, lambda, dt);
        this.camera.position.z = THREE.MathUtils.damp(this.camera.position.z, _targetCamPos.z, lambda, dt);
        this.controls.target.x = THREE.MathUtils.damp(this.controls.target.x, _targetLookAt.x, lambda, dt);
        this.controls.target.y = THREE.MathUtils.damp(this.controls.target.y, _targetLookAt.y, lambda, dt);
        this.controls.target.z = THREE.MathUtils.damp(this.controls.target.z, _targetLookAt.z, lambda, dt);
      }
    }

    this.controls.update();
    return snap;
  }

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (!gl || typeof gl.fenceSync !== 'function') {
      this.frameId = window.setTimeout(cb, 80);
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.isDisposed) return;
      const state = sync ? gl.getSyncParameter(sync, gl.SYNC_STATUS) : gl.SIGNALED;
      if (state === gl.UNSIGNALED) {
        this.frameId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.frameId = window.setTimeout(cb, 80);
      }
    };
    this.frameId = window.setTimeout(poll, 5);
  }

  private scheduleNextTick(): void {
    if (this.isDisposed) return;
    if (this.isSoftwareGl) {
      this.afterDraw(() => this.tick());
    } else {
      this.frameId = requestAnimationFrame(() => this.tick());
    }
  }

  private tick(): void {
    if (this.isDisposed) return;

    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0.001, (now - this.lastNow) / 1000));
    this.lastNow = now;

    if (!this.isContextLost) {
      let endedNow = false;
      if (this.isPlaying) {
        this.simTime += dt * this.playbackSpeed;
        if (this.simTime >= DURATION) {
          this.simTime = DURATION;
          this.isPlaying = false;
          endedNow = true;
        }
      }

      const snap = this.updateSimulation(this.simTime, dt, false);
      this.renderer.render(this.scene, this.camera);

      // Throttle React HUD updates smoothly (~20Hz while playing, immediate on stop/end)
      if (endedNow || now - this.lastHudEmit >= 45) {
        this.lastHudEmit = now;
        this.callbacks.onSnapshot(snap, this.isPlaying);
      }
    }

    this.scheduleNextTick();
  }

  private handleResize(): void {
    if (this.isDisposed) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  // Public imperative controls
  setPlaying(playing: boolean): void {
    if (playing && this.simTime >= DURATION - 0.01) {
      this.simTime = 0;
    }
    this.isPlaying = playing;
    this.lastNow = performance.now();
    const snap = evaluateSimulationSnapshot(this.simTime);
    this.callbacks.onSnapshot(snap, this.isPlaying);
  }

  togglePlay(): void {
    this.setPlaying(!this.isPlaying);
  }

  replay(): void {
    this.simTime = 0;
    this.isPlaying = true;
    this.lastNow = performance.now();
    const snap = this.updateSimulation(0, 0.016, false);
    this.callbacks.onSnapshot(snap, true);
  }

  seek(timeSeconds: number, pause = false): void {
    this.simTime = Math.max(0, Math.min(DURATION, timeSeconds));
    if (pause) this.isPlaying = false;
    const snap = this.updateSimulation(this.simTime, 0.016, false);
    this.callbacks.onSnapshot(snap, this.isPlaying);
  }

  setSpeed(speed: number): void {
    this.playbackSpeed = speed;
  }

  setCameraMode(mode: CameraMode): void {
    this.cameraMode = mode;
    this.callbacks.onCameraModeChange(mode);
  }

  resetView(): void {
    this.cameraMode = 'auto';
    this.callbacks.onCameraModeChange('auto');
  }

  dispose(): void {
    this.isDisposed = true;
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLostBound);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestoredBound);

    this.controls.dispose();
    this.envRT.dispose();
    this.assets.dispose();

    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.LineSegments) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose());
        } else {
          obj.material.dispose();
        }
      }
    });

    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
