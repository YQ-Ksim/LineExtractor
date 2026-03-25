export type FilterType = "butterworth" | "ideal";
export type BackendPreference = "auto" | "webgpu" | "webgl" | "cpu";
export type BackendKind = "webgpu" | "webgl" | "cpu";

export interface AppParams {
  radius: number;
  filterType: FilterType;
  butterOrder: number;
  highpassStrength: number;
  normalize: boolean;
  contrast: number;
  threshold: number;
  clipMin: number;
  clipMax: number;
  blur: number;
  sharpen: number;
  regionBinarize: boolean;
  regionTopPercent: number;
  rankVoteWeight: number;
  rankGrayWeight: number;
  regionMergeEnabled: boolean;
  regionMergeStrength: number;
  regionMergePasses: number;
  segLineThreshold: number;
  segLineDenoiseRadius: number;
  segLineMinArea: number;
  segDilateRadius: number;
  useWatershedInit: boolean;
  wsSeedSpacing: number;
  wsSeedMinDist: number;
  felzK: number;
  felzMinSize: number;
  linePenalty: number;
  multiScaleEnabled: boolean;
  multiScaleKFactor: number;
  multiScaleMinFactor: number;
  crfEnabled: boolean;
  crfIters: number;
  crfUnaryWeight: number;
  crfPairWeight: number;
  crfColorSigma: number;
}

export interface KRange {
  min: number;
  max: number;
}

export interface ProcessOptions {
  needRgba?: boolean;
  needKMap?: boolean;
  forceKMap?: boolean;
}

export interface WorkerInitImageMessage {
  type: "initImage";
  width: number;
  height: number;
  data: ArrayBuffer;
}

export interface WorkerProcessMessage {
  type: "process";
  id: number;
  params: AppParams;
  options?: ProcessOptions;
}

export type ToWorkerMessage = WorkerInitImageMessage | WorkerProcessMessage;

export interface WorkerImageReadyMessage {
  type: "imageReady";
  width: number;
  height: number;
  stats: {
    initMs: number;
    padW: number;
    padH: number;
  };
}

export interface WorkerResultStats {
  totalMs: number;
  layer1Ms: number;
  layer2Ms: number;
  layer3Ms: number;
  regionMs: number;
  felzMs: number;
  felzInitialRegions: number;
  felzFinalRegions: number;
  felzEdgeCount: number;
  watershedMs: number;
  mergeMs: number;
  fusionMs: number;
  crfMs: number;
  recomputed: {
    layer1: boolean;
    layer2: boolean;
  };
  regionCacheHit?: boolean;
}

export interface WorkerResultMessage {
  type: "result";
  id: number;
  width: number;
  height: number;
  imageBuffer: ArrayBuffer | null;
  kMapBuffer: ArrayBuffer | null;
  kRange: KRange;
  kVersion: number;
  stats: WorkerResultStats;
}

export interface WorkerErrorMessage {
  type: "error";
  message: string;
}

export type FromWorkerMessage = WorkerImageReadyMessage | WorkerResultMessage | WorkerErrorMessage;

export type ControlKey = keyof AppParams;
export type ControlType = "range" | "checkbox" | "select";

export interface RangeControlDef {
  key: ControlKey;
  label: string;
  type: "range";
  min: number;
  max: number;
  step: number;
}

export interface CheckboxControlDef {
  key: ControlKey;
  label: string;
  type: "checkbox";
}

export interface SelectControlDef {
  key: ControlKey;
  label: string;
  type: "select";
  options: Array<{ value: string; label: string }>;
}

export type ControlDef = RangeControlDef | CheckboxControlDef | SelectControlDef;

export interface ControlGroupDef {
  title: string;
  controls: ControlDef[];
}

export interface GpuInitResult {
  available: boolean;
  backend: BackendKind;
  reason: string;
}
