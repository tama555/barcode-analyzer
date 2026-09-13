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

/**
 * 任意仕様のチェックデジットを持つ形式と、1 枚あたり偶然一致してしまう確率。
 *
 * NW-7 はモジュラス16 を2通り（スタート・ストップを含む／含まない）試すため、
 * 単独の 1/16 ではなく、いずれかに当たる確率 1/8 で見積もる。
 * Code 39 はモジュラス43 の1通りのみ。
 */
const OPTIONAL_CD_FALSE_POSITIVE = {
  CODABAR: 1 / 8,
  CODE_39: 1 / 43,
};

/**
 * 断定に必要な読み取り枚数。
 * 一致・不一致のどちらの向きにも同じ枚数を課す。
 * 不一致は統計的には1枚でもほぼ決着するが、印刷不良の1枚を掴んだ場合に
 * 誤った設定を勧めてしまう。現場で迷わないよう基準を一本にする。
 */
const SAMPLES_FOR_DECISION = 3;

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
  const falsePositive = OPTIONAL_CD_FALSE_POSITIVE[code];
  if (!falsePositive) {
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

  // 任意仕様の形式。判断は集計だけを根拠にする。
  // 今読んだ1枚ではなく、これまでに読んだ全件の傾向で決める
  const stat = evaluateTally(falsePositive, tally);
  const allMatched = stat ? stat.allMatched : cd.status === 'info-ok';
  const decisive = stat ? stat.decisive : false;
  const evidence = stat ? stat.sentence : '';
  const remaining = stat ? Math.max(0, SAMPLES_FOR_DECISION - stat.n) : SAMPLES_FOR_DECISION;
  const more = 'あと ' + remaining + ' 枚読むと断定できます。';

  // 集計がある場合は、全枚数で同じ方式に当たったときだけ方式名を出す。
  // 枚数ごとに違う方式に当たっているなら、方式は特定できていない
  const method = stat ? stat.method : (cd.method || null);

  if (allMatched && decisive) {
    return {
      label: 'チェックデジット検証',
      value: method ? '有効にする / ' + method : '有効にしてよい',
      level: 'likely',
      detail: evidence + ' 機器の検証設定を有効にして問題ありません。',
      note: method ? '機器で検証方式を選べる場合は ' + method + ' を指定してください。' : null,
    };
  }
  if (allMatched) {
    return {
      label: 'チェックデジット検証',
      value: '有効にできる可能性',
      level: 'unknown',
      detail: evidence + ' この枚数では偶然の一致と区別できません。',
      note: more,
    };
  }
  if (decisive) {
    return {
      label: 'チェックデジット検証',
      value: '無効にする',
      level: 'likely',
      detail: evidence + ' チェックデジットが付いていれば全件一致するはずです。付いていないと判断してください。',
      note: 'モジュラス11 など別方式で付与されている可能性は残ります。読めない個体が出る場合は発行元に方式を確認してください。',
    };
  }
  return {
    label: 'チェックデジット検証',
    value: '無効にする可能性',
    level: 'unknown',
    detail: evidence + ' チェックデジットなしと考えられますが、印刷不良の1枚を読んだ可能性もあります。',
    note: more,
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
function evaluateTally(falsePositive, tally) {
  if (!falsePositive || !tally || !tally.evaluated) return null;

  const n = tally.evaluated;
  const matched = tally.matched;
  const allMatched = matched === n;
  const decisive = n >= SAMPLES_FOR_DECISION;

  // 全枚数で同じ方式に当たり続けたものだけを答えとする。
  // 枚数ごとに違う方式に当たっている場合、方式は特定できていない
  let method = null;
  if (allMatched && tally.methods) {
    method = Object.keys(tally.methods).find((k) => tally.methods[k] === n) || null;
  }

  if (!allMatched) {
    return {
      n: n, matched: matched, allMatched: false, decisive: decisive,
      probability: null, presence: null, method: null,
      headline: 'チェックデジットなし',
      // 一致しない個体がある時点で、確率ではなく矛盾の問題になる。
      // 付いていれば全件一致するはずなので、割合では表さない
      sentence: n + ' 件中 ' + matched + ' 件のみ一致しました。',
    };
  }

  const probability = Math.pow(falsePositive, n);
  const presence = presenceProbability(probability);
  return {
    n: n, matched: matched, allMatched: true, decisive: decisive,
    probability: probability, presence: presence, method: method,
    headline: 'チェックデジットあり ' + formatPresence(presence),
    sentence: n + ' 件すべて' + (method ? ' ' + method + ' と' : '') + '一致しました。'
      + 'チェックデジットがある確率は ' + formatPresence(presence) + ' です。'
      + '（付いていないのに偶然こう見える確率は ' + formatProbability(probability) + '）',
  };
}

/**
 * 「チェックデジットがある確率」を求める。
 *
 * 表示したいのは「ある確率」だが、計算で直接出るのは
 * 「ない場合に偶然こう見える確率」である。前者へ変えるには、
 * 読む前の時点で有無が半々という前提を1つ置く必要がある。
 *
 *   P(あり | n枚すべて一致) = 1 / (1 + p^n)
 *
 * p は1枚あたり偶然一致する確率。前提が半々なので、
 * 客先の事情で「ほぼ付いているはず」と分かっている場合は
 * 実際の確率はこれより高くなる。控えめな見積もりになる。
 */
function presenceProbability(coincidence) {
  return 1 / (1 + coincidence);
}

/** 100% と表示すると断定に見えるため、上限は 99.9% 以上とする */
function formatPresence(p) {
  const pct = p * 100;
  if (pct >= 99.9) return '99.9 % 以上';
  return pct.toFixed(1) + ' %';
}

function formatProbability(p) {
  const pct = p * 100;
  if (pct >= 1) return pct.toFixed(1) + ' %';
  if (pct >= 0.001) return pct.toFixed(3) + ' %';
  return pct.toExponential(1) + ' %';
}

/** 画面に出す集計ブロック。判断材料が足りないときは何枚必要かを示す */
function summariseTally(code, tally) {
  const falsePositive = OPTIONAL_CD_FALSE_POSITIVE[code];
  if (!falsePositive || !tally || !tally.evaluated) return null;

  const stat = evaluateTally(falsePositive, tally);
  const n = tally.evaluated;
  const need = Math.max(0, SAMPLES_FOR_DECISION - n);

  return {
    count: n,
    matched: tally.matched,
    headline: stat.headline,
    sentence: stat.sentence,
    decisive: stat.decisive,
    hint: stat.decisive
      ? null
      : 'あと ' + need + ' 枚読むと断定できます。',
  };
}
