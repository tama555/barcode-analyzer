/**
 * app.js - カメラ／画像／手入力からバーコードを読み取り、解析結果を描画する
 */
(function () {
  'use strict';

  if (typeof ZXing === 'undefined') {
    document.getElementById('status').textContent = 'ZXing ライブラリの読み込みに失敗しました（ネットワークを確認してください）。';
    document.getElementById('status').classList.add('is-error');
    return;
  }

  const { BarcodeFormat, DecodeHintType, MultiFormatReader, RGBLuminanceSource,
    HybridBinarizer, BinaryBitmap, ResultMetadataType } = ZXing;

  const SUPPORTED_FORMATS = [
    BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
    BarcodeFormat.CODE_39, BarcodeFormat.CODE_93, BarcodeFormat.CODE_128, BarcodeFormat.ITF,
    BarcodeFormat.CODABAR, BarcodeFormat.RSS_14, BarcodeFormat.RSS_EXPANDED,
    BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX, BarcodeFormat.AZTEC,
    BarcodeFormat.PDF_417, BarcodeFormat.MAXICODE,
  ];

  const reader = new MultiFormatReader();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const dom = {
    video: document.getElementById('video'),
    videoWrap: document.getElementById('videoWrap'),
    placeholder: document.getElementById('videoPlaceholder'),
    guide: document.getElementById('guide'),
    startBtn: document.getElementById('startBtn'),
    stopBtn: document.getElementById('stopBtn'),
    torchBtn: document.getElementById('torchBtn'),
    cameraSelect: document.getElementById('cameraSelect'),
    status: document.getElementById('status'),
    optRoi: document.getElementById('optRoi'),
    optTryHarder: document.getElementById('optTryHarder'),
    optInverted: document.getElementById('optInverted'),
    optContinuous: document.getElementById('optContinuous'),
    optBeep: document.getElementById('optBeep'),
    dropzone: document.getElementById('dropzone'),
    fileInput: document.getElementById('fileInput'),
    imagePreview: document.getElementById('imagePreview'),
    imageStatus: document.getElementById('imageStatus'),
    manualText: document.getElementById('manualText'),
    manualFormat: document.getElementById('manualFormat'),
    manualBtn: document.getElementById('manualBtn'),
    sampleFormat: document.getElementById('sampleFormat'),
    sampleText: document.getElementById('sampleText'),
    sampleGen: document.getElementById('sampleGen'),
    sampleDecode: document.getElementById('sampleDecode'),
    sampleCanvas: document.getElementById('sampleCanvas'),
    sampleStatus: document.getElementById('sampleStatus'),
    history: document.getElementById('history'),
    clearHistory: document.getElementById('clearHistory'),
    result: document.getElementById('result'),
    emptyState: document.getElementById('emptyState'),
    updateBanner: document.getElementById('updateBanner'),
    updateBtn: document.getElementById('updateBtn'),
    updateDismiss: document.getElementById('updateDismiss'),
  };

  let stream = null;
  let track = null;
  let scanTimer = null;
  let wakeLock = null;
  let lastHit = { text: '', at: 0 };
  const history = [];

  // 形式ごとに、チェックデジットの一致状況を数える。
  // 任意仕様の形式は1枚では判断できないため、複数枚の傾向で確度を上げる
  const formatTally = {};

  /* ================================================================ *
   * デコード共通処理
   * ================================================================ */

  function buildHints() {
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, SUPPORTED_FORMATS);
    if (dom.optTryHarder.checked) hints.set(DecodeHintType.TRY_HARDER, true);
    return hints;
  }

  /** ImageData → 輝度バッファ (ITU-R BT.601) */
  function toLuminance(imageData) {
    const d = imageData.data;
    const lum = new Uint8ClampedArray(imageData.width * imageData.height);
    for (let i = 0, j = 0; j < lum.length; i += 4, j++) {
      lum[j] = (d[i] * 306 + d[i + 1] * 601 + d[i + 2] * 117) >> 10;
    }
    return lum;
  }

  /** 輝度バッファをデコードする。見つからなければ null */
  function decodeLuminance(lum, width, height, hints) {
    try {
      const source = new RGBLuminanceSource(lum, width, height);
      const bitmap = new BinaryBitmap(new HybridBinarizer(source));
      return reader.decode(bitmap, hints);
    } catch (e) {
      return null;
    } finally {
      // 一度も decode に成功していない状態では内部の readers が未初期化のため保護する
      try { reader.reset(); } catch (e) { /* 無視してよい */ }
    }
  }

  /** 通常＋（任意で）白黒反転でデコードを試す */
  function decodeImageData(imageData, hints, alsoInverted) {
    const lum = toLuminance(imageData);
    let res = decodeLuminance(lum, imageData.width, imageData.height, hints);
    if (res) return res;
    if (alsoInverted) {
      const inv = new Uint8ClampedArray(lum.length);
      for (let i = 0; i < lum.length; i++) inv[i] = 255 - lum[i];
      res = decodeLuminance(inv, imageData.width, imageData.height, hints);
      if (res) return res;
    }
    return null;
  }

  /** ZXing の Result から解析用メタデータを取り出す */
  function extractMeta(result) {
    const meta = {};
    const map = result.getResultMetadata && result.getResultMetadata();
    if (map && map.forEach) {
      map.forEach((value, key) => {
        if (key === ResultMetadataType.ERROR_CORRECTION_LEVEL) meta.errorCorrectionLevel = value;
        else if (key === ResultMetadataType.ORIENTATION) meta.orientation = value;
        else if (key === ResultMetadataType.POSSIBLE_COUNTRY) meta.possibleCountry = value;
        else if (key === ResultMetadataType.UPC_EAN_EXTENSION) meta.upcEanExtension = value;
        else if (key === ResultMetadataType.ISSUE_NUMBER) meta.issueNumber = value;
        else if (key === ResultMetadataType.SUGGESTED_PRICE) meta.suggestedPrice = value;
        else if (key === ResultMetadataType.STRUCTURED_APPEND_SEQUENCE) meta.structuredAppendSequence = value;
        else if (key === ResultMetadataType.BYTE_SEGMENTS && value && value.length) meta.byteSegmentCount = value.length;
      });
    }
    return meta;
  }

  /** デコード結果を解析して画面に出す */
  function handleResult(result, source) {
    const formatCode = BarcodeFormat[result.getBarcodeFormat()];
    const text = result.getText();
    const meta = extractMeta(result);
    let rawBytes = null;
    try { rawBytes = result.getRawBytes(); } catch (e) { /* 未対応シンボルでは取得できない */ }

    const analysis = analyzeBarcode(formatCode, text, meta, rawBytes);
    appendExtensionInfo(analysis, meta);
    recordTally(formatCode, analysis);
    show(analysis);
    pushHistory(formatCode, text, analysis, source);
    return analysis;
  }

  /** EAN/UPC アドオン（2桁・5桁）などの付加情報 */
  function appendExtensionInfo(analysis, meta) {
    if (meta.upcEanExtension) {
      const ext = String(meta.upcEanExtension);
      analysis.structure.push({
        label: 'アドオンコード',
        value: ext,
        note: ext.length === 2 ? '2桁アドオン（雑誌の号数など）' : '5桁アドオン（書籍の価格など）',
      });
    }
    if (meta.issueNumber != null) {
      analysis.structure.push({ label: '号数', value: String(meta.issueNumber), note: '2桁アドオンから読み取った雑誌の号数' });
    }
    if (meta.suggestedPrice) {
      analysis.structure.push({ label: '希望小売価格', value: String(meta.suggestedPrice), note: '5桁アドオンから読み取った価格' });
    }
    if (meta.possibleCountry) {
      analysis.structure.push({ label: '推定国 (ZXing)', value: String(meta.possibleCountry), note: 'ライブラリによる国コード推定値' });
    }
  }

  function show(analysis) {
    dom.emptyState.hidden = true;
    dom.result.hidden = false;
    renderResult(analysis, dom.result, formatTally[analysis.symbology.code] || null);
    dom.result.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /**
   * 同じ値を数え直さないよう、読み取った値ごとに一度だけ集計する。
   * 同じバーコードを10回読んでも確度は上がらないため。
   */
  function recordTally(formatCode, analysis) {
    const t = formatTally[formatCode] || (formatTally[formatCode] = { evaluated: 0, matched: 0, seen: {}, methods: {} });
    const text = analysis.raw.text;
    if (t.seen[text]) return;

    const cd = analysis.checks.find((c) => c.kind === 'cd');
    if (!cd) return;
    if (cd.status !== 'info-ok' && cd.status !== 'na' && cd.status !== 'ok' && cd.status !== 'ng') return;

    t.seen[text] = true;
    t.evaluated++;
    if (cd.status === 'info-ok' || cd.status === 'ok') {
      t.matched++;
      // どの計算方式で一致したかを数える。全枚数で同じ方式なら、それが運用中の方式
      if (cd.method) t.methods[cd.method] = (t.methods[cd.method] || 0) + 1;
    }
  }

  /* ================================================================ *
   * カメラ
   * ================================================================ */

  const VIDEO_SIZE = { width: { ideal: 1920 }, height: { ideal: 1080 } };

  /**
   * カメラ映像を取得する。デバイス指定に失敗したら自動選択で取り直す。
   * 一覧で選んだカメラが抜かれている場合などに効く。
   */
  async function getStream(deviceId) {
    if (deviceId) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          video: Object.assign({ deviceId: { exact: deviceId } }, VIDEO_SIZE),
          audio: false,
        });
      } catch (e) {
        // 拒否された場合に別条件で再要求しても無意味なので、そのまま投げ返す
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw e;
      }
    }
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: Object.assign({ facingMode: { ideal: 'environment' } }, VIDEO_SIZE),
        audio: false,
      });
    } catch (e) {
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw e;
      // 解像度や背面指定が通らない端末向けの最終手段
      return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
  }

  /** 失敗理由を、対処が分かる日本語にする */
  function describeCameraError(e) {
    const name = e && e.name ? e.name : '';
    if (name === 'NotAllowedError') return 'アクセスが拒否されました。ブラウザのアドレスバーの鍵マークから、このサイトのカメラを「許可」に変えてください。';
    if (name === 'SecurityError') return '安全な接続ではないため使えません。https:// で開いてください。';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'カメラが見つかりません。';
    if (name === 'NotReadableError' || name === 'TrackStartError') return 'カメラを別のアプリが使用中です。他のアプリを閉じてから試してください。';
    if (name === 'OverconstrainedError') return '指定した条件に合うカメラがありません。';
    return (name ? name + ': ' : '') + (e && e.message ? e.message : '原因不明');
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('このブラウザはカメラ API に対応していません。', 'error');
      return;
    }
    setStatus('カメラを起動しています…');

    // 一覧を取得する前は選択欄に実在するデバイス ID が入っていない。
    // その値をそのまま要求すると必ず失敗するため、自動扱いに落とす
    const selected = dom.cameraSelect.value;
    const deviceId = (selected && selected !== 'auto' && !dom.cameraSelect.disabled) ? selected : null;

    try {
      stream = await getStream(deviceId);
    } catch (e) {
      setStatus('カメラを開始できません: ' + describeCameraError(e), 'error');
      return;
    }
    track = stream.getVideoTracks()[0];
    dom.video.srcObject = stream;
    await dom.video.play();

    dom.placeholder.hidden = true;
    dom.guide.classList.toggle('is-on', dom.optRoi.checked);
    dom.startBtn.disabled = true;
    dom.stopBtn.disabled = false;
    setupTorch();
    await refreshCameraList();

    const s = track.getSettings();
    setStatus('スキャン中… ' + (s.width || '?') + '×' + (s.height || '?') + ' / コードを枠に合わせてください');
    acquireWakeLock();
    scanTimer = setInterval(scanTick, 110);
  }

  function stopCamera() {
    clearInterval(scanTimer);
    scanTimer = null;
    releaseWakeLock();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    track = null;
    dom.video.srcObject = null;
    dom.placeholder.hidden = false;
    dom.guide.classList.remove('is-on');
    dom.startBtn.disabled = false;
    dom.stopBtn.disabled = true;
    dom.torchBtn.hidden = true;
    setStatus('停止しました');
  }

  /** 表示中のガイド枠を映像の実座標へ変換する */
  function roiRect() {
    const vw = dom.video.videoWidth;
    const vh = dom.video.videoHeight;
    if (!dom.optRoi.checked) return { x: 0, y: 0, w: vw, h: vh };

    const cw = dom.video.clientWidth;
    const ch = dom.video.clientHeight;
    if (!cw || !ch) return { x: 0, y: 0, w: vw, h: vh };

    // object-fit: cover の写像
    const scale = Math.max(cw / vw, ch / vh);
    const offX = (cw - vw * scale) / 2;
    const offY = (ch - vh * scale) / 2;

    const gx = 0.10 * cw, gy = 0.275 * ch, gw = 0.80 * cw, gh = 0.45 * ch;
    const x = Math.max(0, Math.round((gx - offX) / scale));
    const y = Math.max(0, Math.round((gy - offY) / scale));
    const w = Math.min(vw - x, Math.round(gw / scale));
    const h = Math.min(vh - y, Math.round(gh / scale));
    return { x: x, y: y, w: Math.max(1, w), h: Math.max(1, h) };
  }

  function scanTick() {
    if (!dom.video.videoWidth) return;
    const roi = roiRect();
    const maxW = 900;
    const scale = Math.min(1, maxW / roi.w);
    canvas.width = Math.max(1, Math.round(roi.w * scale));
    canvas.height = Math.max(1, Math.round(roi.h * scale));
    ctx.drawImage(dom.video, roi.x, roi.y, roi.w, roi.h, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const result = decodeImageData(imageData, buildHints(), dom.optInverted.checked);
    if (!result) return;

    const text = result.getText();
    const now = Date.now();
    if (text === lastHit.text && now - lastHit.at < 1800) return;
    lastHit = { text: text, at: now };

    flashHit();
    if (dom.optBeep.checked) beep();
    if (navigator.vibrate) navigator.vibrate(35);

    handleResult(result, 'カメラ');
    setStatus('読み取り成功: ' + BarcodeFormat[result.getBarcodeFormat()], 'ok');

    if (!dom.optContinuous.checked) stopCamera();
  }

  function flashHit() {
    dom.videoWrap.classList.add('is-hit');
    setTimeout(() => dom.videoWrap.classList.remove('is-hit'), 450);
  }

  function setupTorch() {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (!caps || !('torch' in caps)) { dom.torchBtn.hidden = true; return; }
    dom.torchBtn.hidden = false;
    dom.torchBtn.disabled = false;
    let on = false;
    dom.torchBtn.onclick = async () => {
      on = !on;
      try {
        await track.applyConstraints({ advanced: [{ torch: on }] });
        dom.torchBtn.textContent = on ? 'ライト ON' : 'ライト';
      } catch (e) {
        setStatus('ライトを制御できません: ' + e.message, 'error');
      }
    };
  }

  async function refreshCameraList() {
    if (!navigator.mediaDevices.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === 'videoinput');
    const current = dom.cameraSelect.value;
    dom.cameraSelect.textContent = '';
    const auto = document.createElement('option');
    auto.value = 'auto';
    auto.textContent = '自動（背面カメラを優先）';
    dom.cameraSelect.appendChild(auto);
    cams.forEach((c, i) => {
      const o = document.createElement('option');
      o.value = c.deviceId;
      o.textContent = c.label || 'カメラ ' + (i + 1);
      dom.cameraSelect.appendChild(o);
    });
    dom.cameraSelect.value = current && [...dom.cameraSelect.options].some((o) => o.value === current) ? current : 'auto';
    dom.cameraSelect.disabled = false;
  }

  function beep() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ac = new AudioCtx();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = 1180;
      gain.gain.setValueAtTime(0.14, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.13);
      osc.connect(gain).connect(ac.destination);
      osc.start();
      osc.stop(ac.currentTime + 0.14);
      osc.onended = () => ac.close();
    } catch (e) { /* 音が出せない環境では無視 */ }
  }

  function setStatus(msg, kind) {
    dom.status.textContent = msg;
    dom.status.classList.toggle('is-error', kind === 'error');
    dom.status.classList.toggle('is-ok', kind === 'ok');
  }

  /* ================================================================ *
   * 画像ファイル
   * ================================================================ */

  async function decodeFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      dom.imageStatus.textContent = '画像ファイルを指定してください。';
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch (e) {
      dom.imageStatus.textContent = '画像を読み込めませんでした。';
      URL.revokeObjectURL(url);
      return;
    }
    dom.imagePreview.src = url;
    dom.imagePreview.hidden = false;
    dom.imageStatus.textContent = '解析中…';

    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, SUPPORTED_FORMATS);
    hints.set(DecodeHintType.TRY_HARDER, true);

    // 解像度を変えながら、見つからなければ 90 度回転も試す
    const result = await tryDecodeImage(img, hints);
    if (!result) {
      dom.imageStatus.textContent = 'コードを検出できませんでした。ぼけ・傾き・余白（クワイエットゾーン）を確認してください。';
      return;
    }
    handleResult(result, '画像');
    dom.imageStatus.textContent = '読み取り成功: ' + BarcodeFormat[result.getBarcodeFormat()];
  }

  async function tryDecodeImage(img, hints) {
    const scales = [1, 0.6, 1.6];
    for (const rotate of [0, 90, 180, 270]) {
      for (const scale of scales) {
        const data = drawToImageData(img, scale, rotate);
        if (!data) continue;
        const res = decodeImageData(data, hints, true);
        if (res) return res;
      }
    }
    return null;
  }

  function drawToImageData(img, scale, rotate) {
    const maxSide = 2000;
    let w = Math.round(img.naturalWidth * scale);
    let h = Math.round(img.naturalHeight * scale);
    const cap = Math.min(1, maxSide / Math.max(w, h));
    w = Math.max(1, Math.round(w * cap));
    h = Math.max(1, Math.round(h * cap));

    const swap = rotate === 90 || rotate === 270;
    canvas.width = swap ? h : w;
    canvas.height = swap ? w : h;
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rotate * Math.PI) / 180);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  /* ================================================================ *
   * 手入力
   * ================================================================ */

  /** 文字列から妥当なシンボル種別を推定する */
  function guessFormat(text) {
    const t = text;
    if (/^\d+$/.test(t)) {
      if (t.length === 13) return 'EAN_13';
      if (t.length === 12) return 'UPC_A';
      if (t.length === 8) return 'EAN_8';
      if (t.length === 14) return 'ITF';
      if (t.length % 2 === 0) return 'ITF';
      return 'CODE_128';
    }
    if (t.includes('\u001d')) return 'CODE_128';
    if (/^[0-9A-Z\-. $/+%]+$/.test(t)) return 'CODE_39';
    if ([...t].every((c) => c.codePointAt(0) < 128)) return 'CODE_128';
    return 'QR_CODE';
  }

  function runManual() {
    let text = dom.manualText.value;
    if (!text) return;
    // FNC1 の表記ゆれを実際の GS 文字へ
    text = text.replace(/\\x1d/gi, '\u001d').replace(/\{GS\}/gi, '\u001d');

    const chosen = dom.manualFormat.value;
    const formatCode = chosen === 'AUTO' ? guessFormat(text) : chosen;
    const analysis = analyzeBarcode(formatCode, text, {}, null);
    if (chosen === 'AUTO') {
      analysis.notes.push('シンボル種別は入力文字列から推定したものです。実際のシンボルとは異なる場合があります。');
    }
    recordTally(formatCode, analysis);
    show(analysis);
    pushHistory(formatCode, text, analysis, '手入力');
  }


  /* ================================================================ *
   * 画面の消灯抑止
   * ================================================================ */

  /** スキャン中に画面が暗くなると読み取れないため、点灯を維持する */
  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {
      // 電池残量が少ない端末などでは拒否される。読み取り自体には影響しない
    }
  }

  function releaseWakeLock() {
    if (!wakeLock) return;
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }

  // 他アプリに切り替えると解除されるので、戻ってきたら取り直す
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && stream) acquireWakeLock();
  });

  /* ================================================================ *
   * サンプル生成（動作確認用）
   * ================================================================ */

  const SAMPLE_PRESETS = {
    EAN_13: '4901234567894',
    EAN_8: '49123456',
    UPC_A: '036000291452',
    ITF: '14901234567891',
    CODE_39: 'ABC-1234',
    QR_CODE: 'https://example.com/items?id=7',
  };

  function generateSample() {
    const format = dom.sampleFormat.value;
    const text = dom.sampleText.value.trim();
    if (!text) return;
    try {
      if (format === 'QR_CODE') {
        drawQrSample(text);
      } else {
        const enc = BarcodeGen.encode(format, text);
        BarcodeGen.drawBits(dom.sampleCanvas, enc.bits, { moduleWidth: 3, height: 110, text: enc.text });
        if (enc.text !== text) dom.sampleText.value = enc.text;
      }
      dom.sampleDecode.disabled = false;
      dom.sampleStatus.textContent = '生成しました。「この画像を解析」で読み取り経路も含めて確認できます。';
      dom.sampleStatus.classList.remove('is-error');
    } catch (e) {
      dom.sampleStatus.textContent = '生成できません: ' + e.message;
      dom.sampleStatus.classList.add('is-error');
      dom.sampleDecode.disabled = true;
    }
  }

  function drawQrSample(text) {
    const hints = new Map();
    hints.set(ZXing.EncodeHintType.MARGIN, 4);
    hints.set(ZXing.EncodeHintType.CHARACTER_SET, 'UTF-8');
    const matrix = new ZXing.MultiFormatWriter().encode(text, BarcodeFormat.QR_CODE, 300, 300, hints);
    const w = matrix.getWidth();
    const h = matrix.getHeight();
    const px = Math.max(1, Math.floor(300 / w));
    dom.sampleCanvas.width = w * px;
    dom.sampleCanvas.height = h * px;
    const c = dom.sampleCanvas.getContext('2d');
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, dom.sampleCanvas.width, dom.sampleCanvas.height);
    c.fillStyle = '#000000';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) if (matrix.get(x, y)) c.fillRect(x * px, y * px, px, px);
    }
  }

  function decodeSample() {
    const c = dom.sampleCanvas;
    if (!c.width) return;
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, SUPPORTED_FORMATS);
    hints.set(DecodeHintType.TRY_HARDER, true);
    const result = decodeImageData(data, hints, false);
    if (!result) {
      dom.sampleStatus.textContent = '生成した画像を読み取れませんでした。';
      dom.sampleStatus.classList.add('is-error');
      return;
    }
    handleResult(result, 'サンプル');
    dom.sampleStatus.textContent = '読み取り成功: ' + BarcodeFormat[result.getBarcodeFormat()];
    dom.sampleStatus.classList.remove('is-error');
  }

  /* ================================================================ *
   * 履歴
   * ================================================================ */

  function pushHistory(formatCode, text, analysis, source) {
    history.unshift({ formatCode: formatCode, text: text, analysis: analysis, source: source, at: new Date() });
    if (history.length > 50) history.pop();
    renderHistory();
  }

  function renderHistory() {
    dom.history.textContent = '';
    if (!history.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'まだ読み取っていません';
      dom.history.appendChild(li);
      return;
    }
    history.forEach((h, i) => {
      const li = document.createElement('li');
      const fmt = document.createElement('span');
      fmt.className = 'h-fmt';
      fmt.textContent = (SYMBOLOGY_SPECS[h.formatCode] ? SYMBOLOGY_SPECS[h.formatCode].label : h.formatCode).split(' ')[0];
      const val = document.createElement('span');
      val.className = 'h-val';
      val.textContent = h.text.replace(/\u001d/g, '⟨GS⟩');
      li.appendChild(fmt);
      li.appendChild(val);
      li.title = h.source + ' / ' + h.at.toLocaleTimeString('ja-JP');
      li.addEventListener('click', () => show(history[i].analysis));
      dom.history.appendChild(li);
    });
  }

  /* ================================================================ *
   * イベント配線
   * ================================================================ */

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
      document.querySelectorAll('.tabpane').forEach((p) => {
        p.classList.toggle('is-active', p.dataset.pane === tab.dataset.tab);
      });
      if (tab.dataset.tab !== 'camera' && stream) stopCamera();
    });
  });

  dom.startBtn.addEventListener('click', startCamera);
  dom.stopBtn.addEventListener('click', stopCamera);
  dom.optRoi.addEventListener('change', () => dom.guide.classList.toggle('is-on', dom.optRoi.checked && !!stream));
  dom.cameraSelect.addEventListener('change', () => { if (stream) { stopCamera(); startCamera(); } });

  dom.dropzone.addEventListener('click', () => dom.fileInput.click());
  dom.fileInput.addEventListener('change', (e) => decodeFile(e.target.files[0]));
  dom.dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dom.dropzone.classList.add('is-over'); });
  dom.dropzone.addEventListener('dragleave', () => dom.dropzone.classList.remove('is-over'));
  dom.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dom.dropzone.classList.remove('is-over');
    if (e.dataTransfer.files.length) decodeFile(e.dataTransfer.files[0]);
  });
  window.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.type.startsWith('image/'));
    if (item) decodeFile(item.getAsFile());
  });

  dom.manualBtn.addEventListener('click', runManual);
  dom.manualText.addEventListener('keydown', (e) => { if (e.key === 'Enter') runManual(); });

  dom.sampleGen.addEventListener('click', generateSample);
  dom.sampleDecode.addEventListener('click', decodeSample);
  dom.sampleText.addEventListener('keydown', (e) => { if (e.key === 'Enter') generateSample(); });
  dom.sampleFormat.addEventListener('change', () => {
    dom.sampleText.value = SAMPLE_PRESETS[dom.sampleFormat.value] || '';
    dom.sampleDecode.disabled = true;
  });

  dom.clearHistory.addEventListener('click', () => { history.length = 0; renderHistory(); });

  window.addEventListener('beforeunload', () => { if (stream) stopCamera(); });

  // 解析ロジックの単体テストから参照できるように公開する
  window.__barcodeApp = { guessFormat: guessFormat, decodeImageData: decodeImageData };
})();
