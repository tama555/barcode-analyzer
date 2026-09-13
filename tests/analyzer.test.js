/**
 * 解析ロジックの単体テスト。
 *   node tests/analyzer.test.js
 * ブラウザ用のスクリプトをそのまま vm コンテキストへ読み込んで検証する。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const sandbox = { TextEncoder, TextDecoder, URL, console };
vm.createContext(sandbox);
for (const f of ['js/data.js', 'js/analyzer.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
}
const { analyzeBarcode, mod10Gtin, expandUpcE, parseGs1, lookupGs1Prefix } = sandbox;

let pass = 0;
const failures = [];
function test(name, fn) {
  try { fn(); pass++; }
  catch (e) { failures.push(name + '\n    ' + e.message); }
}

const findCheck = (r, re) => r.checks.find((c) => re.test(c.name));
const struct = (r, re) => r.structure.find((s) => re.test(s.label));

/* ---------------------- モジュラス10 ---------------------- */
test('mod10: JAN の検査数字', () => {
  assert.strictEqual(mod10Gtin('490123456789').check, 4);
  assert.strictEqual(mod10Gtin('978416724001').check, 1);
  assert.strictEqual(mod10Gtin('03600029145').check, 2); // UPC-A
});

/* ---------------------- EAN-13 ---------------------- */
test('EAN-13: 正しい CD を OK と判定する', () => {
  const r = analyzeBarcode('EAN_13', '4901234567894', {}, null);
  const c = findCheck(r, /チェックデジット/);
  assert.strictEqual(c.status, 'ok');
  assert.strictEqual(r.symbology.label, 'EAN-13 / JAN-13');
});

test('EAN-13: 誤った CD を NG と判定し正解を示す', () => {
  const r = analyzeBarcode('EAN_13', '4901234567891', {}, null);
  const c = findCheck(r, /チェックデジット/);
  assert.strictEqual(c.status, 'ng');
  assert.ok(c.detail.includes('4'), '正しい値 4 を提示していない: ' + c.detail);
});

test('EAN-13: 日本の GS1 プレフィックスを判定する', () => {
  const r = analyzeBarcode('EAN_13', '4901234567894', {}, null);
  assert.ok(struct(r, /GS1 プレフィックス/).note.includes('日本'));
});

test('EAN-13: 978 を ISBN として扱い ISBN-10 を算出する', () => {
  const r = analyzeBarcode('EAN_13', '9784167240011', {}, null);
  assert.strictEqual(r.content.label, 'ISBN-13');
  const isbn10 = struct(r, /旧 ISBN-10/);
  assert.strictEqual(isbn10.value, '4167240017');
  assert.ok(struct(r, /国・言語圏/), '日本の言語圏記号を示していない');
});

test('EAN-13: 977 を ISSN として扱う', () => {
  const r = analyzeBarcode('EAN_13', '9771234567003', {}, null);
  assert.ok(struct(r, /用途/).value.includes('ISSN'));
  assert.ok(/^\d{4}-\d{4}$/.test(struct(r, /ISSN 表記/).value.replace('X', '0')));
});

test('EAN-13: 192 を日本図書コード 2 段目として解釈する', () => {
  const r = analyzeBarcode('EAN_13', '1920093000905', {}, null);
  assert.ok(struct(r, /用途/).value.includes('日本図書コード'));
  assert.strictEqual(struct(r, /本体価格/).value, '90 円');
  assert.ok(struct(r, /C コード/).note.includes('一般'));
});

test('EAN-13: インストアコードを識別する', () => {
  const r = analyzeBarcode('EAN_13', '2012345678903', {}, null);
  assert.ok(struct(r, /用途/).value.includes('インストア'));
});

test('EAN-13: 桁数が違えば NG', () => {
  const r = analyzeBarcode('EAN_13', '49012345678', {}, null);
  assert.strictEqual(findCheck(r, /桁数/).status, 'ng');
});

/* ---------------------- EAN-8 / UPC ---------------------- */
test('EAN-8: CD を検証する', () => {
  const r = analyzeBarcode('EAN_8', '49123456', {}, null);
  assert.strictEqual(findCheck(r, /チェックデジット/).status, 'ok');
});

test('UPC-A: CD とナンバーシステムを判定する', () => {
  const r = analyzeBarcode('UPC_A', '036000291452', {}, null);
  assert.strictEqual(findCheck(r, /チェックデジット/).status, 'ok');
  assert.strictEqual(struct(r, /ナンバーシステム/).value, '0');
  assert.strictEqual(struct(r, /EAN-13 等価/).value, '0036000291452');
});

test('UPC-E: UPC-A へ正しく展開する', () => {
  // 04252614 -> 042100005264
  const exp = expandUpcE('04252614');
  assert.strictEqual(exp.upca, '042100005264');
  const r = analyzeBarcode('UPC_E', '04252614', {}, null);
  assert.strictEqual(findCheck(r, /チェックデジット/).status, 'ok');
  assert.strictEqual(struct(r, /UPC-A 展開/).value, '042100005264');
});

test('UPC-E: 末尾 3 の展開規則', () => {
  const exp = expandUpcE('01234531');
  assert.strictEqual(exp.upca.length, 12);
  assert.strictEqual(expandUpcE('01234530').upca.slice(0, 7), '0123000');
});

/* ---------------------- ITF ---------------------- */
test('ITF-14: CD を必須として検証する', () => {
  const r = analyzeBarcode('ITF', '14901234567891', {}, null);
  const c = findCheck(r, /チェックデジット/);
  assert.strictEqual(c.status, 'ok');
  assert.strictEqual(struct(r, /インジケータ/).value, '1');
});

test('ITF: 桁数が中途半端なら CD 有無を断定しない', () => {
  const r = analyzeBarcode('ITF', '1234567890', {}, null);
  assert.strictEqual(findCheck(r, /チェックデジット/).status, 'unknown');
});

test('ITF: 奇数桁を指摘する', () => {
  const r = analyzeBarcode('ITF', '12345', {}, null);
  assert.ok(struct(r, /桁数/).note.includes('奇数'));
});

/* ---------------------- Code 39 / 93 / 128 ---------------------- */
test('Code 39: CD なしを「なし」と報告する', () => {
  const r = analyzeBarcode('CODE_39', 'ABC-1234', {}, null);
  assert.strictEqual(findCheck(r, /モジュラス43/).status, 'na');
});

test('Code 39: モジュラス43 の CD 付きを検出する', () => {
  // "TEST" のチェックキャラクタを実際に計算して付与する
  const charset = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';
  const sum = [...'TEST'].reduce((a, c) => a + charset.indexOf(c), 0);
  const r = analyzeBarcode('CODE_39', 'TEST' + charset[sum % 43], {}, null);
  assert.strictEqual(findCheck(r, /モジュラス43/).status, 'info-ok');
});

test('Code 93: 必須チェック文字を説明する', () => {
  const r = analyzeBarcode('CODE_93', 'HELLO', {}, null);
  const c = findCheck(r, /モジュラス47/);
  assert.strictEqual(c.status, 'info-ok');
  assert.ok(c.detail.includes('必須'));
});

test('Code 128: 非 GS1 を自由フォーマットと判定する', () => {
  const r = analyzeBarcode('CODE_128', 'ABC-123-XYZ', {}, null);
  assert.ok(struct(r, /GS1 適用/).value.includes('非 GS1'));
  assert.strictEqual(findCheck(r, /モジュラス103/).status, 'info-ok');
});

test('GS1-128: AI を分解する', () => {
  const r = analyzeBarcode('CODE_128', '0104912345678904172512311021ABC', {}, null);
  assert.ok(r.gs1, 'GS1 として解析されていない');
  const ai = Object.fromEntries(r.gs1.elements.map((e) => [e.ai, e.value]));
  assert.strictEqual(ai['01'], '04912345678904');
  assert.strictEqual(ai['17'], '251231');
  assert.strictEqual(ai['10'], '21ABC');
  assert.strictEqual(r.symbology.label, 'GS1-128 (Code 128 / FNC1 付き)');
});

test('GS1-128: 可変長 AI の後の GS 区切りを扱う', () => {
  const r = analyzeBarcode('CODE_128', '10LOT42\u001d2100000001', {}, null);
  const ai = Object.fromEntries(r.gs1.elements.map((e) => [e.ai, e.value]));
  assert.strictEqual(ai['10'], 'LOT42');
  assert.strictEqual(ai['21'], '00000001');
});

test('GS1: 日付 AI を和暦表記へ変換する', () => {
  const p = parseGs1('17251231');
  assert.strictEqual(p.elements[0].decoded, '2025年12月31日');
});

test('GS1: 小数点位置付き AI (310n) を解釈する', () => {
  const p = parseGs1('3103001750');
  assert.strictEqual(p.elements[0].ai, '3103');
  assert.strictEqual(p.elements[0].decoded, '1.750');
});

test('GS1: GTIN の CD 不一致を指摘する', () => {
  const p = parseGs1('0104912345678900');
  assert.ok(p.elements[0].decoded.includes('不一致'));
});

test('GS1: 未知の AI は残りとして返す', () => {
  const p = parseGs1('0104912345678904ZZZZ');
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.trailing, 'ZZZZ');
});

/* ---------------------- Codabar ---------------------- */
test('Codabar: スタート／ストップ文字を切り出す', () => {
  const r = analyzeBarcode('CODABAR', 'A123456789012B', {}, null);
  assert.ok(struct(r, /スタート/).value.includes('A'));
  assert.ok(struct(r, /推定用途/), '12 桁の用途推定が出ていない');
});

/* ---------------------- QR / 2次元 ---------------------- */
test('QR: 誤り訂正レベルを説明しチェックデジットなしと言う', () => {
  const r = analyzeBarcode('QR_CODE', 'https://example.com/', { errorCorrectionLevel: 'M' }, null);
  const c = findCheck(r, /誤り訂正/);
  assert.ok(c.value.includes('M'));
  assert.ok(c.detail.includes('チェックデジットはありません'));
});

test('QR: URL を分解する', () => {
  const r = analyzeBarcode('QR_CODE', 'https://example.com/items?id=7#top', {}, null);
  assert.strictEqual(r.content.type, 'url');
  const f = Object.fromEntries(r.content.fields.map((x) => [x.label, x.value]));
  assert.strictEqual(f['ホスト'], 'example.com');
  assert.strictEqual(f['クエリ'], 'id=7');
});

test('QR: GS1 デジタルリンクを見分ける', () => {
  const r = analyzeBarcode('QR_CODE', 'https://id.gs1.org/01/09506000134352/21/XYZ', {}, null);
  assert.ok(r.content.label.includes('GS1 デジタルリンク'));
});

test('QR: Wi-Fi 設定を分解する', () => {
  const r = analyzeBarcode('QR_CODE', 'WIFI:T:WPA;S:MyNet;P:secret123;H:false;;', {}, null);
  const f = Object.fromEntries(r.content.fields.map((x) => [x.label, x.value]));
  assert.strictEqual(f['SSID'], 'MyNet');
  assert.strictEqual(f['パスワード'], 'secret123');
});

test('QR: MECARD を分解する', () => {
  const r = analyzeBarcode('QR_CODE', 'MECARD:N:山田 太郎;TEL:0312345678;EMAIL:a@example.com;;', {}, null);
  const f = Object.fromEntries(r.content.fields.map((x) => [x.label, x.value]));
  assert.strictEqual(f['氏名'], '山田 太郎');
  assert.strictEqual(f['電話'], '0312345678');
});

test('QR: 符号化モードを推定する', () => {
  assert.strictEqual(analyzeBarcode('QR_CODE', '12345', {}, null).structure.find((s) => /符号化モード/.test(s.label)).value, '数字モード');
  assert.strictEqual(analyzeBarcode('QR_CODE', 'ABC 123', {}, null).structure.find((s) => /符号化モード/.test(s.label)).value, '英数字モード');
  assert.ok(analyzeBarcode('QR_CODE', '日本語', {}, null).structure.find((s) => /符号化モード/.test(s.label)).value.includes('漢字'));
});

test('データマトリックス: GS1 記号系識別子で GS1 扱いにする', () => {
  const r = analyzeBarcode('DATA_MATRIX', '0104912345678904', { symbologyIdentifier: ']d2' }, null);
  assert.strictEqual(r.symbology.label, 'GS1 データマトリックス');
  assert.ok(r.gs1);
});

/* ---------------------- 生データ ---------------------- */
test('生データ: 文字構成と UTF-8 バイト数を数える', () => {
  const r = analyzeBarcode('QR_CODE', 'Aa1あ', {}, null);
  assert.strictEqual(r.raw.length, 4);
  assert.strictEqual(r.raw.upper, 1);
  assert.strictEqual(r.raw.lower, 1);
  assert.strictEqual(r.raw.digits, 1);
  assert.strictEqual(r.raw.nonAscii, 1);
  assert.strictEqual(r.raw.utf8Bytes, 6);
});

test('GS1 プレフィックス表: 狭い範囲を優先する', () => {
  assert.ok(lookupGs1Prefix('978').name.includes('ISBN'));
  assert.ok(lookupGs1Prefix('450').name.includes('日本'));
  assert.ok(lookupGs1Prefix('690').name.includes('中国'));
});

/* ---------------------- 検証項目の種別 ---------------------- */
const kinds = (r) => r.checks.map((c) => c.kind);

test('種別: EAN-13 は cd を持つ', () => {
  assert.ok(kinds(analyzeBarcode('EAN_13', '4901234567894', {}, null)).includes('cd'));
});

test('種別: Code 128 の mod103 は embedded、GS1 構文は syntax', () => {
  const r = analyzeBarcode('CODE_128', '0104912345678904', {}, null);
  const k = kinds(r);
  assert.ok(k.includes('embedded'), 'embedded がない: ' + k);
  assert.ok(k.includes('syntax'), 'syntax がない: ' + k);
  assert.ok(!k.includes('cd'), 'Code 128 を cd 扱いにしてはいけない: ' + k);
});

test('種別: QR の誤り訂正は ec', () => {
  const k = kinds(analyzeBarcode('QR_CODE', 'test', { errorCorrectionLevel: 'H' }, null));
  assert.ok(k.includes('ec'));
  assert.ok(!k.includes('cd'));
});

test('種別: Code 39 の自己チェックは self', () => {
  const k = kinds(analyzeBarcode('CODE_39', 'ABC-1234', {}, null));
  assert.ok(k.includes('self'));
  assert.ok(k.includes('cd'));
});

/* ---------------------- 結果 ---------------------- */
console.log('成功 ' + pass + ' 件 / 失敗 ' + failures.length + ' 件');
if (failures.length) {
  console.log('\n--- 失敗 ---');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
