/**
 * analyzer.js - 読み取った文字列とシンボル種別から詳細情報を組み立てる
 *
 * 出力する解析結果オブジェクト:
 * {
 *   symbology : {...SYMBOLOGY_SPECS の1件, code, label},
 *   aliases   : string[],          // 別名・関連呼称
 *   checks    : Check[],           // チェックデジット等の検証結果
 *   structure : Field[],           // 桁の意味づけ
 *   content   : {type,label,fields}|null,  // データ内容の解釈
 *   gs1       : {elements:[...]}|null,     // GS1 AI 解析
 *   raw       : {...}              // 生データの統計
 * }
 * Check = {name, status:'ok'|'ng'|'na'|'info', value, detail, formula}
 * Field = {label, value, note}
 */

/* =================================================================== *
 * チェックデジット計算ユーティリティ
 * =================================================================== */

/**
 * GTIN 系のモジュラス10（ウェイト 3/1）。
 * 右端のデータ桁から 3,1,3,1... の重みを掛ける。
 * @param {string} payload チェックデジットを除いた数字列
 */
function mod10Gtin(payload) {
  let sum = 0;
  const terms = [];
  for (let i = payload.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
    const d = payload.charCodeAt(i) - 48;
    sum += d * w;
    terms.unshift(d + '×' + w);
  }
  const check = (10 - (sum % 10)) % 10;
  return {
    check: check,
    sum: sum,
    formula: terms.join(' + ') + ' = ' + sum + ' → (10 − ' + sum + ' mod 10) mod 10 = ' + check,
  };
}

/** Code 39 モジュラス43 チェックキャラクタ */
const CODE39_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';
function mod43Code39(payload) {
  let sum = 0;
  const terms = [];
  for (const ch of payload) {
    const v = CODE39_CHARSET.indexOf(ch);
    if (v < 0) return null;
    sum += v;
    terms.push(ch + '(' + v + ')');
  }
  const idx = sum % 43;
  return {
    check: CODE39_CHARSET[idx],
    sum: sum,
    formula: terms.join(' + ') + ' = ' + sum + ' → ' + sum + ' mod 43 = ' + idx + ' → "' + CODE39_CHARSET[idx] + '"',
  };
}

/** NW-7 (Codabar) モジュラス16 チェックキャラクタ（本体部分のみを対象にする） */
const CODABAR_CHARSET = '0123456789-$:/.+';
function mod16Codabar(payload) {
  let sum = 0;
  const terms = [];
  for (const ch of payload) {
    const v = CODABAR_CHARSET.indexOf(ch);
    if (v < 0) return null;
    sum += v;
    terms.push(ch + '(' + v + ')');
  }
  const check = (16 - (sum % 16)) % 16;
  return {
    check: CODABAR_CHARSET[check],
    sum: sum,
    formula: terms.join(' + ') + ' = ' + sum + ' → (16 − ' + sum + ' mod 16) mod 16 = ' + check + ' → "' + CODABAR_CHARSET[check] + '"',
  };
}

/** ISBN-10 のモジュラス11（重み 10..2、余り 10 は X） */
function mod11Isbn10(payload9) {
  let sum = 0;
  const terms = [];
  for (let i = 0; i < 9; i++) {
    const d = payload9.charCodeAt(i) - 48;
    const w = 10 - i;
    sum += d * w;
    terms.push(d + '×' + w);
  }
  const rem = (11 - (sum % 11)) % 11;
  return {
    check: rem === 10 ? 'X' : String(rem),
    formula: terms.join(' + ') + ' = ' + sum + ' → (11 − ' + sum + ' mod 11) mod 11 = ' + rem,
  };
}

/** ISSN のモジュラス11（重み 8..2、余り 10 は X） */
function mod11Issn(payload7) {
  let sum = 0;
  const terms = [];
  for (let i = 0; i < 7; i++) {
    const d = payload7.charCodeAt(i) - 48;
    const w = 8 - i;
    sum += d * w;
    terms.push(d + '×' + w);
  }
  const rem = (11 - (sum % 11)) % 11;
  return {
    check: rem === 10 ? 'X' : String(rem),
    formula: terms.join(' + ') + ' = ' + sum + ' → (11 − ' + sum + ' mod 11) mod 11 = ' + rem,
  };
}

/* =================================================================== *
 * UPC-E ⇔ UPC-A 変換
 * =================================================================== */

/** UPC-E（6〜8桁）を UPC-A 12桁へ展開する */
function expandUpcE(code) {
  let numberSystem = '0';
  let body;
  let check = null;

  if (code.length === 8) {
    numberSystem = code[0];
    body = code.slice(1, 7);
    check = code[7];
  } else if (code.length === 7) {
    numberSystem = code[0];
    body = code.slice(1, 7);
  } else if (code.length === 6) {
    body = code;
  } else {
    return null;
  }
  if (numberSystem !== '0' && numberSystem !== '1') return null;

  const x = body;
  const last = x[5];
  let mid;
  if (last === '0' || last === '1' || last === '2') {
    mid = x[0] + x[1] + last + '0000' + x[2] + x[3] + x[4];
  } else if (last === '3') {
    mid = x[0] + x[1] + x[2] + '00000' + x[3] + x[4];
  } else if (last === '4') {
    mid = x[0] + x[1] + x[2] + x[3] + '00000' + x[4];
  } else {
    mid = x[0] + x[1] + x[2] + x[3] + x[4] + '0000' + last;
  }
  const upcaPayload = numberSystem + mid;           // 11桁
  const cd = mod10Gtin(upcaPayload).check;
  return {
    upca: upcaPayload + cd,
    numberSystem: numberSystem,
    body: body,
    printedCheck: check,
    computedCheck: String(cd),
    rule: '末尾 ' + last + ' → ' + upcEExpansionRule(last),
  };
}

function upcEExpansionRule(last) {
  if ('012'.includes(last)) return 'X1 X2 [末尾] 0000 X3 X4 X5';
  if (last === '3') return 'X1 X2 X3 00000 X4 X5';
  if (last === '4') return 'X1 X2 X3 X4 00000 X5';
  return 'X1 X2 X3 X4 X5 0000 [末尾]';
}

/* =================================================================== *
 * GS1 アプリケーション識別子の解析
 * =================================================================== */

const GS_CHAR = String.fromCharCode(29); // FNC1 / グループセパレータ (GS, U+001D)

/**
 * GS1 要素列（AI 連結文字列）を解析する。
 * @returns {{elements:Array, trailing:string|null, ok:boolean}|null}
 */
function parseGs1(input) {
  let s = input;
  // 読取器が付ける記号系識別子を除去
  const symbologyPrefix = s.match(/^\](C1|e0|d2|Q3|J1)/);
  if (symbologyPrefix) s = s.slice(3);
  if (s.startsWith(GS_CHAR)) s = s.slice(1);
  if (!s) return null;

  const elements = [];
  let i = 0;
  let guard = 0;
  while (i < s.length && guard++ < 200) {
    if (s[i] === GS_CHAR) { i++; continue; }

    // AI は 2〜4 桁。長いものから順に一致を試す
    let ai = null;
    let def = null;
    for (const len of [4, 3, 2]) {
      const cand = s.substr(i, len);
      if (cand.length < len) continue;
      if (GS1_AI_TABLE[cand]) { ai = cand; def = GS1_AI_TABLE[cand]; break; }
      // 310n のような小数点位置付き AI
      if (len === 4 && GS1_AI_TABLE[cand.slice(0, 3)] && /^\d$/.test(cand[3])) {
        const base = GS1_AI_TABLE[cand.slice(0, 3)];
        if (base.decimal) { ai = cand; def = Object.assign({}, base, { decimalPos: Number(cand[3]) }); break; }
      }
    }
    if (!ai) {
      return { elements: elements, trailing: s.slice(i), ok: false };
    }
    i += ai.length;

    let value;
    if (def.len != null) {
      value = s.substr(i, def.len);
      i += value.length;
    } else {
      const gs = s.indexOf(GS_CHAR, i);
      value = gs === -1 ? s.slice(i) : s.slice(i, gs);
      i = gs === -1 ? s.length : gs + 1;
    }

    elements.push({
      ai: ai,
      name: def.name,
      value: value,
      decoded: decodeGs1Value(ai, def, value),
      fixed: def.len != null,
    });
  }
  return { elements: elements, trailing: null, ok: elements.length > 0 };
}

/** AI の値を人間可読な形へ */
function decodeGs1Value(ai, def, value) {
  if (def.date && /^\d{6}$/.test(value)) {
    const yy = Number(value.slice(0, 2));
    const year = yy >= 51 ? 1900 + yy : 2000 + yy;
    const mm = value.slice(2, 4);
    const dd = value.slice(4, 6);
    return year + '年' + Number(mm) + '月' + (dd === '00' ? '末日' : Number(dd) + '日');
  }
  if (def.decimalPos != null && /^\d+$/.test(value)) {
    const p = def.decimalPos;
    if (p === 0) return value.replace(/^0+(?=\d)/, '');
    const intPart = value.slice(0, value.length - p).replace(/^0+(?=\d)/, '') || '0';
    return intPart + '.' + value.slice(value.length - p);
  }
  if ((ai === '01' || ai === '02') && /^\d{14}$/.test(value)) {
    const res = mod10Gtin(value.slice(0, 13));
    return 'GTIN-14 / CD ' + (String(res.check) === value[13] ? '一致' : '不一致 (正: ' + res.check + ')');
  }
  if (ai === '00' && /^\d{18}$/.test(value)) {
    const res = mod10Gtin(value.slice(0, 17));
    return 'SSCC / CD ' + (String(res.check) === value[17] ? '一致' : '不一致 (正: ' + res.check + ')');
  }
  return null;
}

/* =================================================================== *
 * データ内容（2次元コード等のペイロード）の解釈
 * =================================================================== */

function analyzeContent(text) {
  const t = text.trim();

  if (/^https?:\/\//i.test(t)) {
    const fields = [];
    let dl = null;
    try {
      const u = new URL(t);
      fields.push({ label: 'スキーム', value: u.protocol.replace(':', ''), note: u.protocol === 'http:' ? '暗号化なし' : 'TLS 暗号化' });
      fields.push({ label: 'ホスト', value: u.hostname, note: null });
      if (u.port) fields.push({ label: 'ポート', value: u.port, note: null });
      fields.push({ label: 'パス', value: u.pathname || '/', note: null });
      if (u.search) fields.push({ label: 'クエリ', value: u.search.slice(1), note: null });
      if (u.hash) fields.push({ label: 'フラグメント', value: u.hash.slice(1), note: null });
      dl = u.pathname.match(/\/(01|8006|414|417|00|253|255|8004|8010|8013)\/(\d+)/);
    } catch (e) { /* URL として解釈できない場合は無視 */ }
    return {
      type: 'url',
      label: dl ? 'URL (GS1 デジタルリンクの可能性)' : 'URL',
      description: dl
        ? 'GS1 デジタルリンク構文（/AI/値）を含みます。商品識別子を URL に埋め込む形式です。'
        : 'Web ページへのリンクです。開く前に遷移先ドメインを確認してください。',
      fields: fields,
    };
  }

  if (/^mailto:/i.test(t)) {
    const m = t.slice(7).split('?');
    return { type: 'mailto', label: 'メールアドレス', description: 'メール作成を起動します。', fields: [{ label: '宛先', value: decodeURIComponent(m[0]), note: null }] };
  }
  if (/^tel:/i.test(t)) {
    return { type: 'tel', label: '電話番号', description: '発信を起動します。', fields: [{ label: '番号', value: t.slice(4), note: null }] };
  }
  if (/^smsto:/i.test(t) || /^sms:/i.test(t)) {
    const body = t.replace(/^sms(to)?:/i, '').split(':');
    return { type: 'sms', label: 'SMS', description: 'ショートメッセージの宛先と本文です。', fields: [{ label: '宛先', value: body[0], note: null }, { label: '本文', value: body.slice(1).join(':'), note: null }] };
  }
  if (/^geo:/i.test(t)) {
    const p = t.slice(4).split(',');
    return { type: 'geo', label: '位置情報', description: '緯度経度を示します。', fields: [{ label: '緯度', value: p[0], note: null }, { label: '経度', value: p[1] || '', note: null }] };
  }
  if (/^WIFI:/i.test(t)) {
    const get = (k) => { const m = t.match(new RegExp(k + ':((?:\\\\.|[^;])*);')); return m ? m[1].replace(/\\(.)/g, '$1') : null; };
    const auth = get('T');
    return {
      type: 'wifi',
      label: 'Wi-Fi 接続設定',
      description: 'Wi-Fi ネットワークへの接続情報です。パスワードが平文で含まれます。',
      fields: [
        { label: 'SSID', value: get('S') || '', note: null },
        { label: '暗号化方式', value: auth || 'なし', note: auth === 'nopass' ? '暗号化なし' : null },
        { label: 'パスワード', value: get('P') || '(なし)', note: null },
        { label: 'ステルス', value: get('H') === 'true' ? 'はい' : 'いいえ', note: null },
      ],
    };
  }
  if (/^MECARD:/i.test(t)) {
    const fields = [];
    const map = { N: '氏名', TEL: '電話', EMAIL: 'メール', ADR: '住所', ORG: '組織', URL: 'URL', NOTE: 'メモ', BDAY: '生年月日' };
    for (const part of t.slice(7).split(';')) {
      const idx = part.indexOf(':');
      if (idx < 0) continue;
      const k = part.slice(0, idx);
      if (map[k]) fields.push({ label: map[k], value: part.slice(idx + 1), note: null });
    }
    return { type: 'mecard', label: 'MECARD (連絡先)', description: '日本の携帯電話で広く使われる連絡先フォーマットです。', fields: fields };
  }
  if (/^BEGIN:VCARD/i.test(t)) {
    const fields = [];
    for (const line of t.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const k = line.slice(0, idx).split(';')[0].toUpperCase();
      if (['FN', 'N', 'TEL', 'EMAIL', 'ORG', 'TITLE', 'ADR', 'URL'].includes(k)) {
        fields.push({ label: k, value: line.slice(idx + 1), note: null });
      }
    }
    return { type: 'vcard', label: 'vCard (連絡先)', description: '標準的な電子名刺フォーマットです。', fields: fields };
  }
  if (/^BEGIN:VEVENT/i.test(t) || /^BEGIN:VCALENDAR/i.test(t)) {
    return { type: 'vevent', label: 'iCalendar (予定)', description: 'カレンダー登録用の予定情報です。', fields: [] };
  }
  if (/^otpauth:\/\//i.test(t)) {
    return { type: 'otp', label: 'ワンタイムパスワード設定', description: '二段階認証の秘密鍵を含みます。他人に見せないでください。', fields: [] };
  }
  if (/^bitcoin:|^ethereum:/i.test(t)) {
    return { type: 'crypto', label: '暗号資産の送金先', description: '送金先アドレスです。内容を必ず確認してください。', fields: [] };
  }
  if (/^BEGIN:/i.test(t)) {
    return { type: 'structured', label: '構造化テキスト', description: null, fields: [] };
  }
  if (/^\d+$/.test(t)) {
    return { type: 'numeric', label: '数字のみ', description: t.length + ' 桁の数字列です。', fields: [] };
  }
  return { type: 'text', label: 'プレーンテキスト', description: null, fields: [] };
}

/* =================================================================== *
 * 生データの統計
 * =================================================================== */

function analyzeRaw(text, rawBytes) {
  let digits = 0, upper = 0, lower = 0, symbol = 0, control = 0, nonAscii = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c >= 48 && c <= 57) digits++;
    else if (c >= 65 && c <= 90) upper++;
    else if (c >= 97 && c <= 122) lower++;
    else if (c < 32 || c === 127) control++;
    else if (c < 128) symbol++;
    else nonAscii++;
  }
  const utf8 = new TextEncoder().encode(text);
  return {
    text: text,
    length: [...text].length,
    digits: digits,
    upper: upper,
    lower: lower,
    symbol: symbol,
    control: control,
    nonAscii: nonAscii,
    utf8Bytes: utf8.length,
    hex: Array.from(utf8).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
    symbolBytes: rawBytes ? rawBytes.length : null,
  };
}

/* =================================================================== *
 * メイン解析
 * =================================================================== */

/**
 * @param {string} formatCode  'EAN_13' など ZXing の BarcodeFormat 名
 * @param {string} text        デコード結果
 * @param {object} meta        {errorCorrectionLevel, symbologyIdentifier, orientation, ...}
 * @param {Uint8Array|null} rawBytes
 */
function analyzeBarcode(formatCode, text, meta, rawBytes) {
  meta = meta || {};
  const spec = SYMBOLOGY_SPECS[formatCode] || {
    label: formatCode, kind: '不明', standard: '-', charset: '-', length: '-',
    checkDigit: '不明', note: '',
  };

  const result = {
    symbology: Object.assign({ code: formatCode }, spec),
    aliases: [],
    checks: [],
    structure: [],
    content: null,
    gs1: null,
    raw: analyzeRaw(text, rawBytes),
    notes: [],
  };

  const digitsOnly = /^\d+$/.test(text);

  switch (formatCode) {
    case 'EAN_13': analyzeEan13(text, result); break;
    case 'EAN_8': analyzeEan8(text, result); break;
    case 'UPC_A': analyzeUpcA(text, result); break;
    case 'UPC_E': analyzeUpcE(text, result); break;
    case 'ITF': analyzeItf(text, result); break;
    case 'CODE_39': analyzeCode39(text, result); break;
    case 'CODE_93': analyzeCode93(text, result); break;
    case 'CODE_128': analyzeCode128(text, result, meta); break;
    case 'CODABAR': analyzeCodabar(text, result); break;
    case 'RSS_14':
    case 'RSS_EXPANDED': analyzeDataBar(text, result); break;
    case 'QR_CODE': analyzeQr(text, result, meta); break;
    case 'DATA_MATRIX':
    case 'AZTEC':
    case 'PDF_417':
    case 'MAXICODE': analyze2d(text, result, meta); break;
    default:
      result.checks.push({
        name: 'チェックデジット', status: 'na', value: '-',
        detail: 'このシンボルの検証ロジックは未実装です。', formula: null,
      });
  }

  // 内容解釈。数字だけの商品コード系は「データの意味」で説明済みなので省く
  const NUMERIC_1D = ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'ITF', 'RSS_14'];
  if (!result.content) {
    const content = analyzeContent(text);
    if (!(content.type === 'numeric' && NUMERIC_1D.includes(formatCode))) {
      result.content = content;
    }
  }

  // GS1 構文が見えるものは AI 解析も試みる
  if (!result.gs1 && ['CODE_128', 'DATA_MATRIX', 'QR_CODE', 'RSS_EXPANDED', 'RSS_14'].includes(formatCode)) {
    const parsed = parseGs1(text);
    if (parsed && parsed.ok && parsed.elements.length > 0 && !parsed.trailing) {
      result.gs1 = parsed;
    }
  }

  if (digitsOnly && text.length >= 6) addGenericMod10Note(text, result);
  classifyChecks(result);
  return result;
}

/**
 * 各検証項目に種別を付ける。見出しのバッジはこの種別で決まる。
 *   cd       … そのシンボル固有のチェックデジット／チェックキャラクタ
 *   embedded … シンボル内部にあり読取器が検証済みのもの
 *   ec       … 誤り訂正（チェックデジットではない）
 *   self     … 構造上の自己チェック機能
 *   syntax   … データ構文の妥当性（GS1 AI など）
 *   length   … 桁数や展開規則の妥当性
 */
function classifyChecks(result) {
  for (const c of result.checks) {
    if (/誤り訂正/.test(c.name)) c.kind = 'ec';
    else if (/構文/.test(c.name)) c.kind = 'syntax';
    else if (/自己チェック/.test(c.name)) c.kind = 'self';
    else if (/読取器が検証済み/.test(String(c.value))) c.kind = 'embedded';
    else if (/チェックデジット|チェックキャラクタ/.test(c.name)) c.kind = 'cd';
    else if (/桁数|展開/.test(c.name)) c.kind = 'length';
    else c.kind = 'other';
  }
}

/** GTIN 系以外の数字列にも、参考としてモジュラス10の結果を添える */
function addGenericMod10Note(text, result) {
  const hasCd = result.checks.some((c) => c.status === 'ok' || c.status === 'ng');
  if (hasCd) return;
  const res = mod10Gtin(text.slice(0, -1));
  result.checks.push({
    name: '参考: 末尾桁をモジュラス10 CD とみなした場合',
    status: String(res.check) === text[text.length - 1] ? 'info-ok' : 'info',
    value: String(res.check),
    detail: String(res.check) === text[text.length - 1]
      ? '末尾桁がモジュラス10(3/1)の計算結果と一致します。チェックデジット付きの運用である可能性があります。'
      : '末尾桁は モジュラス10(3/1) と一致しません。CD なし、または別の計算方式です。',
    formula: res.formula,
  });
}

/* ----------------------------- EAN-13 ----------------------------- */
function analyzeEan13(text, r) {
  r.aliases.push('JAN-13', 'JAN 標準タイプ', 'GTIN-13', 'EAN/UCC-13');

  if (!/^\d{13}$/.test(text)) {
    r.checks.push({ name: '桁数', status: 'ng', value: text.length + '桁', detail: 'EAN-13 は 13 桁である必要があります。', formula: null });
    return;
  }
  const payload = text.slice(0, 12);
  const printed = text[12];
  const res = mod10Gtin(payload);
  r.checks.push({
    name: 'チェックデジット (モジュラス10 ウェイト3/1)',
    status: String(res.check) === printed ? 'ok' : 'ng',
    value: printed,
    detail: String(res.check) === printed
      ? '13桁目のチェックデジットは正しい値です。'
      : '不一致です。正しい値は ' + res.check + ' です。読み取り誤りかコード自体の誤りが疑われます。',
    formula: res.formula,
  });

  const prefix = text.slice(0, 3);
  const info = lookupGs1Prefix(prefix);
  r.structure.push({
    label: 'GS1 プレフィックス (1-3桁)',
    value: prefix,
    note: info ? info.name + '  [範囲 ' + info.range + ']' : '未割当または不明',
  });

  // 特殊プレフィックス
  if (prefix === '978' || prefix === '979') {
    analyzeIsbn13(text, r);
  } else if (prefix === '977') {
    analyzeIssn13(text, r);
  } else if (prefix === '192') {
    r.structure.push({ label: '用途', value: '日本図書コード 2段目', note: '書籍バーコード下段。分類コードと価格を表す。' });
    analyzeJapanBookSecond(text, r);
  } else if (/^(0[2]|2[0-9])/.test(text.slice(0, 2))) {
    r.structure.push({ label: '用途', value: 'インストアコード', note: '店舗内限定。量り売り商品の価格や重量を埋め込む運用が多い。' });
    r.structure.push({ label: '商品コード部 (3-7桁)', value: text.slice(2, 7), note: '店舗が自由に割り当てる部分' });
    r.structure.push({ label: '価格／重量部 (8-12桁)', value: text.slice(7, 12), note: '運用により価格・重量・数量のいずれか' });
  } else {
    // 通常の商品コード。JAN は 9桁型と7桁型がある
    r.structure.push({ label: 'メーカーコード (9桁型)', value: text.slice(0, 9), note: '2001年以降に新規登録された事業者に多い形式' });
    r.structure.push({ label: '商品アイテムコード (9桁型)', value: text.slice(9, 12), note: '000〜999 の 1000 通り' });
    r.structure.push({ label: 'メーカーコード (7桁型)', value: text.slice(0, 7), note: '従来から使われている形式' });
    r.structure.push({ label: '商品アイテムコード (7桁型)', value: text.slice(7, 12), note: '00000〜99999 の 10万通り' });
    r.notes.push('メーカーコードが 7 桁か 9 桁かはバーコードだけでは判別できません。GS1 Japan の事業者情報で確認が必要です。');
  }
  r.structure.push({ label: 'チェックデジット (13桁目)', value: text[12], note: 'モジュラス10 ウェイト3/1' });

  r.structure.push({ label: 'GTIN-14 表記', value: '0' + text, note: '集合包装用コードとして扱う場合の 14 桁表現' });
}

function analyzeIsbn13(text, r) {
  const isIsmn = text.startsWith('9790');
  r.structure.push({
    label: '用途',
    value: isIsmn ? 'ISMN (楽譜)' : 'ISBN (書籍)',
    note: isIsmn ? '979-0 は国際標準楽譜番号に割り当てられている' : 'Bookland。書籍の国際標準図書番号',
  });
  r.content = {
    type: 'isbn',
    label: isIsmn ? 'ISMN-13' : 'ISBN-13',
    description: isIsmn ? '楽譜の国際標準番号です。' : '書籍の国際標準図書番号です。',
    fields: [{ label: 'ISBN-13 (ハイフン付き概略)', value: text.slice(0, 3) + '-' + text.slice(3, 4) + '-' + text.slice(4, 8) + '-' + text.slice(8, 12) + '-' + text[12], note: 'ハイフン位置は出版者記号の桁数で変わるため参考値' }],
  };

  if (text.startsWith('978')) {
    const core9 = text.slice(3, 12);
    const isbn10 = core9 + mod11Isbn10(core9).check;
    const calc = mod11Isbn10(core9);
    r.structure.push({ label: '旧 ISBN-10 表記', value: isbn10, note: 'モジュラス11 で再計算した値' });
    r.checks.push({
      name: 'ISBN-10 チェックデジット (モジュラス11)',
      status: 'info-ok',
      value: calc.check,
      detail: 'ISBN-13 から換算した 10 桁表記の検査数字です。',
      formula: calc.formula,
    });
  }
  if (text.startsWith('9784')) {
    r.structure.push({ label: '国・言語圏記号', value: '4', note: '日本（日本語出版物）' });
  }
}

function analyzeIssn13(text, r) {
  r.structure.push({ label: '用途', value: 'ISSN (定期刊行物)', note: '雑誌・逐次刊行物の国際標準逐次刊行物番号' });
  const issn7 = text.slice(3, 10);
  const calc = mod11Issn(issn7);
  const issn = issn7.slice(0, 4) + '-' + issn7.slice(4) + calc.check;
  r.structure.push({ label: 'ISSN 表記', value: issn, note: 'モジュラス11 で検査数字を再計算した値' });
  r.structure.push({ label: '号数バリアント (11-12桁)', value: text.slice(10, 12), note: '雑誌の号や版を表す付加コード' });
  r.checks.push({
    name: 'ISSN チェックデジット (モジュラス11)',
    status: 'info-ok',
    value: calc.check,
    detail: 'ISSN 8 桁表記の検査数字です。',
    formula: calc.formula,
  });
}

function analyzeJapanBookSecond(text, r) {
  const cCode = text.slice(3, 7);
  const price = text.slice(7, 12);
  const target = { '0': '一般', '1': '教養', '2': '実用', '3': '専門', '4': '検定教科書等', '5': '婦人', '6': '学参I(小中)', '7': '学参II(高校)', '8': '児童', '9': '雑誌扱い' };
  const form = { '0': '単行本', '1': '文庫', '2': '新書', '3': '全集・双書', '4': 'ムック等', '5': '事典・辞典', '6': '図鑑', '7': '絵本', '9': 'コミック' };
  r.structure.push({ label: 'C コード (分類)', value: cCode, note: '販売対象=' + (target[cCode[0]] || '?') + ' / 発行形態=' + (form[cCode[1]] || '?') + ' / 内容=' + cCode.slice(2) });
  r.structure.push({ label: '本体価格', value: String(Number(price)) + ' 円', note: '税抜価格' });
}

/* ------------------------------ EAN-8 ----------------------------- */
function analyzeEan8(text, r) {
  r.aliases.push('JAN-8', 'JAN 短縮タイプ', 'GTIN-8');
  if (!/^\d{8}$/.test(text)) {
    r.checks.push({ name: '桁数', status: 'ng', value: text.length + '桁', detail: 'EAN-8 は 8 桁である必要があります。', formula: null });
    return;
  }
  const res = mod10Gtin(text.slice(0, 7));
  r.checks.push({
    name: 'チェックデジット (モジュラス10 ウェイト3/1)',
    status: String(res.check) === text[7] ? 'ok' : 'ng',
    value: text[7],
    detail: String(res.check) === text[7] ? '8桁目のチェックデジットは正しい値です。' : '不一致です。正しい値は ' + res.check + ' です。',
    formula: res.formula,
  });
  const info = lookupGs1Prefix(text.slice(0, 3));
  r.structure.push({ label: 'GS1 プレフィックス (1-3桁)', value: text.slice(0, 3), note: info ? info.name : '未割当または不明' });
  r.structure.push({ label: '商品コード (4-7桁)', value: text.slice(3, 7), note: 'EAN-8 は事業者ごとではなく個々の商品に直接割り当てられる' });
  r.structure.push({ label: 'チェックデジット (8桁目)', value: text[7], note: 'モジュラス10 ウェイト3/1' });
  r.structure.push({ label: 'GTIN-14 表記', value: '000000' + text, note: '14 桁へゼロ詰めした表現' });
}

/* ------------------------------ UPC-A ----------------------------- */
function analyzeUpcA(text, r) {
  r.aliases.push('GTIN-12', 'UCC-12');
  if (!/^\d{12}$/.test(text)) {
    r.checks.push({ name: '桁数', status: 'ng', value: text.length + '桁', detail: 'UPC-A は 12 桁である必要があります。', formula: null });
    return;
  }
  const res = mod10Gtin(text.slice(0, 11));
  r.checks.push({
    name: 'チェックデジット (モジュラス10 ウェイト3/1)',
    status: String(res.check) === text[11] ? 'ok' : 'ng',
    value: text[11],
    detail: String(res.check) === text[11] ? '12桁目のチェックデジットは正しい値です。' : '不一致です。正しい値は ' + res.check + ' です。',
    formula: res.formula,
  });
  const ns = text[0];
  const nsMap = {
    '0': '一般商品', '1': '一般商品', '2': '量り売り商品（店舗内）', '3': '医薬品 (NDC)',
    '4': '店舗内利用', '5': 'クーポン', '6': '一般商品', '7': '一般商品', '8': '一般商品', '9': 'クーポン',
  };
  r.structure.push({ label: 'ナンバーシステム (1桁目)', value: ns, note: nsMap[ns] || '不明' });
  r.structure.push({ label: 'メーカーコード (2-6桁)', value: text.slice(1, 6), note: null });
  r.structure.push({ label: '商品コード (7-11桁)', value: text.slice(6, 11), note: null });
  r.structure.push({ label: 'チェックデジット (12桁目)', value: text[11], note: 'モジュラス10 ウェイト3/1' });
  r.structure.push({ label: 'EAN-13 等価表現', value: '0' + text, note: '先頭に 0 を付けると EAN-13 と同一' });
}

/* ------------------------------ UPC-E ----------------------------- */
function analyzeUpcE(text, r) {
  r.aliases.push('UPC-E0 / UPC-E1', 'ゼロサプレス UPC');
  const exp = expandUpcE(text);
  if (!exp) {
    r.checks.push({ name: '展開', status: 'ng', value: text, detail: 'UPC-A への展開規則に当てはまりません。', formula: null });
    return;
  }
  const printed = exp.printedCheck;
  if (printed != null) {
    r.checks.push({
      name: 'チェックデジット (展開後の UPC-A から算出)',
      status: printed === exp.computedCheck ? 'ok' : 'ng',
      value: printed,
      detail: printed === exp.computedCheck
        ? 'UPC-A へ展開した 12 桁から計算した検査数字と一致します。'
        : '不一致です。正しい値は ' + exp.computedCheck + ' です。',
      formula: mod10Gtin(exp.upca.slice(0, 11)).formula,
    });
  } else {
    r.checks.push({ name: 'チェックデジット', status: 'na', value: '-', detail: '読み取り結果に検査数字が含まれていません。', formula: null });
  }
  r.structure.push({ label: 'ナンバーシステム', value: exp.numberSystem, note: exp.numberSystem === '0' ? 'UPC-E0' : 'UPC-E1' });
  r.structure.push({ label: '短縮本体', value: exp.body, note: exp.rule });
  r.structure.push({ label: 'UPC-A 展開結果', value: exp.upca, note: '本来の 12 桁コード' });
  r.structure.push({ label: 'EAN-13 等価表現', value: '0' + exp.upca, note: null });
}

/* -------------------------------- ITF ----------------------------- */
function analyzeItf(text, r) {
  const len = text.length;
  r.aliases.push('Interleaved 2 of 5', 'I2/5');
  if (len === 14) r.aliases.push('ITF-14 / 集合包装用商品コード');

  r.structure.push({ label: '桁数', value: len + '桁', note: len % 2 === 0 ? '偶数桁（ITF の要件を満たす）' : '奇数桁（通常は先頭に 0 を補って符号化される）' });

  if (len === 14 || len === 16 || len === 12 || len === 8) {
    const res = mod10Gtin(text.slice(0, -1));
    const ok = String(res.check) === text[len - 1];
    r.checks.push({
      name: 'チェックデジット (モジュラス10 ウェイト3/1)',
      status: len === 14 ? (ok ? 'ok' : 'ng') : (ok ? 'info-ok' : 'info'),
      value: text[len - 1],
      detail: len === 14
        ? (ok ? 'ITF-14 の検査数字は正しい値です。' : '不一致です。正しい値は ' + res.check + ' です。')
        : (ok ? '末尾桁がモジュラス10 と一致します。CD 付き運用と考えられます。' : 'ITF では検査数字は任意です。末尾桁は CD ではない可能性があります。'),
      formula: res.formula,
    });
  } else {
    r.checks.push({
      name: 'チェックデジット',
      status: 'unknown', value: '判定不能',
      detail: 'ITF の検査数字は任意です。この桁数からは CD の有無を確定できません。運用元の仕様を確認してください。',
      formula: null,
    });
  }

  if (len === 14) {
    const ind = text[0];
    const indMap = { '0': '単品（またはインジケータ未使用）', '9': '可変数量商品' };
    r.structure.push({ label: 'インジケータ (1桁目)', value: ind, note: indMap[ind] || '梱包内の入数レベル 1〜8' });
    const info = lookupGs1Prefix(text.slice(1, 4));
    r.structure.push({ label: 'GS1 プレフィックス (2-4桁)', value: text.slice(1, 4), note: info ? info.name : '未割当または不明' });
    r.structure.push({ label: '事業者・商品コード (5-13桁)', value: text.slice(4, 13), note: null });
    r.structure.push({ label: 'チェックデジット (14桁目)', value: text[13], note: 'モジュラス10 ウェイト3/1' });
    r.structure.push({ label: '内包する GTIN-13', value: text.slice(1, 14), note: '先頭インジケータを除いた 13 桁（CD は本来別計算）' });
  }
}

/* ----------------------------- Code 39 ---------------------------- */
function analyzeCode39(text, r) {
  r.aliases.push('3 of 9 Barcode', 'USD-3', 'LOGMARS');
  const body = text.slice(0, -1);
  const last = text[text.length - 1];
  const calc = text.length >= 2 ? mod43Code39(body) : null;

  if (calc && calc.check === last) {
    r.checks.push({
      name: 'チェックキャラクタ (モジュラス43)',
      status: 'info-ok',
      value: last,
      detail: '末尾文字がモジュラス43 の計算結果と一致します。チェックキャラクタ付きの運用と考えられます。ただし Code 39 では任意仕様のため、偶然一致することもあります。',
      formula: calc.formula,
    });
  } else {
    r.checks.push({
      name: 'チェックキャラクタ (モジュラス43)',
      status: 'na',
      value: 'なし',
      detail: 'Code 39 のチェックキャラクタは任意仕様です。末尾文字は計算値' + (calc ? ' "' + calc.check + '" ' : '') + 'と一致しないため、付与されていないと判断されます。',
      formula: calc ? calc.formula : null,
    });
  }
  r.checks.push({
    name: '自己チェック機能',
    status: 'info-ok',
    value: 'あり',
    detail: '1文字ごとに太バー3本という構造制約があるため、1文字単位の誤読は構造的に検出されます。',
    formula: null,
  });

  const invalid = [...text].filter((c) => !CODE39_CHARSET.includes(c));
  r.structure.push({ label: '文字数', value: text.length + '文字', note: 'スタート／ストップの * は含まない' });
  if (invalid.length) {
    r.structure.push({ label: '標準文字集合外', value: invalid.join(' '), note: 'フルASCII Code 39（拡張モード）の可能性があります' });
  }
}

/* ----------------------------- Code 93 ---------------------------- */
function analyzeCode93(text, r) {
  r.aliases.push('USS-93');
  r.checks.push({
    name: 'チェックキャラクタ C / K (モジュラス47)',
    status: 'info-ok',
    value: '2文字（読取器が検証済み・出力からは除去）',
    detail: 'Code 93 は 2 文字の検査キャラクタが必須です。読取器がデコード時に検証し、正しい場合のみ結果を返すため、表示中のデータには含まれていません。',
    formula: null,
  });
  r.structure.push({ label: '文字数', value: text.length + '文字', note: '検査キャラクタ 2 文字を除いたデータ長' });
}

/* ---------------------------- Code 128 ---------------------------- */
function analyzeCode128(text, r, meta) {
  r.aliases.push('USS-128', 'UCC/EAN-128 (GS1-128)');

  r.checks.push({
    name: 'チェックキャラクタ (モジュラス103)',
    status: 'info-ok',
    value: '1文字（読取器が検証済み・出力からは除去）',
    detail: 'Code 128 はシンボル内に必須のチェックキャラクタを持ちます。読取器が検証し、一致した場合のみデータを返すため、表示中の文字列には含まれていません。',
    formula: null,
  });

  const sym = meta.symbologyIdentifier;
  const hasGs = text.includes(GS_CHAR);
  const parsed = parseGs1(text);
  const isGs1 = sym === ']C1' || hasGs || (parsed && parsed.ok && !parsed.trailing && /^(00|01|02|10|11|17|21|30|37|41)/.test(text));

  if (isGs1) {
    r.symbology.label = 'GS1-128 (Code 128 / FNC1 付き)';
    r.aliases.push('EAN-128');
    r.structure.push({ label: 'GS1 適用', value: 'GS1-128', note: '先頭 FNC1 により GS1 アプリケーション識別子構文で解釈される' });
    if (parsed && parsed.ok) r.gs1 = parsed;
    r.checks.push({
      name: 'GS1 AI 構文',
      status: parsed && parsed.ok && !parsed.trailing ? 'ok' : 'ng',
      value: parsed && parsed.elements ? parsed.elements.length + ' 要素' : '-',
      detail: parsed && parsed.trailing
        ? '未知の AI または区切り不足のため "' + parsed.trailing + '" 以降を解釈できませんでした。'
        : 'アプリケーション識別子として矛盾なく分解できました。',
      formula: null,
    });
  } else {
    r.structure.push({ label: 'GS1 適用', value: '非 GS1（自由フォーマット）', note: '先頭 FNC1 が検出されないため、独自運用の Code 128 と判断' });
  }

  const digits = [...text].filter((c) => /\d/.test(c)).length;
  r.structure.push({
    label: '推定コードセット',
    value: digits === text.length && text.length % 2 === 0 ? 'C 主体（数字高密度）' : /[a-z]/.test(text) ? 'B 主体（小文字を含む）' : 'A または B',
    note: '実際の切替はシンボル内部の制御文字によるため推定値',
  });
  r.structure.push({ label: 'データ長', value: text.length + '文字', note: null });
}

/* ------------------------- NW-7 (Codabar) ------------------------- */
function analyzeCodabar(text, r) {
  r.aliases.push('Codabar', 'USD-4', 'Monarch', 'Code 2 of 7');
  let body = text;
  let start = null, stop = null;
  if (/^[A-Da-d]/.test(text) && /[A-Da-d]$/.test(text) && text.length >= 2) {
    start = text[0].toUpperCase();
    stop = text[text.length - 1].toUpperCase();
    body = text.slice(1, -1);
    r.structure.push({ label: 'スタート／ストップ文字', value: start + ' … ' + stop, note: 'A-D の組み合わせで運用区分を表すことがある' });
  } else {
    r.structure.push({ label: 'スタート／ストップ文字', value: '出力に含まれない', note: '読取器の設定によっては除去されて出力される' });
  }

  const calc = body.length >= 2 ? mod16Codabar(body.slice(0, -1)) : null;
  if (calc && calc.check === body[body.length - 1]) {
    r.checks.push({
      name: 'チェックキャラクタ (モジュラス16)',
      status: 'info-ok',
      value: body[body.length - 1],
      detail: '末尾文字がモジュラス16 の計算結果と一致します。チェックキャラクタ付きの可能性があります。',
      formula: calc.formula,
    });
  } else {
    r.checks.push({
      name: 'チェックキャラクタ',
      status: 'na',
      value: 'なし（または別方式）',
      detail: 'NW-7 の検査数字は規格上任意で、モジュラス16 のほかモジュラス11 など業界ごとの方式があります。末尾文字はモジュラス16 の計算値と一致しませんでした。',
      formula: calc ? calc.formula : null,
    });
  }
  r.structure.push({ label: 'データ長', value: body.length + '文字', note: 'スタート／ストップを除く' });
  if (/^\d{12}$/.test(body)) {
    r.structure.push({ label: '推定用途', value: '宅配便の送り状番号など', note: '12 桁数字は国内の運送業者で多く使われる形式' });
  }
}

/* -------------------------- GS1 DataBar ---------------------------- */
function analyzeDataBar(text, r) {
  r.aliases.push('RSS (Reduced Space Symbology)');
  const parsed = parseGs1(text);
  if (parsed && parsed.ok) {
    r.gs1 = parsed;
    const gtin = parsed.elements.find((e) => e.ai === '01');
    if (gtin && /^\d{14}$/.test(gtin.value)) {
      const res = mod10Gtin(gtin.value.slice(0, 13));
      r.checks.push({
        name: 'GTIN チェックデジット (モジュラス10 ウェイト3/1)',
        status: String(res.check) === gtin.value[13] ? 'ok' : 'ng',
        value: gtin.value[13],
        detail: String(res.check) === gtin.value[13] ? '内包する GTIN-14 の検査数字は正しい値です。' : '不一致です。正しい値は ' + res.check + ' です。',
        formula: res.formula,
      });
    }
  } else if (/^\d{14}$/.test(text)) {
    const res = mod10Gtin(text.slice(0, 13));
    r.checks.push({
      name: 'GTIN チェックデジット (モジュラス10 ウェイト3/1)',
      status: String(res.check) === text[13] ? 'ok' : 'ng',
      value: text[13],
      detail: String(res.check) === text[13] ? 'GTIN-14 の検査数字は正しい値です。' : '不一致です。正しい値は ' + res.check + ' です。',
      formula: res.formula,
    });
  }
  r.checks.push({
    name: 'シンボル内部チェック文字',
    status: 'info-ok',
    value: 'あり（読取器が検証済み）',
    detail: 'GS1 DataBar は内部にチェック文字を持ち、読取器が検証したうえでデータを返します。',
    formula: null,
  });
}

/* ------------------------------ QR -------------------------------- */
const QR_EC_INFO = {
  L: { name: 'L (低)', recover: '約 7%' },
  M: { name: 'M (標準)', recover: '約 15%' },
  Q: { name: 'Q (高品位)', recover: '約 25%' },
  H: { name: 'H (最高)', recover: '約 30%' },
};

function analyzeQr(text, r, meta) {
  r.aliases.push('JIS X 0510', 'Quick Response Code');

  const ec = meta.errorCorrectionLevel ? String(meta.errorCorrectionLevel).charAt(0).toUpperCase() : null;
  if (ec && QR_EC_INFO[ec]) {
    r.checks.push({
      name: '誤り訂正レベル (リード・ソロモン)',
      status: 'info-ok',
      value: QR_EC_INFO[ec].name,
      detail: 'QR コードにチェックデジットはありません。代わりに符号語の ' + QR_EC_INFO[ec].recover + ' が欠損・汚損しても復元できるリード・ソロモン誤り訂正が働きます。',
      formula: null,
    });
  } else {
    r.checks.push({
      name: '誤り訂正 (リード・ソロモン)',
      status: 'info-ok',
      value: 'あり（レベル不明）',
      detail: 'QR コードにチェックデジットはありません。リード・ソロモン符号による誤り訂正で読取の正しさが保証されます。',
      formula: null,
    });
  }

  if (meta.symbologyIdentifier) {
    const si = meta.symbologyIdentifier;
    const siMap = { ']Q0': 'モデル1', ']Q1': 'モデル2 / ECI なし', ']Q2': 'モデル2 / ECI あり', ']Q3': 'GS1 QR コード (FNC1 先頭)', ']Q4': 'AIM 業界仕様', ']Q5': 'AIM 業界仕様 / ECI', ']Q6': '構造的連接' };
    r.structure.push({ label: '記号系識別子', value: si, note: siMap[si] || null });
    if (si === ']Q3') {
      r.symbology.label = 'GS1 QR コード';
      const parsed = parseGs1(text);
      if (parsed && parsed.ok) r.gs1 = parsed;
    }
  }
  if (meta.structuredAppendSequence != null) {
    r.structure.push({ label: '構造的連接', value: '面 ' + meta.structuredAppendSequence, note: '複数シンボルに分割されたデータの一部です' });
  }
  if (meta.byteSegmentCount) {
    r.structure.push({ label: 'バイトセグメント数', value: String(meta.byteSegmentCount), note: '8ビットバイトモードで符号化された区間の数' });
  }

  const mode = estimateQrMode(text);
  r.structure.push({ label: '推定符号化モード', value: mode.label, note: mode.note });
  r.structure.push({ label: 'データ長', value: r.raw.length + ' 文字 / UTF-8 ' + r.raw.utf8Bytes + ' バイト', note: null });
}

function estimateQrMode(text) {
  if (/^\d+$/.test(text)) return { label: '数字モード', note: '3桁を10ビットで符号化する最も高密度なモード' };
  if (/^[0-9A-Z $%*+\-./:]+$/.test(text)) return { label: '英数字モード', note: '2文字を11ビットで符号化する' };
  if ([...text].every((c) => c.codePointAt(0) < 128)) return { label: '8ビットバイトモード (ASCII)', note: '1文字1バイト' };
  return { label: '8ビットバイトモード または 漢字モード', note: '日本語を含むため Shift_JIS 漢字モードか UTF-8 バイトモード' };
}

/* ----------------------- その他 2 次元コード ------------------------ */
function analyze2d(text, r, meta) {
  const ecMap = {
    DATA_MATRIX: 'ECC200 のリード・ソロモン誤り訂正が常に有効です。チェックデジットという概念はありません。',
    AZTEC: 'リード・ソロモン誤り訂正を持ち、割合はシンボル生成時に 5〜95% で指定されます。',
    PDF_417: 'リード・ソロモン誤り訂正レベル 0〜8（訂正語 2〜512 個）を持ちます。',
    MAXICODE: 'リード・ソロモン誤り訂正を持ち、中央部の重要データはより強く保護されます。',
  };
  r.checks.push({
    name: '誤り訂正',
    status: 'info-ok',
    value: 'あり',
    detail: ecMap[r.symbology.code] || 'リード・ソロモン誤り訂正を持ちます。',
    formula: null,
  });
  if (meta.errorCorrectionLevel) {
    r.structure.push({ label: '誤り訂正レベル', value: String(meta.errorCorrectionLevel), note: null });
  }
  if (meta.symbologyIdentifier) {
    r.structure.push({ label: '記号系識別子', value: String(meta.symbologyIdentifier), note: meta.symbologyIdentifier === ']d2' ? 'GS1 データマトリックス (FNC1 先頭)' : null });
    if (meta.symbologyIdentifier === ']d2') {
      r.symbology.label = 'GS1 データマトリックス';
      const parsed = parseGs1(text);
      if (parsed && parsed.ok) r.gs1 = parsed;
    }
  }
  r.structure.push({ label: 'データ長', value: r.raw.length + ' 文字 / UTF-8 ' + r.raw.utf8Bytes + ' バイト', note: null });
}
