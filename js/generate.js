/**
 * generate.js - 動作確認用のサンプルバーコードを生成する
 *
 * 1 次元シンボルは自前でモジュールパターン（"0"/"1" の並び）を組み立て、
 * 2 次元シンボルは ZXing の MultiFormatWriter に任せる。
 * ブラウザと Node の両方から使える。
 */
var BarcodeGen = (function () {
  'use strict';

  /* ------------------------- EAN / UPC ------------------------- */
  const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011',
                 '0110001', '0101111', '0111011', '0110111', '0001011'];
  const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101',
                 '0111001', '0000101', '0010001', '0001001', '0010111'];
  const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100',
                 '1001110', '1010000', '1000100', '1001000', '1110100'];
  const EAN13_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
                        'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

  function mod10(payload) {
    let sum = 0;
    for (let i = payload.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
      sum += (payload.charCodeAt(i) - 48) * w;
    }
    return String((10 - (sum % 10)) % 10);
  }

  function ean13(code) {
    if (/^\d{12}$/.test(code)) code += mod10(code);
    if (!/^\d{13}$/.test(code)) throw new Error('EAN-13 は 12 または 13 桁の数字です');
    const parity = EAN13_PARITY[code.charCodeAt(0) - 48];
    let bits = '101';
    for (let i = 1; i <= 6; i++) {
      const d = code.charCodeAt(i) - 48;
      bits += parity[i - 1] === 'L' ? EAN_L[d] : EAN_G[d];
    }
    bits += '01010';
    for (let i = 7; i <= 12; i++) bits += EAN_R[code.charCodeAt(i) - 48];
    bits += '101';
    return { bits: bits, text: code };
  }

  function ean8(code) {
    if (/^\d{7}$/.test(code)) code += mod10(code);
    if (!/^\d{8}$/.test(code)) throw new Error('EAN-8 は 7 または 8 桁の数字です');
    let bits = '101';
    for (let i = 0; i < 4; i++) bits += EAN_L[code.charCodeAt(i) - 48];
    bits += '01010';
    for (let i = 4; i < 8; i++) bits += EAN_R[code.charCodeAt(i) - 48];
    bits += '101';
    return { bits: bits, text: code };
  }

  function upcA(code) {
    if (/^\d{11}$/.test(code)) code += mod10(code);
    if (!/^\d{12}$/.test(code)) throw new Error('UPC-A は 11 または 12 桁の数字です');
    let bits = '101';
    for (let i = 0; i < 6; i++) bits += EAN_L[code.charCodeAt(i) - 48];
    bits += '01010';
    for (let i = 6; i < 12; i++) bits += EAN_R[code.charCodeAt(i) - 48];
    bits += '101';
    return { bits: bits, text: code };
  }

  /* --------------------------- Code 39 -------------------------- */
  // 9 エレメント（バーと空白の交互、先頭はバー）を n=細 / w=太 で表す
  const CODE39 = {
    '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn',
    '4': 'nnnwwnnnw', '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw',
    '8': 'wnnwnnwnn', '9': 'nnwwnnwnn', 'A': 'wnnnnwnnw', 'B': 'nnwnnwnnw',
    'C': 'wnwnnwnnn', 'D': 'nnnnwwnnw', 'E': 'wnnnwwnnn', 'F': 'nnwnwwnnn',
    'G': 'nnnnnwwnw', 'H': 'wnnnnwwnn', 'I': 'nnwnnwwnn', 'J': 'nnnnwwwnn',
    'K': 'wnnnnnnww', 'L': 'nnwnnnnww', 'M': 'wnwnnnnwn', 'N': 'nnnnwnnww',
    'O': 'wnnnwnnwn', 'P': 'nnwnwnnwn', 'Q': 'nnnnnnwww', 'R': 'wnnnnnwwn',
    'S': 'nnwnnnwwn', 'T': 'nnnnwnwwn', 'U': 'wwnnnnnnw', 'V': 'nwwnnnnnw',
    'W': 'wwwnnnnnn', 'X': 'nwnnwnnnw', 'Y': 'wwnnwnnnn', 'Z': 'nwwnwnnnn',
    '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '$': 'nwnwnwnnn',
    '/': 'nwnwnnnwn', '+': 'nwnnnwnwn', '%': 'nnnwnwnwn', '*': 'nwnnwnwnn',
  };

  /** n/w 列を「先頭バー」で 0/1 のモジュール列に展開する */
  function expandNw(pattern, narrow, wide) {
    let bits = '';
    for (let i = 0; i < pattern.length; i++) {
      const width = pattern[i] === 'w' ? wide : narrow;
      bits += (i % 2 === 0 ? '1' : '0').repeat(width);
    }
    return bits;
  }

  function code39(text) {
    const up = text.toUpperCase();
    for (const ch of up) if (!(ch in CODE39)) throw new Error('Code 39 で使えない文字: ' + ch);
    const chars = ['*', ...up, '*'];
    let bits = '';
    chars.forEach((ch, i) => {
      if (i > 0) bits += '0'; // 文字間ギャップ（細い空白）
      bits += expandNw(CODE39[ch], 1, 3);
    });
    return { bits: bits, text: up };
  }

  /* ----------------------------- ITF ---------------------------- */
  const ITF_DIGIT = ['nnwwn', 'wnnnw', 'nwnnw', 'wwnnn', 'nnwnw',
                     'wnwnn', 'nwwnn', 'nnnww', 'wnnwn', 'nwnwn'];

  function itf(code) {
    if (!/^\d+$/.test(code)) throw new Error('ITF は数字のみです');
    if (code.length % 2 !== 0) code = '0' + code;
    let bits = '1010'; // スタート: 細バー 細空白 細バー 細空白
    for (let i = 0; i < code.length; i += 2) {
      const bars = ITF_DIGIT[code.charCodeAt(i) - 48];
      const spaces = ITF_DIGIT[code.charCodeAt(i + 1) - 48];
      for (let k = 0; k < 5; k++) {
        bits += '1'.repeat(bars[k] === 'w' ? 3 : 1);
        bits += '0'.repeat(spaces[k] === 'w' ? 3 : 1);
      }
    }
    bits += '111' + '0' + '1'; // ストップ: 太バー 細空白 細バー
    return { bits: bits, text: code };
  }

  /* ------------------------- 描画ユーティリティ ------------------- */

  /** モジュール列を canvas に描く。余白（クワイエットゾーン）も確保する */
  function drawBits(canvas, bits, opts) {
    opts = opts || {};
    const moduleW = opts.moduleWidth || 3;
    const height = opts.height || 110;
    const quiet = (opts.quiet == null ? 12 : opts.quiet) * moduleW;
    const labelH = opts.text ? 22 : 0;

    canvas.width = bits.length * moduleW + quiet * 2;
    canvas.height = height + labelH + 12;
    const c = canvas.getContext('2d');
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.fillStyle = '#000000';
    for (let i = 0; i < bits.length; i++) {
      if (bits[i] === '1') c.fillRect(quiet + i * moduleW, 6, moduleW, height);
    }
    if (opts.text) {
      c.font = '13px monospace';
      c.textAlign = 'center';
      c.fillText(opts.text, canvas.width / 2, height + 22);
    }
    return canvas;
  }

  /** モジュール列を輝度バッファへ（テスト用） */
  function bitsToLuminance(bits, opts) {
    opts = opts || {};
    const moduleW = opts.moduleWidth || 3;
    const height = opts.height || 60;
    const quiet = (opts.quiet == null ? 12 : opts.quiet) * moduleW;
    const width = bits.length * moduleW + quiet * 2;
    const lum = new Uint8ClampedArray(width * height);
    lum.fill(255);
    for (let i = 0; i < bits.length; i++) {
      if (bits[i] !== '1') continue;
      for (let x = quiet + i * moduleW; x < quiet + (i + 1) * moduleW; x++) {
        for (let y = 0; y < height; y++) lum[y * width + x] = 0;
      }
    }
    return { lum: lum, width: width, height: height };
  }

  const ENCODERS = { EAN_13: ean13, EAN_8: ean8, UPC_A: upcA, CODE_39: code39, ITF: itf };

  function encode(format, text) {
    const fn = ENCODERS[format];
    if (!fn) throw new Error('未対応のシンボル: ' + format);
    return fn(text);
  }

  return {
    encode: encode,
    drawBits: drawBits,
    bitsToLuminance: bitsToLuminance,
    mod10: mod10,
    formats: Object.keys(ENCODERS),
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = BarcodeGen;
