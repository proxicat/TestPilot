import "dotenv/config";

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
}

// Resolve the model config from env, tolerating both OPENAI_* and MIDSCENE_MODEL_* names.
export function resolveModelConfig(
  override?: Partial<ModelConfig>,
): ModelConfig {
  return {
    baseUrl:
      override?.baseUrl ||
      process.env.OPENAI_BASE_URL ||
      process.env.MIDSCENE_MODEL_BASE_URL ||
      "http://127.0.0.1:8010/v1", // no-think proxy (see server/.env); raw model is :8000
    apiKey:
      override?.apiKey ||
      process.env.OPENAI_API_KEY ||
      process.env.MIDSCENE_MODEL_API_KEY ||
      "",
    modelName:
      override?.modelName ||
      process.env.MIDSCENE_MODEL_NAME ||
      "Qwen3.6-35B-A3B-4bit",
  };
}

export const PORT = Number(process.env.PORT) || 5301;

// Screenshot viewport (= the image size sent to the vision model). Midscene resizes
// each screenshot down to the logical viewport before the model call, so shrinking the
// viewport is the agent-layer lever for prompt size. Memory-constrained self-hosted VL
// models (e.g. MLX on Apple Silicon) reject large prompts ("prefill memory guard") on
// content-rich pages; a smaller viewport keeps them under the limit. Tunable via env.
export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}
export function resolveViewport(): Viewport {
  return {
    width: Number(process.env.MIDSCENE_SHOT_WIDTH) || 1024,
    height: Number(process.env.MIDSCENE_SHOT_HEIGHT) || 720,
    // Force DSF=1: on a retina host the shot would otherwise be captured at 2x before
    // Midscene downsizes it — wasted work that doesn't shrink the model image.
    deviceScaleFactor: Number(process.env.MIDSCENE_SHOT_DSF) || 1,
  };
}

// Chain the injected wallet provider talks to (a local Anvil fork by default, but any RPC —
// a Tenderly Virtual TestNet public RPC, a public testnet, etc.). Configurable via env and
// overridable per request.
export interface ChainConfig {
  rpcUrl: string;
  chainId: number;
}

// Runtime override (settable from the UI via POST /api/config), layered over env + defaults.
let chainOverride: Partial<ChainConfig> = {};

export function setChainConfig(patch: Partial<ChainConfig>): ChainConfig {
  chainOverride = {
    ...chainOverride,
    ...(patch.rpcUrl !== undefined ? { rpcUrl: patch.rpcUrl } : {}),
    ...(patch.chainId !== undefined ? { chainId: patch.chainId } : {}),
  };
  return resolveChainConfig();
}

export function resolveChainConfig(override?: Partial<ChainConfig>): ChainConfig {
  return {
    rpcUrl:
      override?.rpcUrl ||
      chainOverride.rpcUrl ||
      process.env.CHAIN_RPC_URL ||
      "http://127.0.0.1:8545",
    chainId:
      override?.chainId ??
      chainOverride.chainId ??
      Number(process.env.CHAIN_ID || 1),
  };
}

// 1x1 red PNG as a data URL — used to probe whether the model accepts image input.
export const PROBE_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
