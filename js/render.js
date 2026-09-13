/**
 * render.js - 解析結果オブジェクトを DOM に描画する
 */

const STATUS_LABEL = {
  ok: '検証 OK',
  ng: '不一致',
  na: 'なし',
  unknown: '判定不能',
  info: '参考',
  'info-ok': '該当',
};

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

/** 数字系 1 次元コードの桁分割定義 */
function digitSegments(code, text) {
  const n = text.length;
  if (code === 'EAN_13' && n === 13) {
    return [
      { from: 0, to: 3, cls: 'seg-0', label: 'GS1 プレフィックス' },
      { from: 3, to: 12, cls: 'seg-1', label: '事業者・商品コード' },
      { from: 12, to: 13, cls: 'seg-cd', label: 'チェックデジット' },
    ];
  }
  if (code === 'EAN_8' && n === 8) {
    return [
      { from: 0, to: 3, cls: 'seg-0', label: 'GS1 プレフィックス' },
      { from: 3, to: 7, cls: 'seg-1', label: '商品コード' },
      { from: 7, to: 8, cls: 'seg-cd', label: 'チェックデジット' },
    ];
  }
  if (code === 'UPC_A' && n === 12) {
    return [
      { from: 0, to: 1, cls: 'seg-0', label: 'ナンバーシステム' },
      { from: 1, to: 6, cls: 'seg-1', label: 'メーカーコード' },
      { from: 6, to: 11, cls: 'seg-2', label: '商品コード' },
      { from: 11, to: 12, cls: 'seg-cd', label: 'チェックデジット' },
    ];
  }
  if (code === 'ITF' && n === 14) {
    return [
      { from: 0, to: 1, cls: 'seg-0', label: 'インジケータ' },
      { from: 1, to: 4, cls: 'seg-2', label: 'GS1 プレフィックス' },
      { from: 4, to: 13, cls: 'seg-1', label: '事業者・商品コード' },
      { from: 13, to: 14, cls: 'seg-cd', label: 'チェックデジット' },
    ];
  }
  if (code === 'UPC_E' && n === 8) {
    return [
      { from: 0, to: 1, cls: 'seg-0', label: 'ナンバーシステム' },
      { from: 1, to: 7, cls: 'seg-1', label: '短縮本体' },
      { from: 7, to: 8, cls: 'seg-cd', label: 'チェックデジット' },
    ];
  }
  return null;
}

/** 見出しに出すチェックデジット総評バッジ。analyzer の kind だけで判断する */
function checkSummaryBadge(result) {
  const byKind = (k) => result.checks.filter((c) => c.kind === k);

  const cd = byKind('cd');
  const verified = cd.find((c) => c.status === 'ok' || c.status === 'ng');
  if (verified) {
    return verified.status === 'ok'
      ? { cls: 'ok', text: 'チェックデジット 一致' }
      : { cls: 'ng', text: 'チェックデジット 不一致' };
  }
  if (byKind('embedded').length) return { cls: 'ok', text: 'シンボル内蔵の検査文字で検証済み' };
  if (byKind('ec').length) return { cls: 'ok', text: '誤り訂正あり (チェックデジットなし)' };
  if (cd.some((c) => c.status === 'info-ok')) return { cls: 'ok', text: 'チェックキャラクタ付きの可能性' };
  if (cd.some((c) => c.status === 'unknown')) return { cls: 'na', text: 'チェックデジット 有無不明' };
  if (cd.length) return { cls: 'na', text: 'チェックデジットなし' };
  return { cls: 'na', text: '検査情報なし' };
}

function renderResult(result, container, tally) {
  container.textContent = '';
  const s = result.symbology;

  /* ---------- 見出し ---------- */
  const head = el('div', 'res-head');
  head.appendChild(el('p', 'res-kicker', s.kind + ' シンボル'));
  head.appendChild(el('h2', 'res-title', s.label));

  const badges = el('div', 'res-badges');
  const sum = checkSummaryBadge(result);
  badges.appendChild(el('span', 'badge ' + sum.cls, sum.text));
  badges.appendChild(el('span', 'badge kind', s.kind));
  for (const a of result.aliases) badges.appendChild(el('span', 'badge', a));
  head.appendChild(badges);

  const val = el('div', 'res-value');
  val.appendChild(document.createTextNode(displayText(result.raw.text)));
  const copy = el('button', 'copy-btn', 'コピー');
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(result.raw.text).then(() => {
      copy.textContent = 'コピーしました';
      setTimeout(() => { copy.textContent = 'コピー'; }, 1500);
    });
  });
  val.appendChild(copy);
  head.appendChild(val);
  container.appendChild(head);

  /* ---------- 機器の設定（この画面の主目的） ---------- */
  if (typeof buildDeviceSettings === 'function') {
    container.appendChild(renderDeviceSettings(buildDeviceSettings(result, tally)));
  }

  /* ---------- 桁の可視化 ---------- */
  const segs = digitSegments(s.code, result.raw.text);
  if (segs) {
    const sec = section('桁の構成');
    const wrap = el('div', 'digits');
    const cdCheck = result.checks.find((c) => c.status === 'ok' || c.status === 'ng');
    for (const seg of segs) {
      let cls = 'seg ' + seg.cls;
      if (seg.cls === 'seg-cd' && cdCheck && cdCheck.status === 'ng') cls += ' bad';
      wrap.appendChild(el('span', cls, result.raw.text.slice(seg.from, seg.to)));
    }
    sec.appendChild(wrap);
    const legend = el('div', 'digits-legend');
    segs.forEach((seg, i) => {
      legend.appendChild(el('span', 'lg-' + (seg.cls === 'seg-cd' ? 'cd' : i), seg.label));
    });
    sec.appendChild(legend);
    container.appendChild(sec);
  }

  /* ---------- チェックデジット ---------- */
  const checkSec = section('チェックデジット・誤り検出');
  if (result.checks.length === 0) {
    checkSec.appendChild(el('p', 'check-detail', '検証項目はありません。'));
  }
  for (const c of result.checks) {
    const item = el('div', 'check-item ' + c.status);
    const h = el('div', 'check-head');
    h.appendChild(el('span', 'check-name', c.name));
    h.appendChild(el('span', 'check-mark', STATUS_LABEL[c.status] || c.status));
    if (c.value) h.appendChild(el('span', 'badge', String(c.value)));
    item.appendChild(h);
    if (c.detail) item.appendChild(el('p', 'check-detail', c.detail));
    if (c.formula) item.appendChild(el('div', 'check-formula', c.formula));
    checkSec.appendChild(item);
  }
  container.appendChild(checkSec);

  /* ---------- 桁構造 ---------- */
  if (result.structure.length) {
    const sec = section('データの意味');
    const table = el('table', 'struct-table');
    for (const f of result.structure) {
      const tr = el('tr');
      tr.appendChild(el('th', null, f.label));
      const td = el('td', 'v');
      td.appendChild(document.createTextNode(f.value));
      if (f.note) td.appendChild(el('span', 'note', f.note));
      tr.appendChild(td);
      table.appendChild(tr);
    }
    sec.appendChild(table);
    container.appendChild(sec);
  }

  /* ---------- GS1 AI ---------- */
  if (result.gs1 && result.gs1.elements.length) {
    const sec = section('GS1 アプリケーション識別子');
    for (const e of result.gs1.elements) {
      const box = el('div', 'gs1-el');
      const h = el('div');
      h.appendChild(el('span', 'gs1-ai', '(' + e.ai + ')'));
      h.appendChild(el('span', 'gs1-name', e.name + (e.fixed ? ' ・固定長' : ' ・可変長')));
      box.appendChild(h);
      box.appendChild(el('div', 'gs1-val', e.value));
      if (e.decoded) box.appendChild(el('div', 'gs1-dec', '→ ' + e.decoded));
      sec.appendChild(box);
    }
    if (result.gs1.trailing) {
      sec.appendChild(el('p', 'check-detail warn', '未解釈の残り: ' + result.gs1.trailing));
    }
    container.appendChild(sec);
  }

  /* ---------- 内容 ---------- */
  if (result.content && (result.content.description || result.content.fields.length)) {
    const sec = section('データ内容: ' + result.content.label);
    if (result.content.description) {
      sec.appendChild(el('p', 'content-desc', result.content.description));
    }
    if (result.content.fields.length) {
      const table = el('table', 'struct-table');
      for (const f of result.content.fields) {
        const tr = el('tr');
        tr.appendChild(el('th', null, f.label));
        const td = el('td', 'v');
        td.appendChild(document.createTextNode(f.value));
        if (f.note) td.appendChild(el('span', 'note', f.note));
        tr.appendChild(td);
        table.appendChild(tr);
      }
      sec.appendChild(table);
    }
    container.appendChild(sec);
  }

  /* ---------- シンボル仕様 ---------- */
  const specSec = section('シンボル仕様');
  const dl = el('dl', 'spec-grid');
  addSpec(dl, '正式名称', s.label);
  addSpec(dl, '分類', s.kind);
  addSpec(dl, '準拠規格', s.standard);
  addSpec(dl, '使用可能文字', s.charset);
  addSpec(dl, 'データ長', s.length);
  addSpec(dl, 'チェックデジット', s.checkDigit);
  specSec.appendChild(dl);
  if (s.note) specSec.appendChild(el('p', 'check-detail', s.note));
  container.appendChild(specSec);

  /* ---------- 生データ ---------- */
  const rawSec = section('生データ');
  const rdl = el('dl', 'spec-grid');
  const r = result.raw;
  addSpec(rdl, '文字数', r.length + ' 文字');
  addSpec(rdl, '文字構成', [
    r.digits ? '数字 ' + r.digits : null,
    r.upper ? '英大文字 ' + r.upper : null,
    r.lower ? '英小文字 ' + r.lower : null,
    r.symbol ? '記号 ' + r.symbol : null,
    r.control ? '制御文字 ' + r.control : null,
    r.nonAscii ? '非 ASCII ' + r.nonAscii : null,
  ].filter(Boolean).join(' / ') || '-');
  addSpec(rdl, 'UTF-8 バイト数', r.utf8Bytes + ' バイト');
  rawSec.appendChild(rdl);
  const hex = el('div', 'check-formula', r.hex);
  rawSec.appendChild(hex);
  container.appendChild(rawSec);

  /* ---------- 補足 ---------- */
  if (result.notes && result.notes.length) {
    const sec = section('補足');
    const ul = el('ul', 'note-list');
    for (const n of result.notes) ul.appendChild(el('li', null, n));
    sec.appendChild(ul);
    container.appendChild(sec);
  }
}

function section(title) {
  const sec = el('section', 'res-section');
  sec.appendChild(el('h3', null, title));
  return sec;
}

function addSpec(dl, k, v) {
  dl.appendChild(el('dt', null, k));
  dl.appendChild(el('dd', null, v));
}

/** 制御文字を可視化した表示用文字列 */
function displayText(text) {
  return text.replace(/\u001d/g, '⟨GS⟩').replace(/\u001e/g, '⟨RS⟩').replace(/\u0004/g, '⟨EOT⟩');
}

/* =================================================================== *
 * 機器の設定
 * =================================================================== */

const SETTING_LEVEL_LABEL = {
  fixed: '確定',
  likely: 'そう判断してよい',
  unknown: '要確認',
  warn: '要調査',
};

function renderDeviceSettings(settings) {
  const sec = el('section', 'res-section setting-block');
  sec.appendChild(el('h3', null, '読取機の設定'));

  for (const item of settings.items) {
    const box = el('div', 'setting-item ' + item.level);
    const head = el('div', 'setting-head');
    head.appendChild(el('span', 'setting-label', item.label));
    head.appendChild(el('span', 'setting-level', SETTING_LEVEL_LABEL[item.level] || item.level));
    box.appendChild(head);
    box.appendChild(el('div', 'setting-value', item.value));
    if (item.detail) box.appendChild(el('p', 'setting-detail', item.detail));
    if (item.note) box.appendChild(el('p', 'setting-note', item.note));
    sec.appendChild(box);
  }

  if (settings.tally) {
    const t = el('div', 'tally ' + (settings.tally.decisive ? 'is-decisive' : ''));
    t.appendChild(el('div', 'tally-head', '読み取り集計  ' + settings.tally.count + ' 件中 ' + settings.tally.matched + ' 件一致'));
    if (settings.tally.headline) t.appendChild(el('div', 'tally-headline', settings.tally.headline));
    t.appendChild(el('p', 'tally-text', settings.tally.sentence));
    if (settings.tally.hint) t.appendChild(el('p', 'tally-hint', settings.tally.hint));
    sec.appendChild(t);
  }

  const copy = el('button', 'btn btn-sm copy-settings', '設定内容をコピー');
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(settingsToText(settings)).then(() => {
      copy.textContent = 'コピーしました';
      setTimeout(() => { copy.textContent = '設定内容をコピー'; }, 1500);
    });
  });
  sec.appendChild(copy);
  return sec;
}

/** 作業報告や引き継ぎにそのまま貼れる形にする */
function settingsToText(settings) {
  const lines = ['【読取機の設定】'];
  for (const item of settings.items) {
    lines.push('■ ' + item.label + ': ' + item.value);
    if (item.detail) lines.push('   ' + item.detail);
    if (item.note) lines.push('   ※ ' + item.note);
  }
  if (settings.tally) {
    lines.push('■ 読み取り集計: ' + settings.tally.count + ' 件中 ' + settings.tally.matched + ' 件一致');
    lines.push('   ' + settings.tally.sentence);
  }
  return lines.join('\n');
}
