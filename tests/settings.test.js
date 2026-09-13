/**
 * 読取機の設定を組み立てるロジックのテスト。
 *   node tests/settings.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const sandbox = { TextEncoder, TextDecoder, URL, console };
vm.createContext(sandbox);
for (const f of ['js/data.js', 'js/analyzer.js', 'js/settings.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
}
const { analyzeBarcode, buildDeviceSettings } = sandbox;

let pass = 0;
const failures = [];
function test(name, fn) {
  try { fn(); pass++; }
  catch (e) { failures.push(name + '\n    ' + e.message); }
}

const build = (fmt, val, tally) => buildDeviceSettings(analyzeBarcode(fmt, val, {}, null), tally || null);
const item = (s, label) => s.items.find((i) => i.label === label);
const cd = (s) => item(s, 'チェックデジット検証');

/* -------------------- 有効にするシンボル -------------------- */
test('有効化: 一般的な呼び名を出す', () => {
  assert.strictEqual(item(build('EAN_13', '4901234567894'), '有効にするシンボル').value, 'EAN-13 / JAN-13');
  assert.strictEqual(item(build('CODABAR', 'A12346B'), '有効にするシンボル').value, 'NW-7 (Codabar)');
  assert.strictEqual(item(build('ITF', '14901234567891'), '有効にするシンボル').value, 'ITF (Interleaved 2 of 5)');
});

test('有効化: NW-7 には Codabar 表記の注意を添える', () => {
  assert.ok(item(build('CODABAR', 'A12346B'), '有効にするシンボル').note.includes('Codabar'));
});

test('有効化: UPC は EAN 側にまとめられている場合を注意する', () => {
  assert.ok(item(build('UPC_A', '036000291452'), '有効にするシンボル').note.includes('EAN'));
});

/* -------------------- チェックデジット検証 -------------------- */
test('必須形式で検証が通れば「有効にする」', () => {
  const c = cd(build('EAN_13', '4901234567894'));
  assert.strictEqual(c.value, '有効にする');
  assert.strictEqual(c.level, 'fixed');
});

test('必須形式で検証が通らなければ「要調査」', () => {
  const c = cd(build('EAN_13', '4901234567891'));
  assert.strictEqual(c.value, '要調査');
  assert.strictEqual(c.level, 'warn');
  assert.ok(c.detail.includes('読めません'));
});

test('内蔵検査文字を持つ形式は設定不要と言う', () => {
  const c = cd(build('CODE_128', 'ABC-123'));
  assert.ok(c.value.includes('設定不要'));
  assert.strictEqual(c.level, 'fixed');
});

test('二次元コードは設定項目なしと言う', () => {
  assert.strictEqual(cd(build('QR_CODE', 'https://example.com')).value, '設定項目なし');
  assert.strictEqual(cd(build('DATA_MATRIX', 'ABC')).value, '設定項目なし');
});

test('ITF の14桁以外は要確認にする', () => {
  const c = cd(build('ITF', '1234567890'));
  assert.strictEqual(c.value, '要確認');
  assert.strictEqual(c.level, 'unknown');
});

/* -------------------- 複数枚の集計 -------------------- */
test('NW-7: 一致していても1件では断定しない', () => {
  const s = build('CODABAR', 'A12346B', { evaluated: 1, matched: 1 });
  assert.strictEqual(cd(s).value, '有効にできる可能性');
  assert.strictEqual(cd(s).level, 'unknown');
  assert.strictEqual(s.tally.decisive, false);
  assert.ok(s.tally.hint.includes('あと 2 枚'));
});

test('NW-7: 3件そろえば断定する', () => {
  const s = build('CODABAR', 'A12346B', { evaluated: 3, matched: 3 });
  assert.strictEqual(cd(s).value, '有効にしてよい');
  assert.strictEqual(cd(s).level, 'likely');
  assert.strictEqual(s.tally.decisive, true);
  assert.strictEqual(s.tally.hint, null);
});

test('NW-7: 不一致でも1件では断定しない', () => {
  const s = build('CODABAR', 'A12345B', { evaluated: 1, matched: 0 });
  assert.strictEqual(cd(s).value, '無効にする可能性');
  assert.strictEqual(cd(s).level, 'unknown');
  assert.strictEqual(s.tally.decisive, false);
  assert.ok(cd(s).note.includes('あと 2 枚'));
});

test('NW-7: 不一致も3件そろえば断定する', () => {
  const s = build('CODABAR', 'A12345B', { evaluated: 3, matched: 2 });
  assert.strictEqual(cd(s).value, '無効にする');
  assert.strictEqual(cd(s).level, 'likely');
  assert.strictEqual(s.tally.decisive, true);
});

test('断定に必要な枚数は一致・不一致で同じ', () => {
  const match2 = build('CODABAR', 'A12346B', { evaluated: 2, matched: 2 });
  const miss2 = build('CODABAR', 'A12345B', { evaluated: 2, matched: 1 });
  assert.strictEqual(cd(match2).level, 'unknown');
  assert.strictEqual(cd(miss2).level, 'unknown');
  const match3 = build('CODABAR', 'A12346B', { evaluated: 3, matched: 3 });
  const miss3 = build('CODABAR', 'A12345B', { evaluated: 3, matched: 1 });
  assert.strictEqual(cd(match3).level, 'likely');
  assert.strictEqual(cd(miss3).level, 'likely');
});

test('確率はどの枚数でも説明文に出る', () => {
  for (const n of [1, 2, 3, 5]) {
    const d = cd(build('CODABAR', 'A12346B', { evaluated: n, matched: n })).detail;
    assert.ok(/%/.test(d), n + ' 件で確率が出ていない: ' + d);
    assert.ok(d.indexOf(n + ' 件') === 0, n + ' 件の件数表示がない: ' + d);
  }
});

test('集計の確率が枚数とともに下がる', () => {
  const p1 = build('CODABAR', 'A12346B', { evaluated: 1, matched: 1 }).tally.sentence;
  const p4 = build('CODABAR', 'A12346B', { evaluated: 4, matched: 4 }).tally.sentence;
  assert.ok(p1.includes('6.3 %'), p1);
  assert.ok(p4.includes('0.002 %'), p4);
});

test('必須形式には集計ブロックを出さない', () => {
  assert.strictEqual(build('EAN_13', '4901234567894', { evaluated: 3, matched: 3 }).tally, null);
});

/* -------------------- スタート・ストップ文字 -------------------- */
test('NW-7 のときだけスタート・ストップの項目を出す', () => {
  assert.ok(item(build('CODABAR', 'A12346B'), 'スタート・ストップ文字'));
  assert.strictEqual(item(build('CODE_39', 'ABC-1234'), 'スタート・ストップ文字'), undefined);
  assert.strictEqual(item(build('EAN_13', '4901234567894'), 'スタート・ストップ文字'), undefined);
});

test('スタート・ストップ: 送信有無での桁数の違いを示す', () => {
  const i = item(build('CODABAR', 'A12345B'), 'スタート・ストップ文字');
  assert.strictEqual(i.value, 'A … B');
  assert.ok(i.note.includes('7 文字'), i.note);
  assert.ok(i.note.includes('5 文字'), i.note);
});

test('スタート・ストップ: 含まれていない場合も案内する', () => {
  const i = item(build('CODABAR', '1234567'), 'スタート・ストップ文字');
  assert.ok(i.value.includes('含まれていません'));
});

/* -------------------- 結果 -------------------- */
console.log('成功 ' + pass + ' 件 / 失敗 ' + failures.length + ' 件');
if (failures.length) {
  console.log('\n--- 失敗 ---');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
