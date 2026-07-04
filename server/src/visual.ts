// Visual-regression baseline diffing: pixel-compare two PNG screenshots and
// report how much they differ, producing a highlighted diff image. Differing
// dimensions are treated as a visual change (compared on a max-sized canvas).
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface DiffResult {
  mismatchPct: number; // percentage of pixels that differ, 0-100, rounded to 2 decimals
  diffPng: Buffer; // a PNG (Buffer) visualizing the differences
  width: number;
  height: number;
}

// A minimal valid 1x1 transparent PNG, used as a fallback diff image on error.
const onePxPng = (): Buffer => PNG.sync.write(new PNG({ width: 1, height: 1 }));

// Blit a source PNG into the top-left of a fresh W×H zero-filled RGBA canvas.
const onCanvas = (src: PNG, W: number, H: number): PNG => {
  if (src.width === W && src.height === H) return src;
  const dst = new PNG({ width: W, height: H });
  PNG.bitblt(src, dst, 0, 0, src.width, src.height, 0, 0);
  return dst;
};

// Pixel-diff two PNG image buffers. Handles differing dimensions (a size change IS a
// visual change): compare on a canvas sized to the max width/height of both images,
// placing each image at the top-left; non-overlapping area counts as difference.
export function diffPng(baseline: Buffer, current: Buffer): DiffResult {
  try {
    const a = PNG.sync.read(baseline);
    const b = PNG.sync.read(current);
    const W = Math.max(a.width, b.width);
    const H = Math.max(a.height, b.height);
    if (W <= 0 || H <= 0) return { mismatchPct: 100, diffPng: onePxPng(), width: 0, height: 0 };

    const canvasA = onCanvas(a, W, H);
    const canvasB = onCanvas(b, W, H);
    const diff = new PNG({ width: W, height: H });
    const diffPixels = pixelmatch(canvasA.data, canvasB.data, diff.data, W, H, {
      threshold: 0.1,
      includeAA: true,
    });
    const mismatchPct = Math.round((diffPixels / (W * H)) * 10000) / 100;
    return { mismatchPct, diffPng: PNG.sync.write(diff), width: W, height: H };
  } catch {
    return { mismatchPct: 100, diffPng: onePxPng(), width: 0, height: 0 };
  }
}
