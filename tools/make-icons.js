/**
 * make-icons.js - ホーム画面用のアイコン PNG を生成する
 *   node tools/make-icons.js
 *
 * 外部ライブラリを使わず、Node 標準の zlib だけで PNG を書き出す。
 * 図柄はバーコードを模した縦縞。サイズが小さくても形が潰れないよう、
 * 線の本数を絞って太めに描く。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ------------------------------------------------------------------ *
 * PNG エンコーダ
 * ------------------------------------------------------------------ */

/** CRC-32。Node 20.15 以降は zlib.crc32 が使えるので、あればそれを使う */
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** RGBA バッファ（幅×高さ×4）を PNG に変換する */
function encodePng(rgba, width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // ビット深度
  ihdr[9] = 6;   // カラータイプ 6 = RGBA
  ihdr[10] = 0;  // 圧縮方式
  ihdr[11] = 0;  // フィルタ方式
  ihdr[12] = 0;  // インタレースなし

  // 各行の先頭にフィルタ種別バイト 0 を付ける
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const src = y * width * 4;
    const dst = y * (width * 4 + 1);
    raw[dst] = 0;
    rgba.copy(raw, dst + 1, src, src + width * 4);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * 図柄
 * ------------------------------------------------------------------ */

const BG = [0x1f, 0x6f, 0xeb];      // アプリのアクセント色
const FG = [0xff, 0xff, 0xff];      // 縞の色

/**
 * 縞のモジュール列。1 が線、0 が隙間。
 * EAN-13 のような不均一さを出しつつ、細すぎる線は作らない。
 */
const PATTERN = '110101100111011001011001110101101100110101110011';

function makeCanvas(size) {
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = BG[0];
    buf[i * 4 + 1] = BG[1];
    buf[i * 4 + 2] = BG[2];
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

function fillRect(buf, size, x0, y0, w, h, color) {
  const xEnd = Math.min(size, Math.round(x0 + w));
  const yEnd = Math.min(size, Math.round(y0 + h));
  for (let y = Math.max(0, Math.round(y0)); y < yEnd; y++) {
    for (let x = Math.max(0, Math.round(x0)); x < xEnd; x++) {
      const i = (y * size + x) * 4;
      buf[i] = color[0];
      buf[i + 1] = color[1];
      buf[i + 2] = color[2];
      buf[i + 3] = 255;
    }
  }
}

/**
 * @param {number} size     出力する一辺のピクセル数
 * @param {number} coverage 図柄が占める割合。マスク対応版は小さくして安全域を確保する
 */
function drawIcon(size, coverage) {
  const buf = makeCanvas(size);
  const areaW = size * coverage;
  const areaH = size * coverage * 0.62;
  const left = (size - areaW) / 2;
  const top = (size - areaH) / 2;

  const moduleW = areaW / PATTERN.length;
  let i = 0;
  while (i < PATTERN.length) {
    if (PATTERN[i] === '0') { i++; continue; }
    let j = i;
    while (j < PATTERN.length && PATTERN[j] === '1') j++;
    fillRect(buf, size, left + i * moduleW, top, (j - i) * moduleW, areaH, FG);
    i = j;
  }
  return buf;
}

/* ------------------------------------------------------------------ *
 * 出力
 * ------------------------------------------------------------------ */

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192, coverage: 0.74 },
  { file: 'icon-512.png', size: 512, coverage: 0.74 },
  // マスク対応版は端を切り落とされるため、中央 60% に収める
  { file: 'icon-maskable-512.png', size: 512, coverage: 0.56 },
  { file: 'apple-touch-icon-180.png', size: 180, coverage: 0.74 },
];

for (const t of targets) {
  const png = encodePng(drawIcon(t.size, t.coverage), t.size, t.size);
  fs.writeFileSync(path.join(outDir, t.file), png);
  console.log(t.file + '  ' + t.size + 'x' + t.size + '  ' + png.length + ' バイト');
}
