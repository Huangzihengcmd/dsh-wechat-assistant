/**
 * qr.js — self-contained QR Code (ISO/IEC 18004) encoder.
 *
 * Scope: byte mode (8-bit, UTF-8), error-correction level L, automatic version
 * selection (1..10), automatic mask selection using the spec's penalty rules.
 * No dependencies, no I/O, no top-level side effects.
 *
 * The symbol is emitted WITHOUT a quiet zone: `modules[0][0]` is the top-left
 * corner of the finder pattern.
 */

/* ------------------------------------------------------------------ tables */

/** Reed-Solomon block layout for ECC level L, indexed by version. */
const VERSION_TABLE = [
  null,
  { ec: 7,  blocks: [[1, 19]] },              // 1
  { ec: 10, blocks: [[1, 34]] },              // 2
  { ec: 15, blocks: [[1, 55]] },              // 3
  { ec: 20, blocks: [[1, 80]] },              // 4
  { ec: 26, blocks: [[1, 108]] },             // 5
  { ec: 18, blocks: [[2, 68]] },              // 6
  { ec: 20, blocks: [[2, 78]] },              // 7
  { ec: 24, blocks: [[2, 97]] },              // 8
  { ec: 30, blocks: [[2, 116]] },             // 9
  { ec: 18, blocks: [[2, 68], [2, 69]] },     // 10
];

/** Alignment-pattern centre coordinates, indexed by version. */
const ALIGN_POS = [
  null,
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

const MIN_VERSION = 1;
const MAX_VERSION = 10;

/** Format-information bit pattern for ECC level L (ISO/IEC 18004 Table 25). */
const ECC_FORMAT_BITS_L = 1;

/* ------------------------------------------------------- GF(256) arithmetic */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function buildGaloisTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  // Duplicate exponents so multiplication never needs a modulo.
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function gfPow2(e) {
  return GF_EXP[e % 255];
}

/* ----------------------------------------- Reed-Solomon generator / encoder */

/** Generator polynomial of the given degree, leading coefficient first. */
function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const root = gfPow2(i);
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];                 // multiply by x
      next[j + 1] ^= gfMul(poly[j], root); // ... and add root * poly
    }
    poly = next;
  }
  return poly; // poly[0] === 1
}

/** Remainder of data (as polynomial) divided by the generator. */
function rsEncode(data, gen) {
  const degree = gen.length - 1;
  const rem = new Uint8Array(degree);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < degree; j++) {
        rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return rem;
}

/* --------------------------------------------------------- bit stream utils */

class BitBuffer {
  constructor() {
    this.bits = [];
  }
  push(value, length) {
    for (let i = length - 1; i >= 0; i--) {
      this.bits.push((value >>> i) & 1);
    }
  }
  get length() {
    return this.bits.length;
  }
}

/* ------------------------------------------------------------ version choice */

function dataCapacityBits(version) {
  const spec = VERSION_TABLE[version];
  let dataCodewords = 0;
  for (const [count, words] of spec.blocks) dataCodewords += count * words;
  return dataCodewords * 8;
}

function countIndicatorBits(version) {
  return version <= 9 ? 8 : 16;
}

/** Largest number of UTF-8 bytes that fits in `version` at ECC level L. */
function byteCapacity(version) {
  const available = dataCapacityBits(version) - 4 - countIndicatorBits(version);
  return Math.max(0, Math.floor(available / 8));
}

function chooseVersion(byteLength) {
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) {
    if (byteLength <= byteCapacity(v)) return v;
  }
  throw new RangeError(
    `encodeQr: ${byteLength} bytes exceeds capacity of version ${MAX_VERSION} ` +
    `(ECC L, byte mode; max ${byteCapacity(MAX_VERSION)} bytes)`,
  );
}

/* ------------------------------------------------------- data codeword build */

function buildDataCodewords(bytes, version) {
  const buffer = new BitBuffer();
  buffer.push(0b0100, 4);                       // byte mode indicator
  buffer.push(bytes.length, countIndicatorBits(version)); // character count
  for (const b of bytes) buffer.push(b, 8);

  const capacity = dataCapacityBits(version);
  if (buffer.length > capacity) {
    throw new RangeError('encodeQr: data exceeds version capacity');
  }

  // Terminator: up to four zero bits.
  const terminator = Math.min(4, capacity - buffer.length);
  buffer.push(0, terminator);
  // Pad to a byte boundary.
  while (buffer.length % 8 !== 0) buffer.bits.push(0);

  const codewords = [];
  for (let i = 0; i < buffer.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | buffer.bits[i + j];
    codewords.push(byte);
  }
  // Alternating pad codewords.
  const target = capacity / 8;
  let pad = 0xec;
  while (codewords.length < target) {
    codewords.push(pad);
    pad = pad === 0xec ? 0x11 : 0xec;
  }
  return codewords;
}

/* --------------------------------------------------- block split + interleave */

function interleave(codewords, version) {
  const spec = VERSION_TABLE[version];
  const blocks = [];
  let offset = 0;
  for (const [count, words] of spec.blocks) {
    for (let i = 0; i < count; i++) {
      const data = codewords.slice(offset, offset + words);
      offset += words;
      blocks.push({ data, ec: rsEncode(data, rsGeneratorPoly(spec.ec)) });
    }
  }
  if (offset !== codewords.length) {
    throw new Error('encodeQr: internal block-split mismatch');
  }

  const result = [];
  const maxWords = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxWords; i++) {
    for (const block of blocks) {
      if (i < block.data.length) result.push(block.data[i]);
    }
  }
  for (let i = 0; i < spec.ec; i++) {
    for (const block of blocks) result.push(block.ec[i]);
  }
  return result;
}

/* ------------------------------------------------------------------ masks */

function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return (x * y) % 2 + (x * y) % 3 === 0;
    case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
    case 7: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    default: throw new Error(`bad mask ${mask}`);
  }
}

/* --------------------------------------------------- matrix construction */

function makeMatrix(size) {
  const m = new Array(size);
  for (let y = 0; y < size; y++) m[y] = new Uint8Array(size);
  return m;
}

function buildFunctionPatterns(version) {
  const size = version * 4 + 17;
  const modules = makeMatrix(size);
  const isFunction = new Array(size);
  for (let y = 0; y < size; y++) isFunction[y] = new Uint8Array(size);

  const set = (x, y, dark) => {
    modules[y][x] = dark ? 1 : 0;
    isFunction[y][x] = 1;
  };

  // Timing patterns (row 6 and column 6), drawn first so finders overwrite.
  for (let i = 0; i < size; i++) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }

  // Finder patterns + separators at three corners.
  const drawFinder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  // Alignment patterns.
  const pos = ALIGN_POS[version];
  const last = pos.length - 1;
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) {
        continue; // collides with a finder pattern
      }
      const cx = pos[i];
      const cy = pos[j];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          set(cx + dx, cy + dy, dist !== 1);
        }
      }
    }
  }

  // Reserve format-information areas (filled per mask later).
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) { set(8, i, false); set(i, 8, false); }
  }
  set(8, 8, false);
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, false);
  for (let i = 0; i < 8; i++) set(8, size - 1 - i, false);

  // Dark module (always set) at column 8, row size-8.
  set(8, size - 8, true);

  // Version information areas for version >= 7.
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        set(size - 11 + j, i, false);
        set(i, size - 11 + j, false);
      }
    }
  }

  return { size, modules, isFunction };
}

/** Place the data bit stream; returns number of data modules used. */
function placeData(modules, isFunction, size, codewords) {
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  const bitAt = (i) => (i < totalBits ? (codewords[i >>> 3] >>> (7 - (i & 7))) & 1 : 0);

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x]) {
          modules[y][x] = bitAt(bitIndex);
          bitIndex++;
        }
      }
    }
  }
  return bitIndex;
}

/* ------------------------------------------------------- format/version info */

function formatBits(mask) {
  const data = (ECC_FORMAT_BITS_L << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) {
    rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  }
  return (version << 12) | (rem & 0xfff);
}

function drawFormatInfo(modules, size, mask) {
  const bits = formatBits(mask);
  const bit = (i) => (bits >>> i) & 1;

  // First copy, around the top-left finder.
  for (let i = 0; i <= 5; i++) modules[i][8] = bit(i);
  modules[7][8] = bit(6);
  modules[8][8] = bit(7);
  modules[8][7] = bit(8);
  for (let i = 9; i < 15; i++) modules[8][14 - i] = bit(i);

  // Second copy, split between bottom-left and top-right.
  for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = bit(i);

  // Dark module.
  modules[size - 8][8] = 1;
}

function drawVersionInfo(modules, size, version) {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const bit = (bits >>> i) & 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    modules[b][a] = bit;
    modules[a][b] = bit;
  }
}

/* --------------------------------------------------------------- penalties */

const N1 = 3;
const N2 = 3;
const N3 = 40;
const N4 = 10;

function penaltyScore(modules, size) {
  let score = 0;

  // Rule 1: runs of five or more modules of the same colour.
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (modules[y][x] === modules[y][x - 1]) {
        run++;
      } else {
        if (run >= 5) score += N1 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += N1 + (run - 5);
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (modules[y][x] === modules[y - 1][x]) {
        run++;
      } else {
        if (run >= 5) score += N1 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += N1 + (run - 5);
  }

  // Rule 2: 2x2 blocks of the same colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = modules[y][x];
      if (v === modules[y][x + 1] && v === modules[y + 1][x] && v === modules[y + 1][x + 1]) {
        score += N2;
      }
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns with four light modules on a side.
  const PATTERN_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const PATTERN_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (get, start) => {
    let a = true;
    let b = true;
    for (let k = 0; k < 11; k++) {
      const v = get(start + k);
      if (a && v !== PATTERN_A[k]) a = false;
      if (b && v !== PATTERN_B[k]) b = false;
      if (!a && !b) return 0;
    }
    return (a ? 1 : 0) + (b ? 1 : 0);
  };
  for (let y = 0; y < size; y++) {
    const row = modules[y];
    for (let x = 0; x <= size - 11; x++) score += N3 * matches((i) => row[i], x);
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y <= size - 11; y++) score += N3 * matches((i) => modules[i][x], y);
  }

  // Rule 4: deviation of the dark-module proportion from 50%.
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) dark += modules[y][x];
  }
  const total = size * size;
  score += N4 * Math.floor(Math.abs(dark * 100 - total * 50) / (total * 5));

  return score;
}

/* ---------------------------------------------------------- assembly stage */

function buildSymbol(version, codewords) {
  const base = buildFunctionPatterns(version);
  const { size } = base;

  placeData(base.modules, base.isFunction, size, codewords);
  drawVersionInfo(base.modules, size, version);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const modules = makeMatrix(size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = base.modules[y][x];
        modules[y][x] = base.isFunction[y][x] ? v : (v ^ (maskBit(mask, x, y) ? 1 : 0));
      }
    }
    drawFormatInfo(modules, size, mask);
    const score = penaltyScore(modules, size);
    if (best === null || score < best.score) best = { mask, modules, score };
  }
  return { size, mask: best.mask, modules: best.modules, score: best.score };
}

/* --------------------------------------------------------------- public API */

/**
 * Encode `text` as a QR Code symbol.
 *
 * @param {string} text   URL or short text, UTF-8, up to ~200 bytes
 * @returns {{ size: number, modules: number[][] }}
 *   size = the QR symbol size in modules (17 + 4*version, e.g. 25 for version 2).
 *   modules[y][x] = 1 for a dark module, 0 for light. The returned matrix is the
 *   QUIET-ZONE-FREE symbol (finder patterns at the four corners, no white border).
 */
export function encodeQr(text) {
  if (typeof text !== 'string') throw new TypeError('encodeQr: text must be a string');

  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  const codewords = buildDataCodewords(bytes, version);
  const finalCodewords = interleave(codewords, version);
  const symbol = buildSymbol(version, finalCodewords);

  const modules = new Array(symbol.size);
  for (let y = 0; y < symbol.size; y++) {
    modules[y] = new Array(symbol.size);
    for (let x = 0; x < symbol.size; x++) modules[y][x] = symbol.modules[y][x];
  }
  return { size: symbol.size, modules };
}

/**
 * Same as {@link encodeQr} but also reports the chosen version, mask and
 * penalty score. Used by tooling/tests; not required by the plugin.
 *
 * @param {string} text
 * @returns {{ size: number, version: number, mask: number, score: number,
 *             modules: number[][] }}
 */
export function encodeQrDetailed(text) {
  if (typeof text !== 'string') throw new TypeError('encodeQr: text must be a string');

  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  const codewords = buildDataCodewords(bytes, version);
  const finalCodewords = interleave(codewords, version);
  const symbol = buildSymbol(version, finalCodewords);

  const modules = new Array(symbol.size);
  for (let y = 0; y < symbol.size; y++) {
    modules[y] = new Array(symbol.size);
    for (let x = 0; x < symbol.size; x++) modules[y][x] = symbol.modules[y][x];
  }
  return { size: symbol.size, version, mask: symbol.mask, score: symbol.score, modules };
}

export default encodeQr;
