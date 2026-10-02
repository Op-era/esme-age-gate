'use strict';
// Procedural scene generator + rotation-puzzle renderer.
// The scene is random per challenge (crypto-seeded), asymmetric and full of detail
// that crosses the boundary between the inner disc and the outer ring.
const crypto = require('crypto');
const sharp = require('sharp');

const SIZE = 320;          // outer image is SIZE x SIZE
const HOLE_R = 80;         // radius of the circular hole cut in the outer image
const INNER_R = 76;        // radius of the inner disc content (4px gap vs. the hole)
const INNER_SIZE = INNER_R * 2;

function makeRng(seedBuf) {
  // xorshift128 seeded from crypto bytes
  let [a, b, c, d] = [0, 4, 8, 12].map((o) => seedBuf.readUInt32LE(o) || 0x9e3779b9);
  return function rnd() {
    const t = a ^ (a << 11);
    a = b; b = c; c = d;
    d = (d ^ (d >>> 19) ^ t ^ (t >>> 8)) >>> 0;
    return d / 4294967296;
  };
}

function sceneSvg(rnd) {
  const R = (lo, hi) => lo + rnd() * (hi - lo);
  const I = (lo, hi) => Math.floor(R(lo, hi + 1));
  const baseHue = I(0, 359);
  const hsl = (h, s, l, a = 1) => `hsla(${((h % 360) + 360) % 360},${s}%,${l}%,${a})`;
  const cx = SIZE / 2, cy = SIZE / 2;
  // random point biased toward the middle so the inner disc is rich in detail
  const pt = (spread) => {
    const ang = R(0, Math.PI * 2), rad = Math.pow(rnd(), 0.7) * spread;
    return [cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad];
  };
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`);
  const gA = hsl(baseHue, I(55, 85), I(18, 32)), gB = hsl(baseHue + I(40, 140), I(60, 90), I(45, 65));
  const gAng = R(0, 360);
  out.push(`<defs><linearGradient id="bg" gradientTransform="rotate(${gAng.toFixed(1)} .5 .5)"><stop offset="0" stop-color="${gA}"/><stop offset="1" stop-color="${gB}"/></linearGradient></defs>`);
  out.push(`<rect width="${SIZE}" height="${SIZE}" fill="url(#bg)"/>`);
  // stars
  for (let i = 0; i < 70; i++) {
    out.push(`<circle cx="${R(0, SIZE).toFixed(1)}" cy="${R(0, SIZE).toFixed(1)}" r="${R(0.6, 2.2).toFixed(1)}" fill="${hsl(baseHue + 180, 30, 92, R(0.4, 0.95).toFixed(2))}"/>`);
  }
  // sun/moon with a crescent bite, off-centre
  const [sx, sy] = pt(70);
  const sr = R(22, 38);
  out.push(`<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${sr.toFixed(1)}" fill="${hsl(baseHue + 200, 85, 80)}"/>`);
  out.push(`<circle cx="${(sx + sr * 0.45).toFixed(1)}" cy="${(sy - sr * 0.3).toFixed(1)}" r="${(sr * 0.85).toFixed(1)}" fill="${gB}"/>`);
  // mountain layers (random walks)
  for (let layer = 0; layer < 3; layer++) {
    const baseY = R(150, 215) + layer * R(25, 40);
    let d = `M0 ${SIZE} L0 ${baseY.toFixed(1)}`;
    let x = 0, y = baseY;
    while (x < SIZE) {
      x += R(14, 42);
      y = Math.min(SIZE - 20, Math.max(60, y + R(-48, 48)));
      d += ` L${Math.min(x, SIZE).toFixed(1)} ${y.toFixed(1)}`;
    }
    d += ` L${SIZE} ${SIZE} Z`;
    out.push(`<path d="${d}" fill="${hsl(baseHue + 20 * layer + I(-25, 25), I(35, 70), 14 + layer * 9 + I(0, 8))}" stroke="${hsl(baseHue + 60, 70, 70, 0.55)}" stroke-width="${R(0.8, 2).toFixed(1)}"/>`);
  }
  // wide ribbons that cross the inner/outer boundary
  for (let i = 0; i < 4; i++) {
    const p = [0, 1, 2, 3].map(() => pt(190));
    out.push(`<path d="M${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)} C${p[1][0].toFixed(1)} ${p[1][1].toFixed(1)} ${p[2][0].toFixed(1)} ${p[2][1].toFixed(1)} ${p[3][0].toFixed(1)} ${p[3][1].toFixed(1)}" fill="none" stroke="${hsl(baseHue + I(90, 280), I(60, 95), I(50, 70), 0.78)}" stroke-width="${R(5, 16).toFixed(1)}" stroke-linecap="round"/>`);
  }
  // asymmetric shapes: arrows, triangles, spirals, flags
  for (let i = 0; i < 14; i++) {
    const [x0, y0] = pt(165);
    const s = R(10, 30), rot = R(0, 360), col = hsl(baseHue + I(0, 359), I(60, 95), I(45, 75), 0.92);
    const kind = I(0, 3);
    let g = '';
    if (kind === 0) g = `<polygon points="0,${-s} ${s * 0.7},${s * 0.2} ${s * 0.25},${s * 0.2} ${s * 0.25},${s} ${-s * 0.25},${s} ${-s * 0.25},${s * 0.2} ${-s * 0.7},${s * 0.2}" fill="${col}"/>`;
    else if (kind === 1) g = `<polygon points="${-s},${s * 0.8} ${s * 1.2},${s * 0.3} ${-s * 0.2},${-s}" fill="${col}" stroke="#fff" stroke-opacity=".5" stroke-width="1.2"/>`;
    else if (kind === 2) {
      let d = 'M0 0';
      for (let t = 0.3; t < 11; t += 0.3) d += ` L${(Math.cos(t) * t * s / 11).toFixed(1)} ${(Math.sin(t) * t * s / 11).toFixed(1)}`;
      g = `<path d="${d}" fill="none" stroke="${col}" stroke-width="2.6" stroke-linecap="round"/>`;
    } else g = `<rect x="0" y="${-s}" width="2.5" height="${s * 2}" fill="#eee"/><polygon points="2.5,${-s} ${s * 1.3},${-s * 0.6} 2.5,${-s * 0.2}" fill="${col}"/>`;
    out.push(`<g transform="translate(${x0.toFixed(1)} ${y0.toFixed(1)}) rotate(${rot.toFixed(1)})">${g}</g>`);
  }
  // fine hatch lines for high-frequency texture
  for (let i = 0; i < 40; i++) {
    const [x0, y0] = pt(185);
    const a = R(0, Math.PI * 2), l = R(8, 28);
    out.push(`<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${(x0 + Math.cos(a) * l).toFixed(1)}" y2="${(y0 + Math.sin(a) * l).toFixed(1)}" stroke="${hsl(baseHue + 160, 50, 90, 0.5)}" stroke-width="1.2"/>`);
  }
  out.push('</svg>');
  return out.join('');
}

function noiseOverlay(width, height, alphaMax) {
  const buf = crypto.randomBytes(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) buf[i + 3] = buf[i + 3] % alphaMax;
  return sharp(buf, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

function circleMask(size, r) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="#fff"/></svg>`);
}

/**
 * Render a puzzle. `offset` is how far (degrees, clockwise) the inner disc is rotated
 * away from its correct orientation. Returns WebP buffers.
 */
async function renderPuzzle(offset) {
  const rnd = makeRng(crypto.randomBytes(16));
  const scenePng = await sharp(Buffer.from(sceneSvg(rnd))).png().toBuffer();

  // OUTER: scene with a circular hole, a thin dark ring around it, and fresh noise
  const holeMask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><rect width="100%" height="100%" fill="#fff"/><circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${HOLE_R}" fill="#000"/></svg>`);
  const outerNoise = await noiseOverlay(SIZE, SIZE, 26);
  const rim = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${HOLE_R + 1.5}" fill="none" stroke="#0b0b0d" stroke-opacity=".85" stroke-width="3"/></svg>`);
  const outerBase = await sharp(scenePng)
    .composite([{ input: outerNoise, blend: 'over' }, { input: holeMask, blend: 'dest-in' }, { input: rim, blend: 'over' }])
    .png().toBuffer();
  const outer = await sharp(outerBase).webp({ quality: 82 }).toBuffer();

  // INNER: centre crop, rotated by `offset`, circle-masked, with its own noise + slight tone shift
  const off = (SIZE - INNER_SIZE) / 2;
  const crop = await sharp(scenePng).extract({ left: off, top: off, width: INNER_SIZE, height: INNER_SIZE }).png().toBuffer();
  const rotated = await sharp(crop).rotate(offset, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const meta = await sharp(rotated).metadata();
  const rl = Math.round((meta.width - INNER_SIZE) / 2), rt = Math.round((meta.height - INNER_SIZE) / 2);
  const innerNoise = await noiseOverlay(INNER_SIZE, INNER_SIZE, 26);
  const inner = await sharp(rotated)
    .extract({ left: rl, top: rt, width: INNER_SIZE, height: INNER_SIZE })
    .modulate({ brightness: 0.97 + rnd() * 0.04, saturation: 0.96 + rnd() * 0.06 })
    .composite([{ input: innerNoise, blend: 'over' }, { input: circleMask(INNER_SIZE, INNER_R), blend: 'dest-in' }])
    .webp({ quality: 82 }).toBuffer();

  return { outer, inner, size: SIZE, innerSize: INNER_SIZE };
}

module.exports = { renderPuzzle, sceneSvg, makeRng, SIZE, INNER_SIZE };
