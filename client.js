/**
 * 微信助理的设置页（Client 半）。
 *
 * 注册进 `settings.section`，一个页面两栏卡片：左边是状态与主操作，右边是
 * 扫码登录。所有网络访问都走 Host 半的 `/plugins/dsh-wechat-assistant/*`
 * 同源路由；凭据永远不进浏览器。
 *
 * 二维码在浏览器里用本地编码器画成 SVG：Host 只把微信返回的短链接交过来，
 * 不引入任何外部资源或 CDN。
 *
 * @module dsh-wechat-assistant/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-wechat-assistant',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /* ---- QR encoder (embedded copy of lib/qr.js, byte mode / ECC L) ---- */
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
    function encodeQr(text) {
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
    function encodeQrDetailed(text) {
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


    /* ---- end QR encoder ---- */

    /**
     * 包一层：二维码是展示细节，编码失败不能让整张设置页崩掉。
     *
     * @param text - 要编码的短链接。
     * @returns 矩阵模型，或 undefined 表示失败。
     */
    function encodeQrSafely(text) {
      if (typeof text !== 'string' || text === '') return undefined
      try {
        return encodeQr(text)
      } catch {
        return undefined
      }
    }

    /** 与 Host 半一致的接口前缀。 */
    const API = '/plugins/dsh-wechat-assistant'

    /** locale 命名空间：页面文案走宿主的 locale 服务，中英各一份。 */
    const NS = 'settings.wechat-assistant'

    const zh = {
      title: '远程通道',
      intro:
        '连接第三方消息通道，即可远程指挥电脑端 DSH 执行任务。微信助理走微信 ClawBot 通道：扫码登录后，在微信里直接发指令，执行结果会实时回传到这个聊天窗口。',
      cardTitle: '微信助理',
      cardDesc: '通过微信直接下发指令，结果实时回传至微信聊天窗口。',
      stateOn: '已连接',
      stateOff: '未连接',
      stateBusy: '连接中…',
      connect: '连接',
      disconnect: '取消连接',
      reconnect: '重新连接',
      qrTitle: '扫码登录',
      qrLoading: '正在生成登录二维码，请稍候…若没有出现，点左侧「连接」重试。',
      qrConnected: '当前微信账号已连接。若要换一个账号，先在上方取消连接，再重新扫码。',
      qrWait: '用手机微信扫描二维码，并在手机上确认授权。',
      qrScaned: '已扫码，请在手机上确认授权。',
      qrNeedCode: '输手机微信上显示的数字，然后回车。',
      verifyPlaceholder: '数字配对码',
      submit: '提交',
      cancelScan: '取消扫码',
      account: '账号',
      inbound: '已收消息',
      outbound: '已回消息',
      never: '还没有登录过微信。在右侧扫码即可开始。',
      lastError: '最近一次异常',
      qrFailed: '二维码生成失败，请点击刷新',
      accessTitle: '访问控制',
      accessDesc:
        '只有主人和已批准的微信账号能驱动 Agent。其他人发来的消息不会被执行，只会出现在下面的待审批列表里，由你在这里手动批准。',
      accessOwner: '主人',
      accessNoOwner: '还没有设定主人。重新扫码登录，你的微信账号会被设为默认主人。',
      accessPending: '待审批',
      accessAllowed: '已批准',
      approve: '批准',
      revoke: '撤销',
      agentsTitle: 'Agent 与模型',
      agentsCount: '个 Agent',
      agentsDesc:
        '一个微信可以驱动多个 Agent：每个 Agent 有自己的 preset、模型和独立上下文。在微信里用 /use <名字> 切换，用 /model <provider>/<model> 换模型。',
      agentsDefaultModel: '（宿主默认模型）',
      agentsDefaultPreset: '（宿主默认 preset）',
      agentsPreset: 'preset',
      agentsNamePlaceholder: '新 Agent 名字',
      addAgent: '添加',
      remove: '删除',
      setDefault: '设为默认',
      coexistTitle: '共存账号',
      coexistDesc:
        '微信 ClawBot 是单账号模式：同一个微信去扫新的码，会把绑定改到新 bot 上，本机其它应用（比如 WorkBuddy）的 bot 随即失效。把那些应用的 bot token 填在这里，请求二维码时会一并报给服务端，它们就不会被顶掉。token 只存在本机。',
      coexistLabelPlaceholder: '应用名（如 WorkBuddy）',
      coexistTokenPlaceholder: 'bot token',
      addCoexist: '登记',
      qrExpired: '二维码已过期。点「刷新二维码」换一张新的再扫。',
      refreshQr: '刷新二维码',
      qrAlt: '微信登录二维码',
    }

    const en = {
      title: 'Remote channel',
      intro:
        'Connect a third-party messaging channel to drive DSH on this computer from anywhere. The WeChat Assistant uses the WeChat ClawBot channel: scan once, then send instructions from WeChat and receive results back in the same chat.',
      cardTitle: 'WeChat Assistant',
      cardDesc: 'Send instructions from WeChat and get results back in the chat window.',
      stateOn: 'Connected',
      stateOff: 'Not connected',
      stateBusy: 'Connecting…',
      connect: 'Connect',
      disconnect: 'Disconnect',
      reconnect: 'Reconnect',
      qrTitle: 'Scan to sign in',
      qrLoading: 'Generating a sign-in QR code… if it does not appear, press Connect to retry.',
      qrConnected: 'A WeChat account is connected. Disconnect first to sign in with a different one.',
      qrWait: 'Scan the QR code with mobile WeChat and confirm the authorization on your phone.',
      qrScaned: 'Scanned — confirm the authorization on your phone.',
      qrNeedCode: 'Enter the number shown in mobile WeChat, then press enter.',
      verifyPlaceholder: 'Pairing code',
      submit: 'Submit',
      cancelScan: 'Cancel scan',
      account: 'Account',
      inbound: 'Received',
      outbound: 'Replied',
      never: 'No WeChat account has been signed in yet. Scan the code on the right to start.',
      lastError: 'Last error',
      qrFailed: 'Could not build the QR code. Try refreshing.',
      accessTitle: 'Access control',
      accessDesc:
        'Only the owner and approved WeChat accounts can drive the agent. Messages from anyone else are not executed — they appear in the pending list below for you to approve.',
      accessOwner: 'Owner',
      accessNoOwner: 'No owner yet. Scan the QR code again — your WeChat account becomes the default owner.',
      accessPending: 'Pending approval',
      accessAllowed: 'Approved',
      approve: 'Approve',
      revoke: 'Revoke',
      agentsTitle: 'Agents and models',
      agentsCount: 'agents',
      agentsDesc:
        'One WeChat account can drive several agents: each has its own preset, model and context. Switch with /use <name> in WeChat, change the model with /model <provider>/<model>.',
      agentsDefaultModel: '(host default model)',
      agentsDefaultPreset: '(host default preset)',
      agentsPreset: 'preset',
      agentsNamePlaceholder: 'New agent name',
      addAgent: 'Add',
      remove: 'Remove',
      setDefault: 'Make default',
      coexistTitle: 'Coexisting accounts',
      coexistDesc:
        'The WeChat ClawBot channel is single-account: scanning a new QR code with the same WeChat account rebinds it to a new bot and invalidates the other bots on this machine (for example WorkBuddy). Enter those apps\' bot tokens here so they are reported to the server with the QR request and are not displaced. Tokens stay on this machine.',
      coexistLabelPlaceholder: 'App name (e.g. WorkBuddy)',
      coexistTokenPlaceholder: 'bot token',
      addCoexist: 'Register',
      qrExpired: 'This QR code has expired. Press Refresh QR code to get a new one.',
      refreshQr: 'Refresh QR code',
      qrAlt: 'WeChat sign-in QR code',
    }

    /** 页面样式：只用宿主主题 token，暗色模式自动跟随。 */
    const CSS = `
.dswa-root { display: flex; flex-direction: column; gap: 20px; padding: 4px 0 32px; color: var(--dsw-alias-label-primary); }
.dswa-title { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: .2px; }
.dswa-sub { margin: 6px 0 0; font-size: 12.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dswa-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
@media (max-width: 900px) { .dswa-grid { grid-template-columns: minmax(0, 1fr); } }
.dswa-card { border: .5px solid var(--dsw-alias-settings-card-stroke); background: var(--dsw-alias-settings-card-fill); border-radius: var(--dsw-radius-xl); padding: 18px 18px 16px; display: flex; flex-direction: column; gap: 12px; }
.dswa-card-head { display: flex; align-items: center; gap: 10px; }
.dswa-mark { width: 34px; height: 34px; border-radius: 9px; display: flex; align-items: center; justify-content: center; background: #07c160; flex: 0 0 auto; }
.dswa-card-title { font-size: 13.5px; font-weight: 600; margin: 0; }
.dswa-card-desc { margin: 0; font-size: 12.5px; line-height: 1.65; color: var(--dsw-alias-label-secondary); }
.dswa-badge { margin-left: auto; font-size: 11.5px; padding: 2px 9px; border-radius: 999px; border: .5px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dswa-badge-on { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.dswa-badge-busy { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.dswa-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dswa-btn { font: inherit; font-size: 13px; line-height: 1; padding: 8px 15px; border-radius: var(--dsw-radius-md); border: .5px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; transition: background .15s, border-color .15s, opacity .15s; }
.dswa-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dswa-btn:disabled { opacity: .4; cursor: not-allowed; }
.dswa-btn:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color); outline-offset: 2px; }
.dswa-btn-primary { background: var(--dsw-alias-button-primary-fill); border-color: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dswa-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dswa-btn-danger { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dswa-meta { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dswa-meta-row { display: flex; justify-content: space-between; gap: 12px; }
.dswa-meta-key { color: var(--dsw-alias-label-secondary); }
.dswa-meta-val { color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dswa-qr-wrap { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 12px 0 4px; }
.dswa-qr { padding: 10px; border-radius: var(--dsw-radius-md); background: #fff; border: .5px solid var(--dsw-alias-border-l1); line-height: 0; }
.dswa-qr svg { display: block; }
.dswa-qr-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); text-align: center; line-height: 1.6; margin: 0; }
.dswa-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); margin: 0; line-height: 1.6; }
.dswa-code-row { display: flex; gap: 8px; align-items: center; }
.dswa-input { font: inherit; font-size: 13px; padding: 7px 10px; border-radius: var(--dsw-radius-md); border: .5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); width: 120px; }
.dswa-note { font-size: 11.5px; color: var(--dsw-alias-label-tertiary); line-height: 1.6; margin: 0; }
`


    /** 按需注入一次页面样式，卸载时移除。 */
    function useStyles() {
      React.useEffect(() => {
        const id = 'dsh-wechat-assistant/styles'
        if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return undefined
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-wechat-assistant'
        tag.dataset.pluginCss = id
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }, [])
    }

    /**
     * 调一次 Host 路由。
     *
     * @param path - 相对于插件前缀的路径。
     * @param init - fetch 选项。
     * @returns 解析后的 JSON。
     */
    async function api(path, init) {
      const response = await fetch(`${API}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
      return body
    }

    /** 微信官方绿的小标志。 */
    function Mark() {
      return h(
        'span',
        { className: 'dswa-mark' },
        h(
          'svg',
          { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': true },
          h('path', {
            fill: '#fff',
            d: 'M9.1 3C5 3 1.7 5.8 1.7 9.2c0 1.9 1.1 3.6 2.8 4.8l-.7 2.1 2.4-1.2c.9.2 1.8.4 2.9.4h.6c-.2-.6-.3-1.2-.3-1.9 0-3.4 3.2-6.1 7.2-6.1h.6C16.7 4.8 13.2 3 9.1 3Zm-2.6 3.4c-.6 0-1-.5-1-1s.4-1 1-1 1 .5 1 1-.4 1-1 1Zm5.3 0c-.6 0-1-.5-1-1s.4-1 1-1 1 .5 1 1-.4 1-1 1Z',
          }),
          h('path', {
            fill: '#fff',
            d: 'M22.3 13.4c0-2.9-2.9-5.2-6.4-5.2s-6.4 2.3-6.4 5.2 2.9 5.2 6.4 5.2c.8 0 1.6-.1 2.3-.3l2 1-.6-1.8c1.6-1 2.7-2.4 2.7-4.1Zm-8.5-1.1c-.5 0-.9-.4-.9-.9s.4-.9.9-.9.9.4.9.9-.4.9-.9.9Zm4.3 0c-.5 0-.9-.4-.9-.9s.4-.9.9-.9.9.4.9.9-.4.9-.9.9Z',
          }),
        ),
      )
    }

    /** 一个状态徽标。 */
    function Badge({ state }) {
      if (state === 'connected') return h('span', { className: 'dswa-badge dswa-badge-on' }, '已连接')
      if (state === 'connecting') return h('span', { className: 'dswa-badge dswa-badge-busy' }, '连接中…')
      return h('span', { className: 'dswa-badge dswa-badge-off' }, '未连接')
    }

    /**
     * 把一段文本画成二维码 SVG（本地实现，byte 模式 / 纠错 L）。
     *
     * @param text - 要编码的短链接。
     * @param scale - 每个模块的像素数。
     */
    function QrCode({ text, scale = 4 }) {
      const model = React.useMemo(() => encodeQrSafely(text), [text])
      if (model === undefined) return h('p', { className: 'dswa-qr-hint' }, '二维码生成失败，请点击刷新')
      const size = model.size
      const path = []
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          if (model.modules[y][x] === 1) path.push(`M${x} ${y}h1v1h-1z`)
        }
      }
      const px = size * scale + scale * 2
      return h(
        'div',
        { className: 'dswa-qr' },
        h(
          'svg',
          {
            width: px,
            height: px,
            viewBox: `${-1} ${-1} ${size + 2} ${size + 2}`,
            role: 'img',
            'aria-label': '微信登录二维码',
          },
          h('rect', { x: -1, y: -1, width: size + 2, height: size + 2, fill: '#fff' }),
          h('path', { d: path.join(''), fill: '#000' }),
        ),
      )
    }

    /** 设置页主体。`t` 由宿主在注册了 locale 命名空间后注入。 */
    function WeChatAssistantSection({ t }) {
      useStyles()
      const tr = typeof t === 'function' ? t : (key) => zh[key] ?? key
      const [state, setState] = React.useState(undefined)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [verifyCode, setVerifyCode] = React.useState('')
      /** 发送者授权状态：主人、已批准、待审批。 */
      const [access, setAccess] = React.useState({ owner: '', allowed: [], pending: [] })
      /** Agent 注册表。 */
      const [agents, setAgents] = React.useState({ agents: [], defaultName: 'default' })
      /** DSH 的模型目录。 */
      const [catalog, setCatalog] = React.useState({ providers: [] })
      /** DSH 的 agent preset 列表。 */
      const [presets, setPresets] = React.useState([])
      /** 新建 Agent 的草稿。 */
      const [draft, setDraft] = React.useState({ name: '', model: '', preset: '' })
      /** 共存账号：同机其它微信 ClawBot 应用的账号。 */
      const [coexist, setCoexist] = React.useState({ accounts: [] })
      /** 共存账号的草稿。 */
      const [coexistDraft, setCoexistDraft] = React.useState({ label: '', token: '' })
      /** 打开页面是否已经自动申请过二维码：只自动一次，之后交给按钮。 */
      const autoStarted = React.useRef(false)

      const refresh = React.useCallback(async () => {
        try {
          const next = await api('/state')
          setState(next)
          setError('')
          return next
        } catch (cause) {
          setError(String(cause?.message ?? cause))
          return undefined
        }
      }, [])

      const refreshAccess = React.useCallback(async () => {
        try {
          const next = await api('/access')
          setAccess({ owner: next.owner ?? '', allowed: next.allowed ?? [], pending: next.pending ?? [] })
        } catch {
          // 访问控制不可用时保持空列表：不显示任何可点的授权动作。
        }
      }, [])

      const refreshAgents = React.useCallback(async () => {
        try {
          const next = await api('/agents')
          setAgents({ agents: next.agents ?? [], defaultName: next.defaultName ?? 'default' })
        } catch {
          // 保留上一次的列表，不清空成空壳。
        }
      }, [])

      const refreshCatalog = React.useCallback(async () => {
        try {
          const [models, presetList] = await Promise.all([api('/models'), api('/presets')])
          setCatalog({ providers: models.providers ?? [] })
          setPresets(presetList.presets ?? [])
        } catch {
          // 目录不可用时保持空列表，下拉框只剩「宿主默认」。
        }
      }, [])

      const refreshCoexist = React.useCallback(async () => {
        try {
          const next = await api('/coexist')
          setCoexist({ accounts: next.accounts ?? [] })
        } catch {
          // 保留上一次的列表。
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        refresh()
        refreshAccess()
        refreshAgents()
        refreshCatalog()
        refreshCoexist()
        const timer = setInterval(() => {
          if (alive) refresh()
        }, 1500)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [refresh, refreshAccess, refreshAgents, refreshCatalog, refreshCoexist])

      // 授权列表变化不频繁，但待审批的请求应该尽快出现在页面上。
      React.useEffect(() => {
        const timer = setInterval(refreshAccess, 4000)
        return () => clearInterval(timer)
      }, [refreshAccess])

      // 打开页面且还没连接过任何账号时，直接要一张二维码——不要让用户先猜
      // 该点哪里。只自动一次；失败或取消后由按钮接管，避免反复弹码。
      React.useEffect(() => {
        if (autoStarted.current) return
        if (state === undefined) return
        if (state.configured === true) return
        if (state.login !== undefined) return
        autoStarted.current = true
        api('/login/start', { method: 'POST' })
          .then(() => refresh())
          .catch((cause) => setError(String(cause?.message ?? cause)))
      }, [state, refresh])

      const run = React.useCallback(
        async (label, path, init) => {
          setBusy(label)
          setError('')
          try {
            await api(path, init)
            await refresh()
            await refreshAccess()
            await refreshAgents()
            await refreshCoexist()
          } catch (cause) {
            setError(String(cause?.message ?? cause))
          } finally {
            setBusy('')
          }
        },
        [refresh, refreshAccess, refreshAgents, refreshCoexist],
      )

      const login = state?.login
      const loginStatus = login?.status
      const qrUrl = login?.qrcodeUrl
      const needCode = loginStatus === 'need_verifycode'
      /** 二维码已失效：不要再画一个扫不了的码，直接提示刷新。 */
      const expired = loginStatus === 'expired' || login?.done === true
      const running = state?.running === true
      const configured = state?.configured === true
      const accountId = state?.accountId
      const stats = state?.stats ?? {}

      return h(
        'div',
        { className: 'dswa-root' },
        h(
          'div',
          {},
          h('h2', { className: 'dswa-title' }, tr('title')),
          h(
            'p',
            { className: 'dswa-sub' },
            tr('intro'),
          ),
        ),
        h(
          'div',
          { className: 'dswa-grid' },
          h(
            'div',
            { className: 'dswa-card' },
            h(
              'div',
              { className: 'dswa-card-head' },
              h(Mark),
              h('h3', { className: 'dswa-card-title' }, tr('cardTitle')),
              h(Badge, { state: running ? 'connected' : busy === 'login' ? 'connecting' : 'idle' }),
            ),
            h(
              'p',
              { className: 'dswa-card-desc' },
              '通过微信直接下发指令，结果实时回传至微信聊天窗口。',
            ),
            accountId !== undefined
              ? h(
                  'div',
                  { className: 'dswa-meta' },
                  h(
                    'div',
                    { className: 'dswa-meta-row' },
                    h('span', { className: 'dswa-meta-key' }, tr('account')),
                    h('span', { className: 'dswa-meta-val', title: accountId }, accountId),
                  ),
                  h(
                    'div',
                    { className: 'dswa-meta-row' },
                    h('span', { className: 'dswa-meta-key' }, tr('inbound')),
                    h('span', { className: 'dswa-meta-val' }, String(stats.inbound ?? 0)),
                  ),
                  h(
                    'div',
                    { className: 'dswa-meta-row' },
                    h('span', { className: 'dswa-meta-key' }, tr('outbound')),
                    h('span', { className: 'dswa-meta-val' }, String(stats.outbound ?? 0)),
                  ),
                )
              : h('p', { className: 'dswa-note' }, tr('never')),
            error !== '' ? h('p', { className: 'dswa-error' }, error) : null,
            stats.lastError !== undefined && stats.lastError !== '' && running
              ? h('p', { className: 'dswa-note' }, `${tr('lastError')}: ${stats.lastError}`)
              : null,
            h(
              'div',
              { className: 'dswa-row' },
              configured
                ? h(
                    'button',
                    {
                      className: 'dswa-btn dswa-btn-danger',
                      disabled: busy !== '' || !running,
                      onClick: () => run('disconnect', '/disconnect', { method: 'POST' }),
                    },
                    tr('disconnect'),
                  )
                : h(
                    'button',
                    {
                      className: 'dswa-btn dswa-btn-primary',
                      disabled: busy !== '' || qrUrl !== undefined,
                      onClick: () =>
                        run('login', '/login/start', { method: 'POST' }).then(() => undefined),
                    },
                    tr('connect'),
                  ),
              configured && !running
                ? h(
                    'button',
                    {
                      className: 'dswa-btn dswa-btn-primary',
                      disabled: busy !== '',
                      onClick: () => run('connect', '/connect', { method: 'POST' }),
                    },
                    tr('reconnect'),
                  )
                : null,
            ),
          ),
          h(
            'div',
            { className: 'dswa-card' },
            h(
              'div',
              { className: 'dswa-card-head' },
              h('h3', { className: 'dswa-card-title' }, tr('qrTitle')),
            ),
            expired
              ? h(
                  'div',
                  { className: 'dswa-qr-wrap' },
                  h('p', { className: 'dswa-qr-hint' }, tr('qrExpired')),
                )
              : qrUrl === undefined || loginStatus === 'confirmed'
              ? h(
                  'p',
                  { className: 'dswa-card-desc' },
                  configured ? tr('qrConnected') : tr('qrLoading'),
                )
              : h(
                  'div',
                  { className: 'dswa-qr-wrap' },
                  h(QrCode, { text: qrUrl }),
                  h(
                    'p',
                    { className: 'dswa-qr-hint' },
                    needCode ? tr('qrNeedCode') : loginStatus === 'scaned' ? tr('qrScaned') : tr('qrWait'),
                  ),
                ),
            needCode
              ? h(
                  'div',
                  { className: 'dswa-code-row' },
                  h('input', {
                    className: 'dswa-input',
                    value: verifyCode,
                    inputMode: 'numeric',
                    placeholder: tr('verifyPlaceholder'),
                    onChange: (event) => setVerifyCode(event.target.value),
                  }),
                  h(
                    'button',
                    {
                      className: 'dswa-btn',
                      disabled: busy !== '' || verifyCode.trim() === '',
                      onClick: () =>
                        run('verify', '/login/verify', {
                          method: 'POST',
                          body: JSON.stringify({ code: verifyCode.trim() }),
                        }).then(() => setVerifyCode('')),
                    },
                    tr('submit'),
                  ),
                )
              : null,
            login !== undefined && login.done === true && login.error !== undefined && login.error !== ''
              ? h('p', { className: 'dswa-error' }, login.error)
              : null,
            qrUrl !== undefined && loginStatus !== 'confirmed'
              ? h(
                  'div',
                  { className: 'dswa-row' },
                  h(
                    'button',
                    {
                      className: 'dswa-btn dswa-btn-primary',
                      disabled: busy !== '',
                      onClick: () => run('refresh', '/login/refresh', { method: 'POST' }),
                    },
                    tr('refreshQr'),
                  ),
                  h(
                    'button',
                    {
                      className: 'dswa-btn',
                      disabled: busy !== '' || !configured,
                      onClick: () => run('cancel', '/login/cancel', { method: 'POST' }),
                    },
                    tr('cancelScan'),
                  ),
                )
              : null,
            expired
              ? h(
                  'div',
                  { className: 'dswa-row' },
                  h(
                    'button',
                    {
                      className: 'dswa-btn dswa-btn-primary',
                      disabled: busy !== '',
                      onClick: () => run('refresh', '/login/refresh', { method: 'POST' }),
                    },
                    tr('refreshQr'),
                  ),
                )
              : null,
          ),
          h(
            'div',
            { className: 'dswa-card' },
            h(
              'div',
              { className: 'dswa-card-head' },
              h('h3', { className: 'dswa-card-title' }, tr('accessTitle')),
            ),
            h('p', { className: 'dswa-card-desc' }, tr('accessDesc')),
            access.owner !== undefined && access.owner !== ''
              ? h(
                  'div',
                  { className: 'dswa-meta' },
                  h(
                    'div',
                    { className: 'dswa-meta-row' },
                    h('span', { className: 'dswa-meta-key' }, tr('accessOwner')),
                    h('span', { className: 'dswa-meta-val', title: access.owner }, access.owner),
                  ),
                )
              : h('p', { className: 'dswa-note' }, tr('accessNoOwner')),
            (access.pending ?? []).length > 0
              ? h(
                  'div',
                  { className: 'dswa-meta' },
                  h(
                    'div',
                    { className: 'dswa-meta-row' },
                    h('span', { className: 'dswa-meta-key' }, tr('accessPending')),
                    h('span', { className: 'dswa-meta-val' }, String(access.pending.length)),
                  ),
                )
              : null,
            (access.pending ?? []).map((userId) =>
              h(
                'div',
                { key: `pending-${userId}`, className: 'dswa-row' },
                h('span', { className: 'dswa-meta-val', title: userId }, userId),
                h(
                  'button',
                  {
                    className: 'dswa-btn dswa-btn-primary',
                    disabled: busy !== '',
                    onClick: () =>
                      run('approve', '/access/approve', {
                        method: 'POST',
                        body: JSON.stringify({ userId }),
                      }),
                  },
                  tr('approve'),
                ),
              ),
            ),
            (access.allowed ?? []).length > 0
              ? h(
                  'div',
                  { className: 'dswa-meta' },
                  h(
                    'div',
                    { className: 'dswa-meta-row' },
                    h('span', { className: 'dswa-meta-key' }, tr('accessAllowed')),
                    h('span', { className: 'dswa-meta-val' }, String(access.allowed.length)),
                  ),
                )
              : null,
            (access.allowed ?? []).map((userId) =>
              h(
                'div',
                { key: `allowed-${userId}`, className: 'dswa-row' },
                h('span', { className: 'dswa-meta-val', title: userId }, userId),
                h(
                  'button',
                  {
                    className: 'dswa-btn dswa-btn-danger',
                    disabled: busy !== '',
                    onClick: () =>
                      run('revoke', '/access/revoke', {
                        method: 'POST',
                        body: JSON.stringify({ userId }),
                      }),
                  },
                  tr('revoke'),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dswa-card' },
            h(
              'div',
              { className: 'dswa-card-head' },
              h('h3', { className: 'dswa-card-title' }, tr('agentsTitle')),
              h('span', { className: 'dswa-badge' }, `${agents.agents.length} ${tr('agentsCount')}`),
            ),
            h('p', { className: 'dswa-card-desc' }, tr('agentsDesc')),
            agents.agents.map((agent) =>
              h(
                'div',
                { key: `agent-${agent.name}`, className: 'dswa-meta' },
                h(
                  'div',
                  { className: 'dswa-meta-row' },
                  h(
                    'span',
                    { className: 'dswa-meta-key' },
                    `${agent.name}${agent.name === agents.defaultName ? ' *' : ''}`,
                  ),
                  h(
                    'span',
                    { className: 'dswa-meta-val', title: `${agent.provider}/${agent.model}` },
                    agent.model === ''
                      ? tr('agentsDefaultModel')
                      : `${agent.provider}/${agent.model}`,
                  ),
                ),
                h(
                  'div',
                  { className: 'dswa-meta-row' },
                  h('span', { className: 'dswa-meta-key' }, tr('agentsPreset')),
                  h(
                    'span',
                    { className: 'dswa-meta-val' },
                    agent.preset === '' ? tr('agentsDefaultPreset') : agent.preset,
                  ),
                ),
                h(
                  'div',
                  { className: 'dswa-row' },
                  h(
                    'button',
                    {
                      className: 'dswa-btn',
                      disabled: busy !== '' || agent.name === 'default',
                      onClick: () =>
                        run('remove-agent', '/agents/remove', {
                          method: 'POST',
                          body: JSON.stringify({ name: agent.name }),
                        }),
                    },
                    tr('remove'),
                  ),
                  h(
                    'button',
                    {
                      className: 'dswa-btn',
                      disabled: busy !== '' || agent.name === agents.defaultName,
                      onClick: () =>
                        run('default-agent', '/agents/default', {
                          method: 'POST',
                          body: JSON.stringify({ name: agent.name }),
                        }),
                    },
                    tr('setDefault'),
                  ),
                ),
              ),
            ),
            h(
              'div',
              { className: 'dswa-code-row' },
              h('input', {
                className: 'dswa-input',
                value: draft.name,
                placeholder: tr('agentsNamePlaceholder'),
                onChange: (event) => setDraft({ ...draft, name: event.target.value }),
              }),
              h(
                'select',
                {
                  className: 'dswa-input',
                  value: draft.model,
                  onChange: (event) => setDraft({ ...draft, model: event.target.value }),
                },
                h('option', { value: '' }, tr('agentsDefaultModel')),
                catalog.providers.flatMap((provider) =>
                  provider.models.map((model) =>
                    h(
                      'option',
                      { key: `${provider.id}/${model.id}`, value: `${provider.id}/${model.id}` },
                      `${provider.id}/${model.id}`,
                    ),
                  ),
                ),
              ),
              h(
                'button',
                {
                  className: 'dswa-btn dswa-btn-primary',
                  disabled: busy !== '' || draft.name.trim() === '',
                  onClick: () => {
                    const slash = draft.model.lastIndexOf('/')
                    const provider = slash > 0 ? draft.model.slice(0, slash) : ''
                    const model = slash > 0 ? draft.model.slice(slash + 1) : ''
                    run('add-agent', '/agents/upsert', {
                      method: 'POST',
                      body: JSON.stringify({
                        name: draft.name.trim(),
                        provider,
                        model,
                        preset: draft.preset,
                      }),
                    }).then(() => setDraft({ ...draft, name: '' }))
                  },
                },
                tr('addAgent'),
              ),
            ),
            h(
              'div',
              { className: 'dswa-code-row' },
              h(
                'select',
                {
                  className: 'dswa-input',
                  value: draft.preset,
                  onChange: (event) => setDraft({ ...draft, preset: event.target.value }),
                },
                h('option', { value: '' }, tr('agentsDefaultPreset')),
                presets.map((preset) =>
                  h('option', { key: preset.id, value: preset.id }, preset.name ?? preset.id),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dswa-card' },
            h(
              'div',
              { className: 'dswa-card-head' },
              h('h3', { className: 'dswa-card-title' }, tr('coexistTitle')),
            ),
            h('p', { className: 'dswa-card-desc' }, tr('coexistDesc')),
            coexist.accounts.map((account) =>
              h(
                'div',
                { key: `coexist-${account.label}`, className: 'dswa-row' },
                h('span', { className: 'dswa-meta-val', title: account.note ?? '' }, account.label),
                h(
                  'button',
                  {
                    className: 'dswa-btn dswa-btn-danger',
                    disabled: busy !== '',
                    onClick: () =>
                      run('remove-coexist', '/coexist/remove', {
                        method: 'POST',
                        body: JSON.stringify({ label: account.label }),
                      }),
                  },
                  tr('remove'),
                ),
              ),
            ),
            h(
              'div',
              { className: 'dswa-code-row' },
              h('input', {
                className: 'dswa-input',
                value: coexistDraft.label,
                placeholder: tr('coexistLabelPlaceholder'),
                onChange: (event) => setCoexistDraft({ ...coexistDraft, label: event.target.value }),
              }),
              h('input', {
                className: 'dswa-input',
                value: coexistDraft.token,
                placeholder: tr('coexistTokenPlaceholder'),
                onChange: (event) => setCoexistDraft({ ...coexistDraft, token: event.target.value }),
              }),
              h(
                'button',
                {
                  className: 'dswa-btn dswa-btn-primary',
                  disabled: busy !== '' || coexistDraft.label.trim() === '' || coexistDraft.token.trim() === '',
                  onClick: () =>
                    run('add-coexist', '/coexist/add', {
                      method: 'POST',
                      body: JSON.stringify({
                        label: coexistDraft.label.trim(),
                        token: coexistDraft.token.trim(),
                      }),
                    }).then(() => setCoexistDraft({ label: '', token: '' })),
                },
                tr('addCoexist'),
              ),
            ),
          ),
        ),
      )
    }

    /** 客户端 context 提供的 slots 与 locale 服务。 */
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-wechat-assistant: dictionaries')
        ctx.effect(() =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'dsh-wechat-assistant',
                order: 30,
                label: () => t('cardTitle'),
                locale: NS,
              },
              WeChatAssistantSection,
            ),
          ),
        )
      },
    }
  },
})
