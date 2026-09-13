/**
 * settings.js - 解析結果から、読取機に設定すべき項目を組み立てる
 *
 * 想定している使い方:
 *   客先のバーコードを読み、こちらの機器をそれに合わせて設定する。
 *   そのため「このバーコードは何か」ではなく「機器をどう設定するか」を出す。
 *
 * 出力:
 * {
 *   items: [{ label, value, level, detail, note }],
 *   tally: {...} | null   // 複数枚読んだときの集計
 * }
 *
 * level は確からしさ。表示の色分けに使う。
 *   'fixed'   … 規格上そう決まっている。迷う余地がない
 *   'likely'  … 読み取った内容から、そう判断してよい
 *   'unknown' … このアプリでは決められない。発行元への確認が必要
 *   'warn'    … そのままでは設定できない。要調査
 */

/** 任意仕様のチェックデジットを持つ形式と、その計算方式の分母 */
const OPTIONAL_CD_MODULUS = {
  CODABAR: 16,
  CODE_39: 43,
};

/** 機器の設定画面で使われがちな呼び名。メーカー固有の言い回しは避ける */
const SYMBOLOGY_SETTING_NAME = {
  EAN_13: 'EAN-13 / JAN-13',
  EAN_8: 'EAN-8 / JAN-8',
  UPC_A: 'UPC-A',
  UPC_E: 'UPC-E',
  CODE_39: 'Code 39',
  CODE_93: 'Code 93',
  CODE_128: 'Code 128',
  ITF: 'ITF (Interleaved 2 of 5)',
  CODABAR: 'NW-7 (Codabar)',
  RSS_14: 'GS1 DataBar',
  RSS_EXPANDED: 'GS1 DataBar Expanded',
  QR_CODE: 'QR コード',
  DATA_MATRIX: 'データマトリックス',
  AZTEC: 'Aztec',
  PDF_417: 'PDF417',
  MAXICODE: 'MaxiCode',
};

/**
 * @param {object} analysis analyzeBarcode の戻り値
 * @param {object|null} tally 同じ形式の集計 { count, evaluated, matched }
 */
function buildDeviceSettings(analysis, tally) {
  const code = analysis.symbology.code;
  const items = [];

  items.push(symbologyItem(code, analysis));
  items.push(checkDigitItem(code, analysis, tally));

  // スタート・ストップ文字は NW-7 でのみ設定が問題になる。
  // Code 39 は常に * で固定のため、現場で食い違う場面がほとんどない
  if (code === 'CODABAR') items.push(startStopItem(analysis));

  return { items: items, tally: summariseTally(code, tally) };
}

/* ------------------------------------------------------------------ *
 * 1. 有効にするシンボル
 * ------------------------------------------------------------------ */
function symbologyItem(code, analysis) {
  const name = SYMBOLOGY_SETTING_NAME[code] || analysis.symbology.label;
  const item = {
    label: '有効にするシンボル',
    value: name,
    level: 'fixed',
    detail: '機器の設定で ' + name + ' の読み取りを有効にしてください。',
    note: null,
  };
  if (code === 'UPC_A' || code === 'UPC_E') {
    item.note = '機器によっては EAN-13 の設定に含まれている場合があります。UPC の項目が見当たらなければ EAN の項目を確認してください。';
  }
  if (code === 'CODABAR') {
    item.note = '海外製の機器では Codabar と表記されています。';
  }
  return item;
}

/* ------------------------------------------------------------------ *
 * 2. チェックデジット検証
 * ------------------------------------------------------------------ */
function checkDigitItem(code, analysis, tally) {
  const checks = analysis.checks;
  const cd = checks.find((c) => c.kind === 'cd');
  const embedded = checks.find((c) => c.kind === 'embedded');
  const ec = checks.find((c) => c.kind === 'ec');

  // 二次元コードなど、そもそも設定項目がないもの
  if (!cd && ec) {
    return {
      label: 'チェックデジット検証',
      value: '設定項目なし',
      level: 'fixed',
      detail: 'この形式にチェックデジットはありません。誤り訂正が常に働くため、機器側で設定する項目もありません。',
      note: null,
    };
  }

  // シンボル内部にあり、機器が常に検証するもの
  if (!cd && embedded) {
    return {
      label: 'チェックデジット検証',
      value: '設定不要（常に検証される）',
      level: 'fixed',
      detail: 'この形式は検査文字をシンボル内部に必ず持ち、機器が自動で検証します。有効・無効を切り替える設定は通常ありません。',
      note: null,
    };
  }

  if (!cd) {
    return {
      label: 'チェックデジット検証',
      value: '判定できません',
      level: 'unknown',
      detail: 'この形式の検証情報を取得できませんでした。',
      note: null,
    };
  }

  // 規格上そもそも必須の形式
  const modulus = OPTIONAL_CD_MODULUS[code];
  if (!modulus) {
    if (cd.status === 'ok') {
      return {
        label: 'チェックデジット検証',
        value: '有効にする',
        level: 'fixed',
        detail: 'この形式はチェックデジットが必須です。読み取った値も検証を通りました。機器の検証設定は有効にしてください。',
        note: null,
      };
    }
    if (cd.status === 'ng') {
      return {
        label: 'チェックデジット検証',
        value: '要調査',
        level: 'warn',
        detail: 'この形式はチェックデジットが必須ですが、読み取った値が検証を通りませんでした。検証を有効にすると、このバーコードは読めません。',
        note: '印刷不良か、規格に従っていない独自の番号の可能性があります。発行元に確認してください。',
      };
    }
    if (cd.status === 'unknown') {
      return {
        label: 'チェックデジット検証',
        value: '要確認',
        level: 'unknown',
        detail: cd.detail,
        note: '複数枚読み取ると判断できる場合があります。同じ現場のバーコードをあと数枚読んでみてください。',
      };
    }
  }

  // 任意仕様の形式。集計があればそれを根拠にする
  const stat = evaluateTally(modulus, tally);
  if (cd.status === 'info-ok') {
    return {
      label: 'チェックデジット検証',
      value: stat && stat.decisive ? '有効にしてよい' : '有効にできる可能性',
      level: stat && stat.decisive ? 'likely' : 'unknown',
      detail: stat && stat.decisive
        ? stat.sentence + ' 機器の検証設定を有効にして問題ありません。'
        : '末尾の文字が計算結果と一致しました。ただし1枚だけでは偶然の一致と区別できません。',
      // 件数と確率は下の集計欄に出るので、ここでは繰り返さない
      note: stat && stat.decisive ? null : '同じ現場のバーコードをあと数枚読んでください。下の集計欄で確度が上がります。',
    };
  }
  return {
    label: 'チェックデジット検証',
    value: '無効にする',
    level: 'likely',
    detail: '末尾の文字が計算結果と一致しませんでした。検証を有効にすると、このバーコードは読めません。無効にしてください。',
    note: 'モジュラス11 など別方式で付与されている可能性は残ります。読めない個体が出る場合は発行元に方式を確認してください。',
  };
}

/* ------------------------------------------------------------------ *
 * 3. スタート・ストップ文字（NW-7 のみ）
 * ------------------------------------------------------------------ */
function startStopItem(analysis) {
  const text = analysis.raw.text;
  const hasMarks = /^[A-Da-d]/.test(text) && /[A-Da-d]$/.test(text) && text.length >= 2;

  if (!hasMarks) {
    return {
      label: 'スタート・ストップ文字',
      value: '読取結果に含まれていません',
      level: 'likely',
      detail: 'このアプリの読み取りでは両端の文字が出ませんでした。お客さんのシステムが A から D の文字を含む形を期待している場合は、機器の送信設定を有効にしてください。',
      note: null,
    };
  }

  const start = text[0].toUpperCase();
  const stop = text[text.length - 1].toUpperCase();
  const body = text.slice(1, -1);
  return {
    label: 'スタート・ストップ文字',
    value: start + ' … ' + stop,
    level: 'fixed',
    detail: 'このバーコードは ' + start + ' で始まり ' + stop + ' で終わります。機器の設定で、この2文字を送信するかどうかを切り替えられます。',
    note: '送信する場合は ' + text + ' の ' + text.length + ' 文字、送信しない場合は ' + body + ' の ' + body.length + ' 文字になります。お客さんのシステムがどちらを期待しているか確認してください。',
  };
}

/* ------------------------------------------------------------------ *
 * 複数枚の集計
 * ------------------------------------------------------------------ */

/**
 * 任意仕様の形式で、何枚読んで何枚一致したかから確度を出す。
 * 偶然すべて一致する確率は (1/分母)^枚数。
 */
function evaluateTally(modulus, tally) {
  if (!modulus || !tally || !tally.evaluated) return null;

  const n = tally.evaluated;
  const matched = tally.matched;

  if (matched < n) {
    return {
      decisive: true,
      allMatched: false,
      sentence: n + ' 件中 ' + matched + ' 件しか一致しませんでした。チェックデジットは付いていないと判断できます。',
    };
  }

  const probability = Math.pow(1 / modulus, n);
  const decisive = n >= 3;
  return {
    decisive: decisive,
    allMatched: true,
    probability: probability,
    sentence: n + ' 件すべて一致しました。偶然こうなる確率は ' + formatProbability(probability) + ' です。',
  };
}

function formatProbability(p) {
  const pct = p * 100;
  if (pct >= 1) return pct.toFixed(1) + ' %';
  if (pct >= 0.001) return pct.toFixed(3) + ' %';
  return pct.toExponential(1) + ' %';
}

/** 画面に出す集計ブロック。判断材料が足りないときは何枚必要かを示す */
function summariseTally(code, tally) {
  const modulus = OPTIONAL_CD_MODULUS[code];
  if (!modulus || !tally || !tally.evaluated) return null;

  const stat = evaluateTally(modulus, tally);
  const n = tally.evaluated;
  const need = Math.max(0, 3 - n);

  return {
    count: n,
    matched: tally.matched,
    sentence: stat.sentence,
    decisive: stat.decisive,
    hint: stat.decisive
      ? null
      : 'あと ' + need + ' 枚読むと、偶然の一致を排除できます。',
  };
}
