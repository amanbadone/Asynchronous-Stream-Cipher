export interface ScheduleEntry {
  launch: number;
  arrive: number;
}

export interface CipherStep {
  index: number;
  launch: number;
  arrive: number;
  p: number;
  zS: number;
  cTx: number;
  cRx: number;
  zR: number;
  pDec: number;
  isCorruptBit: boolean;
  decCorrect: boolean;
  keyMatch: boolean;
  sRegBefore: [number, number, number, number];
  sRegAfter: [number, number, number, number];
  rRegBefore: [number, number, number, number];
  rRegAfter: [number, number, number, number];
  corruptPosBefore: number;
  corruptPosAfter: number;
  pushedOutBit: number;
  pushedOutWasCorrupt: boolean;
}

export interface SceneMeta {
  id: number;
  shortLabel: string;
  title: string;
  rangeLabel: string;
  startTime: number;
  endTime: number;
}

export type SyncStateKind = 'synced' | 'desynced' | 'flushed' | 'restored';

export interface SimulationSnapshot {
  time: number;
  latestLaunchedIdx: number;
  latestArrivedIdx: number;
  activeSReg: [number, number, number, number];
  activeRReg: [number, number, number, number];
  corruptPos: number; // -1 = not present, 0..3 = slot index, 4 = flushed
  isOutOfSync: boolean;
  syncRestored: boolean;
  flushTime: number;
  sceneIdx: number;
  sceneMeta: SceneMeta;
  syncKind: SyncStateKind;
  syncHeading: string;
  syncSubtitle: string;
  displayStep: CipherStep;
}

export const DURATION = 20.0;

// 4-bit ciphertext feedback register: [Slot 0 (newest), Slot 1, Slot 2, Slot 3 (oldest)]
export const INITIAL_IV: [number, number, number, number] = [1, 0, 1, 0];

// Plaintext crafted so Scene 1 ciphertext is exact: 1 0 1 1 0 0 1 0
export const PLAINTEXT: readonly number[] = [
  0, 0, 0, 1, 0, 1, 0, 1, // Steps 0..7  -> Ciphertext: 1,0,1,1,0,0,1,0 (Scene 1)
  1,                      // Step 8      -> Corrupted in transit: Tx 1 -> Rx 0 (Scene 2)
  0,                      // Step 9      -> Wrong keystream, corrupted bit in Box 1 (Scene 2)
  0, 0, 1,                // Steps 10..12-> Corrupted bit shifts Box 2 -> Box 3 -> Box 4 -> Flushed (Scene 3)
  1, 0, 1, 0,             // Steps 13..16-> Synchronization restored (Scene 4)
];

export const CORRUPT_STEP = 8;

export const SCHEDULE: readonly ScheduleEntry[] = [
  // Scene 1 (0 - 5s): 8 bits -> 1 0 1 1 0 0 1 0
  { launch: 0.15, arrive: 0.70 },
  { launch: 0.72, arrive: 1.27 },
  { launch: 1.29, arrive: 1.84 },
  { launch: 1.86, arrive: 2.41 },
  { launch: 2.43, arrive: 2.98 },
  { launch: 3.00, arrive: 3.55 },
  { launch: 3.57, arrive: 4.12 },
  { launch: 4.14, arrive: 4.69 },
  // Scene 2 (5 - 9s): Bit 8 flipped in channel, Bit 9 decrypts wrongly
  { launch: 5.20, arrive: 6.75 }, // Step 8 (flipped at midpoint t = 5.975s)
  { launch: 7.25, arrive: 8.45 }, // Step 9 (corrupted bit sits in Box 1 -> shifts to Box 2)
  // Scene 3 (9 - 16s): Corrupted bit advances Box 2 -> Box 3 -> Box 4 -> Flushed out
  { launch: 9.05, arrive: 10.35 },  // Step 10
  { launch: 10.90, arrive: 12.15 }, // Step 11
  { launch: 12.65, arrive: 13.95 }, // Step 12 (corrupted bit flushed at 13.95s)
  // Scene 4 (16 - 20s): Sync automatically restored
  { launch: 15.10, arrive: 16.05 }, // Step 13 (first clean decryption after flush)
  { launch: 16.45, arrive: 17.40 }, // Step 14
  { launch: 17.75, arrive: 18.65 }, // Step 15
  { launch: 18.90, arrive: 19.65 }, // Step 16
];

export const SCENES: readonly SceneMeta[] = [
  {
    id: 0,
    shortLabel: 'Normal Sync',
    title: 'Scene 1 · Normal Synchronization',
    rangeLabel: '0–5s',
    startTime: 0.0,
    endTime: 5.0,
  },
  {
    id: 1,
    shortLabel: 'Bit Flipped',
    title: 'Scene 2 · Corrupted Ciphertext Bit',
    rangeLabel: '5–9s',
    startTime: 5.0,
    endTime: 9.0,
  },
  {
    id: 2,
    shortLabel: 'Auto-Recovery',
    title: 'Scene 3 · Automatic Recovery',
    rangeLabel: '9–16s',
    startTime: 9.0,
    endTime: 16.0,
  },
  {
    id: 3,
    shortLabel: 'Restored',
    title: 'Scene 4 · Synchronization Restored',
    rangeLabel: '16–20s',
    startTime: 16.0,
    endTime: 20.0,
  },
];

export function keystreamFn(reg: readonly [number, number, number, number]): number {
  return reg[0] ^ reg[1] ^ reg[2] ^ reg[3] ^ 1;
}

function buildSteps(): readonly CipherStep[] {
  const steps: CipherStep[] = [];
  let sReg: [number, number, number, number] = [...INITIAL_IV];
  let rReg: [number, number, number, number] = [...INITIAL_IV];
  let corruptAge = -1; // -1: clean, 0..3: box index, 4: flushed

  for (let i = 0; i < PLAINTEXT.length; i++) {
    const p = PLAINTEXT[i];
    const zS = keystreamFn(sReg);
    const cTx = p ^ zS;
    const cRx = i === CORRUPT_STEP ? cTx ^ 1 : cTx;

    const zR = keystreamFn(rReg);
    const pDec = cRx ^ zR;

    const sRegBefore: [number, number, number, number] = [...sReg];
    const rRegBefore: [number, number, number, number] = [...rReg];
    const corruptPosBefore = corruptAge;

    const pushedOutBit = rReg[3];
    const pushedOutWasCorrupt = corruptAge === 3;

    sReg = [cTx, sReg[0], sReg[1], sReg[2]];
    rReg = [cRx, rReg[0], rReg[1], rReg[2]];

    if (i === CORRUPT_STEP) {
      corruptAge = 0;
    } else if (corruptAge >= 0 && corruptAge < 3) {
      corruptAge++;
    } else if (corruptAge === 3) {
      corruptAge = 4;
    }

    steps.push({
      index: i,
      launch: SCHEDULE[i].launch,
      arrive: SCHEDULE[i].arrive,
      p,
      zS,
      cTx,
      cRx,
      zR,
      pDec,
      isCorruptBit: i === CORRUPT_STEP,
      decCorrect: pDec === p,
      keyMatch: zR === zS,
      sRegBefore,
      sRegAfter: [...sReg],
      rRegBefore,
      rRegAfter: [...rReg],
      corruptPosBefore,
      corruptPosAfter: corruptAge,
      pushedOutBit,
      pushedOutWasCorrupt,
    });
  }
  return steps;
}

export const STEPS: readonly CipherStep[] = buildSteps();
export const FLUSH_TIME = STEPS[12].arrive; // 13.95s
export const CORRUPT_MIDPOINT = (STEPS[CORRUPT_STEP].launch + STEPS[CORRUPT_STEP].arrive) * 0.5; // 5.975s

export function evaluateSimulationSnapshot(rawTime: number): SimulationSnapshot {
  const time = Math.max(0, Math.min(DURATION, rawTime));

  let latestLaunchedIdx = -1;
  let latestArrivedIdx = -1;
  for (let i = 0; i < STEPS.length; i++) {
    if (time >= STEPS[i].launch) latestLaunchedIdx = i;
    if (time >= STEPS[i].arrive) latestArrivedIdx = i;
  }

  const activeSReg: [number, number, number, number] =
    latestLaunchedIdx >= 0 ? STEPS[latestLaunchedIdx].sRegAfter : INITIAL_IV;
  const activeRReg: [number, number, number, number] =
    latestArrivedIdx >= 0 ? STEPS[latestArrivedIdx].rRegAfter : INITIAL_IV;
  const corruptPos = latestArrivedIdx >= 0 ? STEPS[latestArrivedIdx].corruptPosAfter : -1;
  const isOutOfSync = corruptPos >= 0 && corruptPos <= 3;
  const syncRestored = latestArrivedIdx >= 12;

  let sceneIdx = 0;
  let syncKind: SyncStateKind = 'synced';
  let syncHeading = 'IN SYNCHRONIZATION';
  let syncSubtitle = 'Both 4-bit feedback registers match · Keystreams identical';

  if (time < 5.0) {
    sceneIdx = 0;
    syncKind = 'synced';
    syncHeading = 'IN SYNCHRONIZATION';
    syncSubtitle = 'Both 4-bit feedback registers match · Clean decryption';
  } else if (time < 9.0) {
    sceneIdx = 1;
    if (time < CORRUPT_MIDPOINT) {
      syncKind = 'synced';
      syncHeading = 'IN SYNCHRONIZATION';
      syncSubtitle = 'Channel noise approaching transmitted ciphertext bit';
    } else if (time < STEPS[CORRUPT_STEP].arrive) {
      syncKind = 'desynced';
      syncHeading = 'CHANNEL BIT FLIPPED (1 → 0)';
      syncSubtitle = 'Corrupted ciphertext bit traveling toward Receiver';
    } else {
      syncKind = 'desynced';
      syncHeading = 'OUT OF SYNCHRONIZATION';
      syncSubtitle = 'Corrupted bit entered Receiver Slot R₀ · Keystream diverges';
    }
  } else if (time < 16.0) {
    sceneIdx = 2;
    if (time < FLUSH_TIME) {
      syncKind = 'desynced';
      syncHeading = 'OUT OF SYNCHRONIZATION';
      syncSubtitle = `Correct bits pushing corrupted bit across register (Slot ${corruptPos + 1} of 4)`;
    } else {
      syncKind = 'flushed';
      syncHeading = 'REGISTER FLUSHED';
      syncSubtitle = '4th clean ciphertext bit ejected error · Registers now match [1, 1, 0, 1]';
    }
  } else {
    sceneIdx = 3;
    syncKind = 'restored';
    syncHeading = 'SYNCHRONIZATION RESTORED';
    syncSubtitle = 'Keystream & decryption recovered automatically without retransmission';
  }

  const dispIdx = Math.max(0, latestArrivedIdx >= 0 ? latestArrivedIdx : Math.max(0, latestLaunchedIdx));
  const displayStep = STEPS[dispIdx];

  return {
    time,
    latestLaunchedIdx,
    latestArrivedIdx,
    activeSReg,
    activeRReg,
    corruptPos,
    isOutOfSync,
    syncRestored,
    flushTime: FLUSH_TIME,
    sceneIdx,
    sceneMeta: SCENES[sceneIdx],
    syncKind,
    syncHeading,
    syncSubtitle,
    displayStep,
  };
}
