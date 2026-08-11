import type { VisionAnalysisResult } from './protocol';

// ---------------------------------------------------------------------------
// YCrCb Skin Detector (no TF.js dependency — safe to import in service worker)
// Off by default (enableVisionYCrCb = false). Retained as a worked bias
// example for the thesis. See PIVOT_PLAN.md §3 and vision.ts for context.
// ---------------------------------------------------------------------------

export function evaluatePixels(
    pixels: Uint8ClampedArray,
    width: number,
    height: number
): VisionAnalysisResult {
    const totalPixels = width * height;
    let skinPixels = 0;

    for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];

        // RGB → YCrCb
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        const cr = (r - y) * 0.713 + 128;
        const cb = (b - y) * 0.564 + 128;

        // Conservative skin heuristic (see thesis §bias for limitations)
        if (cr > 135 && cr < 180 && cb > 85 && cb < 135) {
            skinPixels++;
        }
    }

    const skinRatio = totalPixels > 0 ? skinPixels / totalPixels : 0;
    let score = 0;
    const reasons: string[] = [];

    if (skinRatio > 0.35) {
        score += 0.8;
        reasons.push(`Very high skin exposure (${(skinRatio * 100).toFixed(1)}%)`);
    } else if (skinRatio > 0.25) {
        score += 0.6;
        reasons.push(`High skin exposure (${(skinRatio * 100).toFixed(1)}%)`);
    } else if (skinRatio > 0.15) {
        score += 0.3;
        reasons.push(`Moderate skin exposure (${(skinRatio * 100).toFixed(1)}%)`);
    }

    return { score: Math.min(score, 1), reasons };
}

