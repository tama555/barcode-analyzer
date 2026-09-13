/**
 * デコード経路の往復テスト。
 *   node tests/roundtrip.test.js
 *
 * アプリ本体と同じ経路（輝度バッファ → RGBLuminanceSource → HybridBinarizer →
 * MultiFormatReader）を通し、生成したシンボルが元の文字列に戻ることを確認する。
 * 1 次元は js/generate.js、2 次元は ZXing の書き出し機能で生成する。
 */
const path = require('path');
const ZXing = require(path.join(__dirname, '..', 'vendor', 'zxing.umd.js'));
const Gen = require(path.join(__dirname, '..', 'js', 'generate.js'));

const { BarcodeFormat, DecodeHintType, EncodeHintType, MultiFormatWriter,
  MultiFormatReader, RGBLuminanceSource, HybridBinarizer, BinaryBitmap } = ZXing;

const reader = new MultiFormatReader();
const hints = new Map();
hints.set(DecodeHintType.TRY_HARDER, true);
hints.set(DecodeHintType.POSSIBLE_FORMATS, [
  BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
  BarcodeFormat.CODE_39, BarcodeFormat.CODE_93, BarcodeFormat.CODE_128, BarcodeFormat.ITF,
  BarcodeFormat.CODABAR, BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX,
  BarcodeFormat.AZTEC, BarcodeFormat.PDF_417,
]);

/** アプリ本体の decodeLuminance と同じ処理 */
function decode(lum, width, height) {
  try {
    const source = new RGBLuminanceSource(lum, width, height);
    return reader.decode(new BinaryBitmap(new HybridBinarizer(source)), hints);
  } catch (e) {
    return null;
  } finally {
    try { reader.reset(); } catch (e) { /* 初回失敗時は readers 未初期化 */ }
  }
}

/** 2 次元シンボルを ZXing で生成して輝度バッファ化 */
function render2d(text, format, size) {
  const eh = new Map();
  eh.set(EncodeHintType.MARGIN, 10);
  eh.set(EncodeHintType.CHARACTER_SET, 'UTF-8');
  const m = new MultiFormatWriter().encode(text, format, size, size, eh);
  const w = m.getWidth(), h = m.getHeight();
  const lum = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) lum[y * w + x] = m.get(x, y) ? 0 : 255;
  }
  return { lum: lum, width: w, height: h };
}

const cases = [];
for (const [format, text] of [
  ['EAN_13', '4901234567894'],
  ['EAN_13', '9784167240011'],
  ['EAN_8', '49123456'],
  ['UPC_A', '036000291452'],
  ['ITF', '14901234567891'],
  ['CODE_39', 'ABC-1234'],
  ['CODE_39', 'TEST 123'],
]) {
  const enc = Gen.encode(format, text);
  const img = Gen.bitsToLuminance(enc.bits, { moduleWidth: 3, height: 60 });
  cases.push({ label: format, expect: enc.text, img: img });
}
// 同梱の ZXing UMD ビルドが書き出せる 2 次元シンボルは QR のみ。
// 他の 2 次元シンボルの復号処理は ZXing 側で検証済みのため、ここでは経路のみ確認する。
for (const [format, text, size] of [
  [BarcodeFormat.QR_CODE, 'https://example.com/items?id=7', 300],
  [BarcodeFormat.QR_CODE, '日本語テスト', 300],
  [BarcodeFormat.QR_CODE, 'WIFI:T:WPA;S:MyNet;P:secret123;;', 300],
  [BarcodeFormat.QR_CODE, '0104912345678904172512311021ABC', 300],
]) {
  cases.push({ label: BarcodeFormat[format], expect: text, img: render2d(text, format, size) });
}

let ok = 0;
const failures = [];
for (const c of cases) {
  const res = decode(c.img.lum, c.img.width, c.img.height);
  const got = res ? res.getText() : null;
  const fmt = res ? BarcodeFormat[res.getBarcodeFormat()] : '-';
  if (got === c.expect) {
    ok++;
    console.log('OK  ' + fmt.padEnd(12) + JSON.stringify(c.expect));
  } else {
    failures.push(c.label + ' ' + JSON.stringify(c.expect) + ' → ' + JSON.stringify(got) + ' (' + fmt + ')');
    console.log('NG  ' + c.label.padEnd(12) + JSON.stringify(c.expect) + ' → ' + JSON.stringify(got));
  }
}

console.log('\n成功 ' + ok + ' 件 / 失敗 ' + failures.length + ' 件');
if (failures.length) process.exit(1);
