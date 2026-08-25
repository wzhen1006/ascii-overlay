const DEFAULT_ASCII_CONFIG = {
  background: "#68c0ff",
  backgroundOpacity: 1,
  includeBackgroundInExport: false,
  glyphColor: "#ffffff",
  glyphOpacity: 1,
  charset: "MINIMAX CODE ",
  fontFamily: "SF Mono, Consolas, Liberation Mono, ui-monospace, monospace",
  fontSize: 9,
  cellPadding: { x: 1, y: 2 },
  fps: 30,
  contrast: 2,
  gamma: 0.5,
  invertLuma: true,
  lumaSmoothingMs: 1000,
  maxDpr: 2,
  luma: {
    warpFrequency: 2.1,
    broadFrequency: 3.2,
    detailFrequency: 7.1,
    warpStrength: 1.3,
    speed: 0.035,
  },
  mask: {
    enabled: true,
    resolutionScale: 0.8,
    forceScale: 0.5,
    hoverRadiusPx: 28,
    splashRangePx: 184,
    splashVelocityScale: 3,
    splashForceScale: 2,
    splashDensity: 0.12,
    splashRandomness: 0.14,
    splashThicknessPx: 100,
    splashTravelEasePower: 2.5,
    splashForceDecayPower: 1.2,
    splashDensityDecayPower: 2,
    dragBoostScale: 0.03,
    dragBoostMaxPx: 60,
    dragThresholdPx: 6,
    diffusion: 1.5,
    iterations: 5,
    velocityDissipation: 0.1,
    densityDissipation: 0.1,
    strength: 0.9,
    project: true,
    projectIterations: 10,
  },
  safeArea: {
    enabled: true,
    fadeSize: 60,
    paddingPx: 0,
  },
};

const ASCII_CONFIG = structuredClone(DEFAULT_ASCII_CONFIG);

const FONT_ASPECT_FALLBACK = 5 / 3;
const canvas = document.querySelector("#ascii-canvas");
const container = document.querySelector("#ascii-field");
const controlPanel = document.querySelector("#control-panel");
const controlsForm = document.querySelector("#controls-form");
const context = canvas.getContext("2d", { alpha: true });
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const SAFE_AREA_TARGET_SELECTOR = [
  "[data-ascii-safe-area]",
  "[data-ascii-overlay-content] h1",
  "[data-ascii-overlay-content] h2",
  "[data-ascii-overlay-content] h3",
  "[data-ascii-overlay-content] h4",
  "[data-ascii-overlay-content] h5",
  "[data-ascii-overlay-content] h6",
  "[data-ascii-overlay-content] p",
  "[data-ascii-overlay-content] li",
  "[data-ascii-overlay-content] blockquote",
  "[data-ascii-overlay-content] button",
  "[data-ascii-overlay-content] [role='button']",
  "[data-ascii-overlay-content] img",
].join(",");

const atlasCanvas = document.createElement("canvas");
const atlasContext = atlasCanvas.getContext("2d");

const runtime = {
  layout: null,
  fluid: null,
  luma: null,
  smoothedLuma: null,
  densityMask: null,
  lumaInitialized: false,
  atlasColor: "",
  frameRequest: 0,
  lastRenderTime: null,
  lastTickTime: 0,
  splashes: [],
  pointerId: null,
  pointerStart: null,
  pointerLast: null,
  pointerDragging: false,
  safeAreaRects: [],
  safeAreaDirty: true,
  safeAreaTargets: new Set(),
};

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function smooth01(value) {
  const amount = clamp01(value);
  return amount * amount * (3 - 2 * amount);
}

function cellIndex(x, y, width) {
  return x + y * width;
}

function measureGlyph(metrics, fontSize) {
  const hasLeft = Number.isFinite(metrics.actualBoundingBoxLeft);
  const hasRight = Number.isFinite(metrics.actualBoundingBoxRight);
  const left = hasLeft ? metrics.actualBoundingBoxLeft : 0;
  const right = hasRight ? metrics.actualBoundingBoxRight : metrics.width;
  let width = hasLeft && hasRight ? left + right : metrics.width || fontSize;
  if (width === 0 && metrics.width) width = metrics.width;
  return {
    width,
    left,
    ascent: Number.isFinite(metrics.actualBoundingBoxAscent)
      ? metrics.actualBoundingBoxAscent
      : fontSize * 0.8,
    descent: Number.isFinite(metrics.actualBoundingBoxDescent)
      ? metrics.actualBoundingBoxDescent
      : fontSize * 0.2,
  };
}

function getFontAspectRatio() {
  const previousFont = context.font;
  context.font = `100px ${ASCII_CONFIG.fontFamily}`;
  const metrics = context.measureText("M");
  context.font = previousFont;
  const ascent = Number.isFinite(metrics.actualBoundingBoxAscent)
    ? metrics.actualBoundingBoxAscent
    : 80;
  const descent = Number.isFinite(metrics.actualBoundingBoxDescent)
    ? metrics.actualBoundingBoxDescent
    : 20;
  const ratio = (ascent + descent) / (metrics.width || 60);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : FONT_ASPECT_FALLBACK;
}

function createLayout(widthCss, heightCss) {
  const dpr = widthCss > 0 && heightCss > 0
    ? Math.min(window.devicePixelRatio || 1, ASCII_CONFIG.maxDpr)
    : 1;
  const glyphHeight = ASCII_CONFIG.fontSize;
  const glyphWidth = Math.max(1, glyphHeight / getFontAspectRatio());
  const padX = Math.max(0, ASCII_CONFIG.cellPadding.x);
  const padY = Math.max(0, ASCII_CONFIG.cellPadding.y);
  const cellWidth = Math.max(1 / dpr, glyphWidth + padX * 2);
  const cellHeight = Math.max(1 / dpr, glyphHeight + padY * 2);
  const cols = widthCss > 0 ? Math.max(1, Math.floor(widthCss / cellWidth)) : 0;
  const rows = heightCss > 0 ? Math.max(1, Math.floor(heightCss / cellHeight)) : 0;
  return {
    widthCss,
    heightCss,
    drawWidth: widthCss,
    drawHeight: heightCss,
    offsetX: 0,
    offsetY: 0,
    dpr,
    cols,
    rows,
    glyphWidth,
    glyphHeight,
    cellWidth,
    cellHeight,
    padX,
    padY,
    tileWidth: Math.max(1, Math.round(glyphWidth * dpr)),
    tileHeight: Math.max(1, Math.round(glyphHeight * dpr)),
    spaceIndex: ASCII_CONFIG.charset.indexOf(" "),
  };
}

function sameLayout(left, right) {
  if (!left || !right) return false;
  return left.widthCss === right.widthCss
    && left.heightCss === right.heightCss
    && left.dpr === right.dpr
    && left.cols === right.cols
    && left.rows === right.rows
    && left.tileWidth === right.tileWidth
    && left.tileHeight === right.tileHeight;
}

function buildGlyphAtlas(fill = getComputedStyle(canvas).color) {
  const layout = runtime.layout;
  if (!layout?.tileWidth || !layout.tileHeight) return;
  const charset = ASCII_CONFIG.charset;
  atlasCanvas.width = layout.tileWidth * charset.length;
  atlasCanvas.height = layout.tileHeight;
  atlasContext.clearRect(0, 0, atlasCanvas.width, atlasCanvas.height);
  atlasContext.imageSmoothingEnabled = false;

  const initialFontSize = layout.tileHeight;
  atlasContext.font = `${initialFontSize}px ${ASCII_CONFIG.fontFamily}`;
  const inset = Math.min(1, Math.floor(Math.min(layout.tileWidth, layout.tileHeight) / 2));
  const availableWidth = Math.max(1, layout.tileWidth - inset * 2);
  const availableHeight = Math.max(1, layout.tileHeight - inset * 2);
  let maxWidth = 0;
  let maxAscent = 0;
  let maxDescent = 0;

  for (const glyph of charset) {
    const measured = measureGlyph(atlasContext.measureText(glyph), initialFontSize);
    maxWidth = Math.max(maxWidth, measured.width);
    maxAscent = Math.max(maxAscent, measured.ascent);
    maxDescent = Math.max(maxDescent, measured.descent);
  }

  const widthScale = maxWidth > 0 ? (availableWidth * 0.92) / maxWidth : 1;
  const totalHeight = maxAscent + maxDescent;
  const heightScale = totalHeight > 0 ? availableHeight / totalHeight : 1;
  const scale = Number.isFinite(widthScale) && Number.isFinite(heightScale)
    ? Math.min(widthScale, heightScale)
    : 1;
  const atlasFontSize = Number.isFinite(scale) && scale > 0
    ? initialFontSize * scale
    : initialFontSize;

  atlasContext.font = `${atlasFontSize}px ${ASCII_CONFIG.fontFamily}`;
  atlasContext.fillStyle = fill;
  atlasContext.textAlign = "left";
  atlasContext.textBaseline = "alphabetic";
  const glyphMetrics = Array.from(charset, (glyph) => (
    measureGlyph(atlasContext.measureText(glyph), atlasFontSize)
  ));
  const descent = glyphMetrics.reduce((maximum, metrics) => Math.max(maximum, metrics.descent), 0);
  const baseline = Math.max(inset, Math.floor(inset + availableHeight - descent));

  glyphMetrics.forEach((metrics, index) => {
    const glyph = charset[index];
    const x = Math.round(
      index * layout.tileWidth
      + inset
      + (availableWidth - metrics.width) / 2
      + metrics.left,
    );
    atlasContext.fillText(glyph, x, baseline);
  });
  runtime.atlasColor = fill;
}

function createFluid(width, height) {
  const size = width * height;
  return {
    width,
    height,
    size,
    density: new Float32Array(size),
    density0: new Float32Array(size),
    velocityX: new Float32Array(size),
    velocityY: new Float32Array(size),
    velocityX0: new Float32Array(size),
    velocityY0: new Float32Array(size),
    pressure: new Float32Array(size),
    divergence: new Float32Array(size),
  };
}

function ensureFluid() {
  const layout = runtime.layout;
  if (!layout?.cols || !layout.rows) return null;
  const width = Math.max(1, Math.round(layout.cols * ASCII_CONFIG.mask.resolutionScale));
  const height = Math.max(1, Math.round(layout.rows * ASCII_CONFIG.mask.resolutionScale));
  if (!runtime.fluid || runtime.fluid.width !== width || runtime.fluid.height !== height) {
    runtime.fluid = createFluid(width, height);
  }
  return runtime.fluid;
}

function resize() {
  const bounds = container.getBoundingClientRect();
  const nextLayout = createLayout(Math.max(0, bounds.width), Math.max(0, bounds.height));
  if (sameLayout(runtime.layout, nextLayout)) return;
  runtime.layout = nextLayout;

  canvas.width = Math.max(1, Math.round(nextLayout.widthCss * nextLayout.dpr));
  canvas.height = Math.max(1, Math.round(nextLayout.heightCss * nextLayout.dpr));
  canvas.style.width = `${nextLayout.widthCss}px`;
  canvas.style.height = `${nextLayout.heightCss}px`;
  const scaleX = nextLayout.widthCss ? canvas.width / nextLayout.widthCss : 1;
  const scaleY = nextLayout.heightCss ? canvas.height / nextLayout.heightCss : 1;
  context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  context.imageSmoothingEnabled = false;

  const size = nextLayout.cols * nextLayout.rows;
  runtime.luma = new Float32Array(size);
  runtime.smoothedLuma = new Float32Array(size);
  runtime.densityMask = new Float32Array(size);
  runtime.lumaInitialized = false;
  runtime.fluid = null;
  runtime.splashes.length = 0;
  ensureFluid();
  buildGlyphAtlas();
  canvas.dataset.asciiOverlayState = nextLayout.cols && nextLayout.rows ? "ready" : "no-size";
}

function bilinearSample(field, x, y, width, height) {
  const safeX = clamp(x, 0, width - 1);
  const safeY = clamp(y, 0, height - 1);
  const x0 = Math.floor(safeX);
  const y0 = Math.floor(safeY);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const amountX = safeX - x0;
  const amountY = safeY - y0;
  const topLeft = field[cellIndex(x0, y0, width)];
  const topRight = field[cellIndex(x1, y0, width)];
  const bottomLeft = field[cellIndex(x0, y1, width)];
  const bottomRight = field[cellIndex(x1, y1, width)];
  const top = topLeft + (topRight - topLeft) * amountX;
  const bottom = bottomLeft + (bottomRight - bottomLeft) * amountX;
  return top + (bottom - top) * amountY;
}

function advect(output, source, velocityX, velocityY, delta, width, height) {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = cellIndex(x, y, width);
      output[index] = bilinearSample(
        source,
        x - velocityX[index] * delta,
        y - velocityY[index] * delta,
        width,
        height,
      );
    }
  }
}

function diffuse(output, source, amount, iterations, width, height) {
  if (iterations <= 0 || amount <= 0) {
    output.set(source);
    return;
  }
  output.set(source);
  const divisor = 1 / (1 + 4 * amount);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = cellIndex(x, y, width);
        const left = output[cellIndex(Math.max(0, x - 1), y, width)];
        const right = output[cellIndex(Math.min(width - 1, x + 1), y, width)];
        const top = output[cellIndex(x, Math.max(0, y - 1), width)];
        const bottom = output[cellIndex(x, Math.min(height - 1, y + 1), width)];
        output[index] = (source[index] + amount * (left + right + top + bottom)) * divisor;
      }
    }
  }
}

function projectVelocity(fluid, iterations) {
  if (iterations <= 0) return;
  const {
    width, height, velocityX, velocityY, pressure, divergence,
  } = fluid;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = cellIndex(x, y, width);
      const left = velocityX[cellIndex(Math.max(0, x - 1), y, width)];
      const right = velocityX[cellIndex(Math.min(width - 1, x + 1), y, width)];
      const top = velocityY[cellIndex(x, Math.max(0, y - 1), width)];
      const bottom = velocityY[cellIndex(x, Math.min(height - 1, y + 1), width)];
      divergence[index] = -0.5 * (right - left + bottom - top);
      pressure[index] = 0;
    }
  }
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = cellIndex(x, y, width);
        const left = pressure[cellIndex(Math.max(0, x - 1), y, width)];
        const right = pressure[cellIndex(Math.min(width - 1, x + 1), y, width)];
        const top = pressure[cellIndex(x, Math.max(0, y - 1), width)];
        const bottom = pressure[cellIndex(x, Math.min(height - 1, y + 1), width)];
        pressure[index] = (divergence[index] + left + right + top + bottom) / 4;
      }
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = cellIndex(x, y, width);
      const left = pressure[cellIndex(Math.max(0, x - 1), y, width)];
      const right = pressure[cellIndex(Math.min(width - 1, x + 1), y, width)];
      const top = pressure[cellIndex(x, Math.max(0, y - 1), width)];
      const bottom = pressure[cellIndex(x, Math.min(height - 1, y + 1), width)];
      velocityX[index] -= 0.5 * (right - left);
      velocityY[index] -= 0.5 * (bottom - top);
    }
  }
}

function injectDisk(fluid, centerX, centerY, forceX, forceY, density, radius) {
  if (radius <= 0 || density <= 0) return;
  const radiusSquared = radius * radius;
  const startX = Math.max(0, Math.floor(centerX - radius));
  const endX = Math.min(fluid.width - 1, Math.ceil(centerX + radius));
  const startY = Math.max(0, Math.floor(centerY - radius));
  const endY = Math.min(fluid.height - 1, Math.ceil(centerY + radius));
  for (let y = startY; y <= endY; y += 1) {
    const deltaY = y - centerY;
    const deltaYSquared = deltaY * deltaY;
    if (deltaYSquared > radiusSquared) continue;
    for (let x = startX; x <= endX; x += 1) {
      const deltaX = x - centerX;
      const distanceSquared = deltaX * deltaX + deltaYSquared;
      if (distanceSquared > radiusSquared) continue;
      const influence = smooth01(1 - Math.sqrt(distanceSquared) / radius);
      const index = cellIndex(x, y, fluid.width);
      fluid.velocityX[index] += forceX * influence;
      fluid.velocityY[index] += forceY * influence;
      fluid.density[index] = clamp01(fluid.density[index] + density * influence);
    }
  }
}

function injectSplashRing(
  fluid,
  centerX,
  centerY,
  force,
  density,
  radiusPx,
  thicknessPx,
  randomness,
  seed,
  pixelPerCellX,
  pixelPerCellY,
  progress,
) {
  if (
    pixelPerCellX <= 0
    || pixelPerCellY <= 0
    || (force <= 0 && density <= 0)
    || thicknessPx <= 0
  ) return;
  const extent = radiusPx + thicknessPx;
  const extentX = extent / pixelPerCellX;
  const extentY = extent / pixelPerCellY;
  const startX = Math.max(0, Math.floor(centerX - extentX));
  const endX = Math.min(fluid.width - 1, Math.ceil(centerX + extentX));
  const startY = Math.max(0, Math.floor(centerY - extentY));
  const endY = Math.min(fluid.height - 1, Math.ceil(centerY + extentY));
  const safeRandomness = clamp01(randomness);

  for (let y = startY; y <= endY; y += 1) {
    const deltaY = (y - centerY) * pixelPerCellY;
    for (let x = startX; x <= endX; x += 1) {
      const deltaX = (x - centerX) * pixelPerCellX;
      const distance = Math.hypot(deltaX, deltaY);
      const angle = Math.atan2(deltaY, deltaX);
      const wobble = 0.5 * Math.sin(6 * angle + seed)
        + 0.25 * Math.sin(3 * angle + 0.05 * distance + 0.3 * seed)
        + 0.5;
      const reveal = 0.35 + 0.65 * progress;
      const radiusVariation = clamp(
        1 + safeRandomness * (2 * wobble - 1) * reveal,
        0.6,
        1.6,
      );
      const distanceFromRing = Math.abs(distance - radiusPx * radiusVariation);
      if (distanceFromRing > thicknessPx) continue;
      const influence = smooth01(1 - distanceFromRing / thicknessPx);
      const amplitudeVariation = clamp(
        1 + safeRandomness * (2 * wobble - 1) * reveal,
        0.4,
        2.2,
      );
      const index = cellIndex(x, y, fluid.width);
      if (force !== 0 && distance > 0) {
        const inverseDistance = 1 / distance;
        fluid.velocityX[index] += deltaX * inverseDistance * force * amplitudeVariation * influence;
        fluid.velocityY[index] += deltaY * inverseDistance * force * amplitudeVariation * influence;
      }
      if (density > 0) {
        fluid.density[index] = clamp01(
          fluid.density[index] + density * amplitudeVariation * influence,
        );
      }
    }
  }
}

function applySplashes(now, deltaMs) {
  const fluid = ensureFluid();
  const layout = runtime.layout;
  if (!fluid || !runtime.splashes.length || !layout.drawWidth || !layout.drawHeight) return;
  const mask = ASCII_CONFIG.mask;
  const pixelPerCellX = fluid.width > 1 ? layout.drawWidth / (fluid.width - 1) : 0;
  const pixelPerCellY = fluid.height > 1 ? layout.drawHeight / (fluid.height - 1) : 0;
  if (pixelPerCellX <= 0 || pixelPerCellY <= 0) return;

  const travelSpeed = 240 * mask.splashVelocityScale;
  const frameScale = clamp(deltaMs / 16.67, 0.5, 2);
  const activeSplashes = [];
  for (const splash of runtime.splashes) {
    const elapsed = now - splash.startedAt;
    if (elapsed < 0) {
      activeSplashes.push(splash);
      continue;
    }
    const maxRadius = Math.max(1, splash.maxRadiusPx);
    if (travelSpeed <= 0) continue;
    const duration = (maxRadius / travelSpeed) * 1000;
    if (elapsed > duration) continue;
    const linearProgress = Math.min(1, elapsed / duration);
    const travel = 1 - Math.pow(1 - linearProgress, mask.splashTravelEasePower);
    const currentRadius = Math.max(0, travel * maxRadius);
    const remaining = Math.max(0, 1 - linearProgress);
    const forceDecay = Math.pow(remaining, mask.splashForceDecayPower);
    const density = mask.splashDensity
      * Math.pow(remaining, mask.splashDensityDecayPower)
      * frameScale;
    const force = mask.forceScale
      * mask.splashForceScale
      * mask.splashVelocityScale
      * forceDecay
      * 20;

    injectSplashRing(
      fluid,
      splash.normalizedX * (fluid.width - 1),
      splash.normalizedY * (fluid.height - 1),
      force,
      density,
      currentRadius,
      splash.thicknessPx,
      mask.splashRandomness,
      splash.seed,
      pixelPerCellX,
      pixelPerCellY,
      travel,
    );
    activeSplashes.push(splash);
  }
  runtime.splashes = activeSplashes;
}

function simulateFluid(deltaSeconds) {
  const fluid = ensureFluid();
  if (!fluid || deltaSeconds <= 0) return;
  const delta = Math.min(deltaSeconds, 0.1);
  const mask = ASCII_CONFIG.mask;
  const {
    width,
    height,
    size,
    velocityX,
    velocityY,
    velocityX0,
    velocityY0,
    density,
    density0,
  } = fluid;

  velocityX0.set(velocityX);
  velocityY0.set(velocityY);
  diffuse(velocityX, velocityX0, mask.diffusion, mask.iterations, width, height);
  diffuse(velocityY, velocityY0, mask.diffusion, mask.iterations, width, height);
  if (mask.project) projectVelocity(fluid, mask.projectIterations);

  velocityX0.set(velocityX);
  velocityY0.set(velocityY);
  advect(velocityX, velocityX0, velocityX0, velocityY0, delta, width, height);
  advect(velocityY, velocityY0, velocityX0, velocityY0, delta, width, height);
  if (mask.project) projectVelocity(fluid, mask.projectIterations);

  density0.set(density);
  advect(density, density0, velocityX, velocityY, delta, width, height);
  if (mask.velocityDissipation > 0) {
    const decay = Math.exp(-mask.velocityDissipation * delta);
    for (let index = 0; index < size; index += 1) {
      velocityX[index] *= decay;
      velocityY[index] *= decay;
    }
  }
  if (mask.densityDissipation > 0) {
    const decay = Math.exp(-mask.densityDissipation * delta);
    for (let index = 0; index < size; index += 1) density[index] *= decay;
  }
}

function sampleFluidDensity() {
  const layout = runtime.layout;
  const fluid = runtime.fluid;
  const target = runtime.densityMask;
  if (!layout || !fluid || !target) return;
  const scaleX = layout.cols > 1 ? (fluid.width - 1) / (layout.cols - 1) : 0;
  const scaleY = layout.rows > 1 ? (fluid.height - 1) / (layout.rows - 1) : 0;
  for (let row = 0; row < layout.rows; row += 1) {
    const fluidY = row * scaleY;
    const rowOffset = row * layout.cols;
    for (let column = 0; column < layout.cols; column += 1) {
      target[rowOffset + column] = clamp01(
        bilinearSample(fluid.density, column * scaleX, fluidY, fluid.width, fluid.height),
      );
    }
  }
}

function hash2d(x, y) {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return value - Math.floor(value);
}

function valueNoise(x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fractionX = smooth01(x - x0);
  const fractionY = smooth01(y - y0);
  const topLeft = hash2d(x0, y0);
  const top = topLeft + (hash2d(x0 + 1, y0) - topLeft) * fractionX;
  const bottomLeft = hash2d(x0, y0 + 1);
  const bottom = bottomLeft + (hash2d(x0 + 1, y0 + 1) - bottomLeft) * fractionX;
  return top + (bottom - top) * fractionY;
}

function updateProceduralLuma(now, deltaMs) {
  const layout = runtime.layout;
  if (!layout || !runtime.luma || !runtime.smoothedLuma) return;
  const lumaConfig = ASCII_CONFIG.luma;
  const time = now * 0.001 * lumaConfig.speed;
  const aspect = layout.widthCss / Math.max(layout.heightCss, 1);
  const smoothing = ASCII_CONFIG.lumaSmoothingMs > 0
    ? clamp01(1 - Math.exp(-deltaMs / ASCII_CONFIG.lumaSmoothingMs))
    : 1;
  for (let row = 0; row < layout.rows; row += 1) {
    const normalizedY = row / Math.max(1, layout.rows - 1);
    for (let column = 0; column < layout.cols; column += 1) {
      const normalizedX = column / Math.max(1, layout.cols - 1);
      const x = (normalizedX - 0.5) * aspect;
      const y = normalizedY - 0.5;
      const warpX = valueNoise(
        x * lumaConfig.warpFrequency + time,
        y * lumaConfig.warpFrequency - time * 0.8,
      );
      const warpY = valueNoise(
        x * lumaConfig.warpFrequency + 8.7 - time * 0.7,
        y * lumaConfig.warpFrequency + 3.2 + time,
      );
      const broad = valueNoise(
        x * lumaConfig.broadFrequency + warpX * lumaConfig.warpStrength,
        y * lumaConfig.broadFrequency + warpY * lumaConfig.warpStrength,
      );
      const detail = valueNoise(
        x * lumaConfig.detailFrequency - warpY * 0.8,
        y * lumaConfig.detailFrequency + warpX * 0.8,
      );
      const value = clamp01(0.12 + (broad * 0.72 + detail * 0.28) * 0.94);
      const index = cellIndex(column, row, layout.cols);
      runtime.luma[index] = value;
      runtime.smoothedLuma[index] = runtime.lumaInitialized
        ? runtime.smoothedLuma[index] + (value - runtime.smoothedLuma[index]) * smoothing
        : value;
    }
  }
  runtime.lumaInitialized = true;
}

function mapLumaToGlyph(luma) {
  let mapped = luma;
  if (ASCII_CONFIG.contrast !== 1) {
    mapped = (mapped - 0.5) * ASCII_CONFIG.contrast + 0.5;
  }
  mapped = clamp01(mapped);
  if (ASCII_CONFIG.gamma !== 1) mapped = Math.pow(mapped, ASCII_CONFIG.gamma);
  mapped = clamp01(mapped);
  if (ASCII_CONFIG.invertLuma) mapped = 1 - mapped;
  return clamp(
    Math.floor(mapped * ASCII_CONFIG.charset.length),
    0,
    ASCII_CONFIG.charset.length - 1,
  );
}

function markSafeAreaDirty() {
  runtime.safeAreaDirty = true;
}

const safeAreaResizeObserver = new ResizeObserver(markSafeAreaDirty);

function syncSafeAreaTargets() {
  runtime.safeAreaDirty = false;
  const targets = ASCII_CONFIG.safeArea.enabled
    ? new Set(Array.from(document.querySelectorAll(SAFE_AREA_TARGET_SELECTOR)).filter(
      (target) => target instanceof HTMLElement && !target.closest("[data-controls-ui]"),
    ))
    : new Set();
  for (const target of runtime.safeAreaTargets) {
    if (!targets.has(target)) safeAreaResizeObserver.unobserve(target);
  }
  for (const target of targets) {
    if (!runtime.safeAreaTargets.has(target)) safeAreaResizeObserver.observe(target);
  }
  runtime.safeAreaTargets = targets;
}

function isSafeAreaTargetVisible(target) {
  for (let element = target; element instanceof HTMLElement; element = element.parentElement) {
    const styles = getComputedStyle(element);
    if (
      styles.display === "none"
      || styles.visibility === "hidden"
      || styles.visibility === "collapse"
      || styles.contentVisibility === "hidden"
      || Number.parseFloat(styles.opacity) <= 0
    ) return false;
  }
  return true;
}

function collectSafeAreaRects() {
  if (runtime.safeAreaDirty) syncSafeAreaTargets();
  runtime.safeAreaRects = [];
  if (!ASCII_CONFIG.safeArea.enabled) return;

  const containerBounds = container.getBoundingClientRect();
  if (!containerBounds.width || !containerBounds.height) return;
  const padding = Math.max(0, ASCII_CONFIG.safeArea.paddingPx);

  for (const target of runtime.safeAreaTargets) {
    if (!isSafeAreaTargetVisible(target)) continue;

    const bounds = target.getBoundingClientRect();
    if (!bounds.width || !bounds.height) continue;
    const left = Math.max(0, bounds.left - containerBounds.left - padding);
    const top = Math.max(0, bounds.top - containerBounds.top - padding);
    const right = Math.min(containerBounds.width, bounds.right - containerBounds.left + padding);
    const bottom = Math.min(containerBounds.height, bounds.bottom - containerBounds.top + padding);
    if (right <= left || bottom <= top) continue;
    runtime.safeAreaRects.push({ left, top, right, bottom });
  }
}

function getSafeAreaAlpha(x, y, rects, fadeSize) {
  if (!rects.length) return 1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const rect of rects) {
    const distanceX = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    const distanceY = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    const distance = Math.hypot(distanceX, distanceY);
    if (distance === 0) return 0;
    nearestDistance = Math.min(nearestDistance, distance);
  }
  return fadeSize <= 0 ? 1 : clamp01(nearestDistance / fadeSize);
}

function render() {
  const layout = runtime.layout;
  if (!layout?.cols || !layout.rows) return;
  const color = getComputedStyle(canvas).color;
  if (color !== runtime.atlasColor) buildGlyphAtlas(color);
  context.clearRect(0, 0, layout.widthCss, layout.heightCss);
  context.globalAlpha = 1;
  if (reducedMotion.matches) {
    canvas.dataset.asciiOverlayState = "reduced-motion";
    return;
  }

  if (ASCII_CONFIG.safeArea.enabled || runtime.safeAreaDirty) collectSafeAreaRects();
  const safeAreaRects = ASCII_CONFIG.safeArea.enabled ? runtime.safeAreaRects : [];
  const safeAreaFadeSize = Math.max(0, ASCII_CONFIG.safeArea.fadeSize);
  let currentAlpha = 1;

  for (let row = 0; row < layout.rows; row += 1) {
    const rowOffset = row * layout.cols;
    for (let column = 0; column < layout.cols; column += 1) {
      const index = rowOffset + column;
      const density = runtime.densityMask[index];
      let luma = runtime.smoothedLuma[index];
      luma = ASCII_CONFIG.invertLuma
        ? luma * density
        : luma * density + (1 - density);
      const glyphIndex = mapLumaToGlyph(luma);
      if (glyphIndex === layout.spaceIndex && layout.spaceIndex >= 0) continue;
      const safeAreaAlpha = getSafeAreaAlpha(
        layout.offsetX + column * layout.cellWidth + layout.cellWidth / 2,
        layout.offsetY + row * layout.cellHeight + layout.cellHeight / 2,
        safeAreaRects,
        safeAreaFadeSize,
      );
      if (safeAreaAlpha <= 0) continue;
      if (safeAreaAlpha !== currentAlpha) {
        context.globalAlpha = safeAreaAlpha;
        currentAlpha = safeAreaAlpha;
      }
      context.drawImage(
        atlasCanvas,
        glyphIndex * layout.tileWidth,
        0,
        layout.tileWidth,
        layout.tileHeight,
        layout.offsetX + column * layout.cellWidth + layout.padX,
        layout.offsetY + row * layout.cellHeight + layout.padY,
        layout.glyphWidth,
        layout.glyphHeight,
      );
    }
  }
  context.globalAlpha = 1;
  canvas.dataset.asciiOverlayState = "running";
}

function tick(now) {
  runtime.frameRequest = requestAnimationFrame(tick);
  if (document.hidden) return;
  const frameInterval = 1000 / ASCII_CONFIG.fps;
  if (now - runtime.lastTickTime < frameInterval) return;
  runtime.lastTickTime = now;
  resize();
  const deltaMs = runtime.lastRenderTime == null ? 0 : now - runtime.lastRenderTime;
  runtime.lastRenderTime = now;
  updateProceduralLuma(now, deltaMs);
  if (!reducedMotion.matches) {
    applySplashes(now, deltaMs);
    simulateFluid(deltaMs / 1000);
    sampleFluidDensity();
  }
  render();
}

function getPointerPosition(event) {
  const layout = runtime.layout;
  if (!layout?.drawWidth || !layout.drawHeight) return null;
  const bounds = container.getBoundingClientRect();
  const x = event.clientX - bounds.left;
  const y = event.clientY - bounds.top;
  if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) return null;
  const localX = x - layout.offsetX;
  const localY = y - layout.offsetY;
  if (localX < 0 || localY < 0 || localX > layout.drawWidth || localY > layout.drawHeight) {
    return null;
  }
  return { x, y, localX, localY };
}

const CONTROL_GROUPS = [
  {
    title: "外观与网格",
    description: "改变字符、字号、密度映射和刷新节奏。",
    open: true,
    controls: [
      { path: "background", label: "背景颜色", type: "color", effect: "background" },
      {
        path: "backgroundOpacity",
        label: "背景不透明度",
        min: 0,
        max: 1,
        step: 0.01,
        percent: true,
        effect: "background",
      },
      {
        path: "includeBackgroundInExport",
        label: "导出包含背景",
        type: "toggle",
      },
      { path: "glyphColor", label: "字符颜色", type: "color", effect: "glyph" },
      {
        path: "glyphOpacity",
        label: "字符不透明度",
        min: 0,
        max: 1,
        step: 0.01,
        percent: true,
        effect: "glyph",
      },
      { path: "charset", label: "字符阶梯", type: "text", effect: "layout" },
      { path: "fontSize", label: "字号", min: 5, max: 18, step: 1, unit: "px", effect: "layout" },
      { path: "cellPadding.x", label: "水平间距", min: 0, max: 6, step: 0.5, unit: "px", effect: "layout" },
      { path: "cellPadding.y", label: "垂直间距", min: 0, max: 8, step: 0.5, unit: "px", effect: "layout" },
      { path: "contrast", label: "对比度", min: 0.5, max: 4, step: 0.1 },
      { path: "gamma", label: "Gamma", min: 0.1, max: 2, step: 0.05 },
      { path: "invertLuma", label: "反转明暗", type: "toggle" },
      { path: "fps", label: "字符刷新率", min: 10, max: 60, step: 1, unit: "fps" },
      { path: "lumaSmoothingMs", label: "明暗平滑", min: 0, max: 2500, step: 50, unit: "ms" },
    ],
  },
  {
    title: "程序明暗场",
    description: "只改变字符选择的有机纹理，不改变背景颜色。",
    controls: [
      { path: "luma.warpFrequency", label: "扭曲频率", min: 0.5, max: 6, step: 0.1 },
      { path: "luma.broadFrequency", label: "大结构频率", min: 0.5, max: 8, step: 0.1 },
      { path: "luma.detailFrequency", label: "细节频率", min: 1, max: 16, step: 0.1 },
      { path: "luma.warpStrength", label: "扭曲强度", min: 0, max: 3, step: 0.05 },
      { path: "luma.speed", label: "流动速度", min: 0, max: 0.15, step: 0.005 },
    ],
  },
  {
    title: "内容避让",
    description: "让字符避开叠加在画布上的正文、按钮和图片。",
    open: true,
    controls: [
      { path: "safeArea.enabled", label: "启用内容避让", type: "toggle", effect: "safeArea" },
      {
        path: "safeArea.fadeSize",
        label: "渐隐距离",
        min: 0,
        max: 160,
        step: 4,
        unit: "px",
        effect: "safeArea",
      },
      {
        path: "safeArea.paddingPx",
        label: "内容外扩",
        min: 0,
        max: 64,
        step: 2,
        unit: "px",
        effect: "safeArea",
      },
    ],
  },
  {
    title: "Hover 与拖拽",
    description: "控制鼠标经过时的揭示范围、推力和拖尾。",
    open: true,
    controls: [
      { path: "mask.hoverRadiusPx", label: "Hover 半径", min: 4, max: 120, step: 1, unit: "px" },
      { path: "mask.strength", label: "揭示强度", min: 0.05, max: 1, step: 0.05 },
      { path: "mask.forceScale", label: "指针推力", min: 0.05, max: 2, step: 0.05 },
      { path: "mask.dragBoostScale", label: "拖拽速度增益", min: 0, max: 0.12, step: 0.005 },
      { path: "mask.dragBoostMaxPx", label: "拖拽扩圈上限", min: 0, max: 160, step: 2, unit: "px" },
      { path: "mask.dragThresholdPx", label: "拖拽判定距离", min: 0, max: 30, step: 1, unit: "px" },
    ],
  },
  {
    title: "点击波纹",
    description: "控制波纹范围、厚度、速度、形变和衰减。",
    open: true,
    controls: [
      { path: "mask.splashRangePx", label: "最大范围", min: 20, max: 500, step: 4, unit: "px" },
      { path: "mask.splashThicknessPx", label: "波纹厚度", min: 4, max: 220, step: 2, unit: "px" },
      { path: "mask.splashVelocityScale", label: "扩散速度系数", min: 0.5, max: 8, step: 0.1 },
      { path: "mask.splashForceScale", label: "波纹推力", min: 0, max: 6, step: 0.1 },
      { path: "mask.splashDensity", label: "波纹密度", min: 0.01, max: 0.5, step: 0.01 },
      { path: "mask.splashRandomness", label: "边缘随机度", min: 0, max: 1, step: 0.01 },
      { path: "mask.splashTravelEasePower", label: "扩散缓动指数", min: 0.5, max: 6, step: 0.1 },
      { path: "mask.splashForceDecayPower", label: "推力衰减指数", min: 0.1, max: 5, step: 0.1 },
      { path: "mask.splashDensityDecayPower", label: "密度衰减指数", min: 0.1, max: 6, step: 0.1 },
    ],
  },
  {
    title: "流体模拟",
    description: "高级参数。数值越高通常越柔和，也可能增加计算量。",
    controls: [
      { path: "mask.resolutionScale", label: "流体分辨率", min: 0.2, max: 1, step: 0.05, effect: "fluid" },
      { path: "mask.diffusion", label: "速度扩散", min: 0, max: 4, step: 0.1 },
      { path: "mask.iterations", label: "扩散迭代", min: 0, max: 12, step: 1 },
      { path: "mask.velocityDissipation", label: "速度耗散", min: 0, max: 3, step: 0.05 },
      { path: "mask.densityDissipation", label: "密度耗散", min: 0, max: 3, step: 0.05 },
      { path: "mask.project", label: "压力投影", type: "toggle" },
      { path: "mask.projectIterations", label: "压力迭代", min: 0, max: 24, step: 1 },
    ],
  },
];

function getConfigValue(path) {
  return path.split(".").reduce((value, key) => value[key], ASCII_CONFIG);
}

function setConfigValue(path, value) {
  const keys = path.split(".");
  const lastKey = keys.pop();
  const target = keys.reduce((object, key) => object[key], ASCII_CONFIG);
  target[lastKey] = value;
}

function clearFluid() {
  runtime.fluid = null;
  runtime.splashes.length = 0;
  runtime.pointerStart = null;
  runtime.pointerLast = null;
  runtime.pointerDragging = false;
  runtime.densityMask?.fill(0);
  ensureFluid();
  render();
}

function parseHexColor(hex) {
  const normalized = hex.replace("#", "").trim();
  const expanded = normalized.length === 3
    ? normalized.split("").map((character) => character.repeat(2)).join("")
    : normalized;
  if (!/^[\da-f]{6}$/i.test(expanded)) return null;
  const color = Number.parseInt(expanded, 16);
  return {
    red: (color >> 16) & 255,
    green: (color >> 8) & 255,
    blue: color & 255,
  };
}

function hexToRgba(hex, opacity) {
  const color = parseHexColor(hex);
  if (!color) return "transparent";
  return `rgba(${color.red}, ${color.green}, ${color.blue}, ${clamp01(opacity)})`;
}

function decontaminateTransparentPixels(imageData, fallbackHex) {
  const color = parseHexColor(fallbackHex);
  if (!color) return false;
  const pixels = imageData.data;
  let changed = false;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] !== 0) continue;
    changed = true;
    pixels[index] = color.red;
    pixels[index + 1] = color.green;
    pixels[index + 2] = color.blue;
  }
  return changed;
}

function addTransparentEdgeGuard(imageData, fallbackHex, radius = 2) {
  const color = parseHexColor(fallbackHex);
  if (!color) return;
  const { width, height, data } = imageData;
  const pixelCount = width * height;
  const alpha = new Uint8Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    alpha[pixel] = data[pixel * 4 + 3];
  }

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (alpha[pixel] === 0) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const minimumX = Math.max(0, x - radius);
    const maximumX = Math.min(width - 1, x + radius);
    const minimumY = Math.max(0, y - radius);
    const maximumY = Math.min(height - 1, y + radius);
    for (let targetY = minimumY; targetY <= maximumY; targetY += 1) {
      for (let targetX = minimumX; targetX <= maximumX; targetX += 1) {
        const targetPixel = targetY * width + targetX;
        if (alpha[targetPixel] !== 0) continue;
        const targetIndex = targetPixel * 4;
        data[targetIndex] = color.red;
        data[targetIndex + 1] = color.green;
        data[targetIndex + 2] = color.blue;
        data[targetIndex + 3] = 1;
      }
    }
  }
}

function createCrcTable() {
  return Uint32Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    return crc >>> 0;
  });
}

const PNG_CRC_TABLE = createCrcTable();

function calculateCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPngChunk(type, data = new Uint8Array()) {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, calculateCrc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

async function encodePng(imageData) {
  const { width, height, data } = imageData;
  const rowLength = width * 4;
  const compression = new CompressionStream("deflate");
  const writer = compression.writable.getWriter();
  const compressedPromise = new Response(compression.readable).arrayBuffer();
  const rowsPerChunk = Math.max(1, Math.floor((1024 * 1024) / (rowLength + 1)));

  for (let startRow = 0; startRow < height; startRow += rowsPerChunk) {
    const rowCount = Math.min(rowsPerChunk, height - startRow);
    const block = new Uint8Array((rowLength + 1) * rowCount);
    for (let row = 0; row < rowCount; row += 1) {
      const sourceStart = (startRow + row) * rowLength;
      const targetStart = row * (rowLength + 1);
      block[targetStart] = 0;
      block.set(data.subarray(sourceStart, sourceStart + rowLength), targetStart + 1);
    }
    await writer.write(block);
  }
  await writer.close();

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const compressed = new Uint8Array(await compressedPromise);
  return new Blob([
    signature,
    createPngChunk("IHDR", header),
    createPngChunk("IDAT", compressed),
    createPngChunk("IEND"),
  ], { type: "image/png" });
}

function canvasToPngBlob(canvasElement) {
  return new Promise((resolve, reject) => {
    canvasElement.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The browser could not encode the canvas as PNG."));
    }, "image/png");
  });
}

async function createCaptureBlob(canvasElement, captureContext) {
  const imageData = captureContext.getImageData(
    0,
    0,
    canvasElement.width,
    canvasElement.height,
  );
  const hasTransparentPixels = decontaminateTransparentPixels(
    imageData,
    ASCII_CONFIG.glyphColor,
  );
  if (!hasTransparentPixels) return canvasToPngBlob(canvasElement);

  if ("CompressionStream" in window) {
    try {
      return await encodePng(imageData);
    } catch (error) {
      console.warn("Falling back to compatible PNG edge protection", error);
    }
  }

  addTransparentEdgeGuard(imageData, ASCII_CONFIG.glyphColor);
  captureContext.putImageData(imageData, 0, 0);
  return canvasToPngBlob(canvasElement);
}

function applyVisualConfig() {
  const background = hexToRgba(ASCII_CONFIG.background, ASCII_CONFIG.backgroundOpacity);
  const glyph = hexToRgba(ASCII_CONFIG.glyphColor, ASCII_CONFIG.glyphOpacity);
  document.documentElement.style.setProperty("--bg-ascii-surface", background);
  document.documentElement.style.setProperty("--text-ascii-glyph", glyph);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", ASCII_CONFIG.background);
}

function applyControlEffect(effect) {
  if (effect === "background") {
    applyVisualConfig();
    return;
  }
  if (effect === "glyph") {
    applyVisualConfig();
    buildGlyphAtlas();
    return;
  }
  if (effect === "layout") {
    runtime.layout = null;
    resize();
    return;
  }
  if (effect === "fluid") {
    clearFluid();
    return;
  }
  if (effect === "safeArea") {
    markSafeAreaDirty();
    render();
  }
}

function formatControlValue(value, definition) {
  if (definition.type === "toggle") return value ? "开" : "关";
  if (definition.type === "color" || definition.type === "text") return String(value);
  if (definition.percent) return `${Math.round(Number(value) * 100)}%`;
  const decimals = String(definition.step ?? 1).split(".")[1]?.length ?? 0;
  return `${Number(value).toFixed(decimals)}${definition.unit ? ` ${definition.unit}` : ""}`;
}

function createControl(definition) {
  const row = document.createElement("div");
  row.className = `control-row control-row--${definition.type || "range"}`;
  const id = `control-${definition.path.replaceAll(".", "-")}`;
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = definition.label;
  row.append(label);

  if (definition.type === "color") {
    const input = document.createElement("input");
    input.id = id;
    input.type = "color";
    input.value = getConfigValue(definition.path);
    input.addEventListener("input", () => {
      setConfigValue(definition.path, input.value);
      applyControlEffect(definition.effect);
    });
    row.append(input);
    return row;
  }

  if (definition.type === "text") {
    const input = document.createElement("input");
    input.id = id;
    input.type = "text";
    input.spellcheck = false;
    input.value = getConfigValue(definition.path).trimEnd();
    input.setAttribute("aria-describedby", `${id}-hint`);
    const hint = document.createElement("small");
    hint.id = `${id}-hint`;
    hint.textContent = "末尾空格会自动保留，用于静止时隐藏字符。";
    input.addEventListener("input", () => {
      const visibleCharset = input.value || " ";
      setConfigValue(definition.path, `${visibleCharset.trimEnd()} `);
      applyControlEffect(definition.effect);
    });
    row.append(input, hint);
    return row;
  }

  if (definition.type === "toggle") {
    const input = document.createElement("input");
    input.id = id;
    input.type = "checkbox";
    input.checked = Boolean(getConfigValue(definition.path));
    input.addEventListener("change", () => {
      setConfigValue(definition.path, input.checked);
      applyControlEffect(definition.effect);
    });
    const track = document.createElement("span");
    track.className = "switch-track";
    track.setAttribute("aria-hidden", "true");
    const switchLabel = document.createElement("label");
    switchLabel.className = "switch";
    switchLabel.htmlFor = id;
    switchLabel.append(input, track);
    row.append(switchLabel);
    return row;
  }

  const value = document.createElement("output");
  value.htmlFor = id;
  value.textContent = formatControlValue(getConfigValue(definition.path), definition);
  const input = document.createElement("input");
  input.id = id;
  input.type = "range";
  input.min = definition.min;
  input.max = definition.max;
  input.step = definition.step;
  input.value = getConfigValue(definition.path);
  input.addEventListener("input", () => {
    const nextValue = Number(input.value);
    setConfigValue(definition.path, nextValue);
    value.textContent = formatControlValue(nextValue, definition);
    applyControlEffect(definition.effect);
  });
  row.append(value, input);
  return row;
}

function buildControls() {
  controlsForm.replaceChildren();
  for (const group of CONTROL_GROUPS) {
    const section = document.createElement("details");
    section.className = "control-group";
    section.open = Boolean(group.open);
    const summary = document.createElement("summary");
    const title = document.createElement("span");
    title.textContent = group.title;
    summary.append(title);
    const description = document.createElement("p");
    description.textContent = group.description;
    const body = document.createElement("div");
    body.className = "control-group__body";
    body.append(description, ...group.controls.map(createControl));
    section.append(summary, body);
    controlsForm.append(section);
  }
}

function setPanelOpen(open) {
  controlPanel.classList.toggle("is-open", open);
  controlPanel.setAttribute("aria-hidden", String(!open));
  document.querySelector("#controls-toggle").hidden = open;
}

function isControlTarget(event) {
  return event.target instanceof Element && Boolean(event.target.closest("[data-controls-ui]"));
}

function handlePointerMove(event) {
  if (isControlTarget(event)) {
    runtime.pointerLast = null;
    return;
  }
  if (reducedMotion.matches) return;
  const isActivePointer = runtime.pointerId === event.pointerId;
  if (event.pointerType && event.pointerType !== "mouse" && !isActivePointer) return;
  const position = getPointerPosition(event);
  if (!position) {
    runtime.pointerLast = null;
    return;
  }
  const layout = runtime.layout;
  const fluid = ensureFluid();
  if (!fluid) return;
  const previous = runtime.pointerLast;
  const deltaX = previous ? event.clientX - previous.x : event.movementX || 0;
  const deltaY = previous ? event.clientY - previous.y : event.movementY || 0;
  const distance = Math.hypot(deltaX, deltaY);
  const deltaSeconds = previous
    ? clamp((event.timeStamp - previous.time) / 1000, 0.001, 0.05)
    : 0.016;

  if (
    isActivePointer
    && runtime.pointerStart
    && Math.hypot(
      event.clientX - runtime.pointerStart.x,
      event.clientY - runtime.pointerStart.y,
    ) >= ASCII_CONFIG.mask.dragThresholdPx
  ) runtime.pointerDragging = true;

  if (distance > 0) {
    const scaleX = fluid.width / layout.drawWidth;
    const scaleY = fluid.height / layout.drawHeight;
    const centerX = (position.localX / layout.drawWidth) * (fluid.width - 1);
    const centerY = (position.localY / layout.drawHeight) * (fluid.height - 1);
    let dragBoost = 0;
    if (isActivePointer && runtime.pointerDragging) {
      dragBoost = Math.min(
        ASCII_CONFIG.mask.dragBoostMaxPx,
        (distance / deltaSeconds) * ASCII_CONFIG.mask.dragBoostScale,
      );
    }
    const radius = (ASCII_CONFIG.mask.hoverRadiusPx + dragBoost) * Math.min(scaleX, scaleY);
    injectDisk(
      fluid,
      centerX,
      centerY,
      (deltaX / deltaSeconds) * scaleX * ASCII_CONFIG.mask.forceScale,
      (deltaY / deltaSeconds) * scaleY * ASCII_CONFIG.mask.forceScale,
      ASCII_CONFIG.mask.strength,
      radius,
    );
  }
  runtime.pointerLast = { x: event.clientX, y: event.clientY, time: event.timeStamp };
}

function handlePointerDown(event) {
  if (isControlTarget(event)) return;
  if (reducedMotion.matches || event.isPrimary === false) return;
  if (!getPointerPosition(event)) return;
  runtime.pointerId = event.pointerId;
  runtime.pointerStart = { x: event.clientX, y: event.clientY, time: event.timeStamp };
  runtime.pointerLast = { x: event.clientX, y: event.clientY, time: event.timeStamp };
  runtime.pointerDragging = false;
}

function handlePointerUp(event) {
  if (isControlTarget(event)) {
    runtime.pointerId = null;
    runtime.pointerStart = null;
    runtime.pointerDragging = false;
    return;
  }
  if (event.isPrimary === false || runtime.pointerId !== event.pointerId) return;
  const isClick = !runtime.pointerDragging;
  runtime.pointerId = null;
  runtime.pointerStart = null;
  runtime.pointerDragging = false;
  if (!isClick || reducedMotion.matches) return;

  const position = getPointerPosition(event);
  const layout = runtime.layout;
  const fluid = ensureFluid();
  if (!position || !layout || !fluid) return;
  const maxX = layout.drawWidth - position.localX;
  const maxY = layout.drawHeight - position.localY;
  const farthestCorner = Math.max(
    Math.hypot(position.localX, position.localY),
    Math.hypot(position.localX, maxY),
    Math.hypot(maxX, position.localY),
    Math.hypot(maxX, maxY),
  );
  const maxRadiusPx = Math.min(ASCII_CONFIG.mask.splashRangePx, farthestCorner);
  if (maxRadiusPx <= 0) return;
  runtime.splashes.push({
    normalizedX: position.localX / layout.drawWidth,
    normalizedY: position.localY / layout.drawHeight,
    startedAt: event.timeStamp,
    seed: Math.random() * 1000,
    maxRadiusPx,
    thicknessPx: ASCII_CONFIG.mask.splashThicknessPx,
  });
}

window.addEventListener("pointermove", handlePointerMove, { passive: true });
window.addEventListener("pointerdown", handlePointerDown, { passive: true });
window.addEventListener("pointerup", handlePointerUp, { passive: true });
window.addEventListener("pointercancel", handlePointerUp, { passive: true });
document.querySelector("#controls-toggle").addEventListener("click", () => setPanelOpen(true));
document.querySelector("#controls-close").addEventListener("click", () => setPanelOpen(false));
document.querySelector("#clear-field").addEventListener("click", clearFluid);
document.querySelector("#reset-controls").addEventListener("click", () => {
  Object.assign(ASCII_CONFIG, structuredClone(DEFAULT_ASCII_CONFIG));
  applyVisualConfig();
  markSafeAreaDirty();
  runtime.layout = null;
  resize();
  clearFluid();
  buildControls();
});
document.querySelector("#copy-config").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(JSON.stringify(ASCII_CONFIG, null, 2));
    button.textContent = "已复制";
  } catch {
    button.textContent = "复制失败";
  }
  window.setTimeout(() => { button.textContent = "复制 JSON"; }, 1200);
});
document.querySelector("#capture-png").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "处理中…";
  render();
  const captureCanvas = document.createElement("canvas");
  captureCanvas.width = canvas.width;
  captureCanvas.height = canvas.height;
  const captureContext = captureCanvas.getContext("2d");
  if (!captureContext) {
    button.textContent = "截图失败";
    button.disabled = false;
    window.setTimeout(() => { button.textContent = "截图 PNG"; }, 1200);
    return;
  }

  if (ASCII_CONFIG.includeBackgroundInExport) {
    captureContext.fillStyle = hexToRgba(
      ASCII_CONFIG.background,
      ASCII_CONFIG.backgroundOpacity,
    );
    captureContext.fillRect(0, 0, captureCanvas.width, captureCanvas.height);
  }
  captureContext.drawImage(canvas, 0, 0);

  try {
    const blob = await createCaptureBlob(captureCanvas, captureContext);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `minimax-code-ascii-${Date.now()}.png`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    button.textContent = "已下载";
  } catch (error) {
    console.error("PNG capture failed", error);
    button.textContent = "截图失败";
  } finally {
    button.disabled = false;
    window.setTimeout(() => { button.textContent = "截图 PNG"; }, 1200);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && controlPanel.classList.contains("is-open")) {
    setPanelOpen(false);
  }
});
document.addEventListener("visibilitychange", () => {
  runtime.lastRenderTime = null;
  runtime.lastTickTime = 0;
});
new ResizeObserver(() => {
  resize();
  markSafeAreaDirty();
}).observe(container);
new MutationObserver(markSafeAreaDirty).observe(document.body, {
  subtree: true,
  childList: true,
  characterData: true,
  attributes: true,
  attributeFilter: [
    "class",
    "style",
    "src",
    "hidden",
    "data-ascii-safe-area",
    "data-ascii-overlay-content",
  ],
});
window.addEventListener("scroll", markSafeAreaDirty, { passive: true, capture: true });
window.addEventListener("resize", markSafeAreaDirty, { passive: true });
document.addEventListener("load", markSafeAreaDirty, { capture: true });
document.fonts?.addEventListener?.("loadingdone", markSafeAreaDirty);

reducedMotion.addEventListener?.("change", () => {
  runtime.fluid = null;
  runtime.splashes.length = 0;
  runtime.pointerId = null;
  runtime.pointerStart = null;
  runtime.pointerLast = null;
  resize();
  render();
});

applyVisualConfig();
buildControls();
setPanelOpen(true);
resize();
runtime.frameRequest = requestAnimationFrame(tick);

export { ASCII_CONFIG };
