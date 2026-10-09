/*
 * script.js — 加速ルーレット本体
 *
 *  - 左クリック（タップ）で加速、右クリックで減速。いつでも押せる
 *  - 何もしなければ摩擦で自然に減速して止まる
 *  - 項目はテキスト欄に改行区切り。同じ文字列は同じ色
 *  - 結果ポップアップ・履歴・除外・設定の自動保存（localStorage）
 */
(() => {
  'use strict';

  const Sound = window.RouletteSound;
  const $ = (id) => document.getElementById(id);
  const TAU = Math.PI * 2;

  /* ------------------------------------------------------------------ */
  /* 定数・初期値                                                          */
  /* ------------------------------------------------------------------ */

  const STORAGE_KEY = 'accel-roulette:v1';
  const MAX_HISTORY = 300;
  const HOLD_DELAY = 0.28;   // 長押しと判定するまでの秒数
  const ROLL_WINDOW = 3.2;   // 停止の何秒前からドラムロールを鳴らすか
  const SOUND_REF_RPM = 300; // 回転音の大きさの基準
  const RESULT_DELAY = 450;  // 止まってからポップアップまで（ms）

  const DEFAULT_ITEMS = ['カレー', 'ラーメン', '寿司', '焼肉', 'パスタ', 'ハンバーグ', 'ラーメン', 'オムライス'].join('\n');

  const DEFAULTS = Object.freeze({
    accel: 20,        // rpm / クリック
    brake: 20,        // rpm / クリック
    friction: 5,      // 摩擦の強さ（0 で減速なし）
    maxSpeed: 300,    // rpm
    holdEnabled: false,
    holdRate: 8,      // 回 / 秒
    autoRemove: false,
    theme: 'classic',
    volume: 70,
    muted: false,
    sounds: Object.freeze({ tick: true, boost: true, brake: true, hum: true, roll: true, result: true }),
  });

  const PLAY_KEYS = ['accel', 'brake', 'friction', 'maxSpeed', 'holdEnabled', 'holdRate', 'autoRemove'];

  // 加速量・減速量・最高速度は上限なし（JavaScript で扱える最大の数まで）
  const BIG = Number.MAX_VALUE;
  const LIMITS = {
    accel: [1, BIG],
    brake: [1, BIG],
    friction: [0, 50],
    maxSpeed: [0, BIG], // 0 = 無制限
    holdRate: [1, 30],
    volume: [0, 100],
  };

  /* ------------------------------------------------------------------ */
  /* 要素                                                                 */
  /* ------------------------------------------------------------------ */

  const el = {
    input: $('itemsInput'),
    itemCount: $('itemCount'),
    btnShuffle: $('btnShuffle'),
    wrap: $('wheelWrap'),
    canvas: $('wheel'),
    nowValue: $('nowValue'),
    nowChip: $('nowChip'),
    rpmValue: $('rpmValue'),
    rpmFill: $('rpmFill'),
    stateLabel: $('stateLabel'),
    status: $('status'),
    btnAccel: $('btnAccel'),
    btnBrake: $('btnBrake'),
    setAccel: $('setAccel'),
    setBrake: $('setBrake'),
    setFriction: $('setFriction'),
    setMax: $('setMax'),
    setHold: $('setHold'),
    setHoldRate: $('setHoldRate'),
    holdRateField: $('holdRateField'),
    setAutoRemove: $('setAutoRemove'),
    btnResetSettings: $('btnResetSettings'),
    btnMute: $('btnMute'),
    setVolume: $('setVolume'),
    volumeValue: $('volumeValue'),
    themeList: $('themeList'),
    eventList: $('eventList'),
    historyList: $('historyList'),
    historyEmpty: $('historyEmpty'),
    historyCount: $('historyCount'),
    btnClearHistory: $('btnClearHistory'),
    modal: $('resultModal'),
    resultMeta: $('resultMeta'),
    resultBand: $('resultBand'),
    resultTitle: $('resultTitle'),
    resultNote: $('resultNote'),
    btnRemoveOne: $('btnRemoveOne'),
    btnRemoveAll: $('btnRemoveAll'),
    btnCloseResult: $('btnCloseResult'),
    toast: $('toast'),
    toastText: $('toastText'),
    toastUndo: $('toastUndo'),
    confetti: $('confetti'),
  };

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const touchOnly = window.matchMedia('(hover: none)');

  /* ------------------------------------------------------------------ */
  /* 状態                                                                 */
  /* ------------------------------------------------------------------ */

  let settings = cloneDefaults();
  let history = [];
  let items = [];            // { label, color, ink, line }
  let colorIndex = new Map(); // 文字列 → 色番号（編集しても色が変わりにくいように保持）

  const spin = {
    angle: 0,          // ラジアン（時計回りが正）
    rpm: 0,
    active: false,
    boundary: 0,       // 針が越えた境目の通し番号
    lastAccelAt: -1e9,
    everSpun: false,
    lockedUntil: 0,    // 結果表示までの短い待ち
  };

  const fx = {
    flap: 0,           // 針の振れ（ラジアン）
    flapV: 0,
    bulbPhase: 0,
    flash: 0,          // 加速したときの電球フラッシュ
    celebrateUntil: 0,
  };

  let modalOpen = false;
  let lastResult = null;
  let tempStatus = { text: '', until: 0 };

  function cloneDefaults() {
    return { ...DEFAULTS, sounds: { ...DEFAULTS.sounds } };
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const nowSec = () => performance.now() / 1000;

  /* ------------------------------------------------------------------ */
  /* 保存・読み込み                                                        */
  /* ------------------------------------------------------------------ */

  function sanitizeSettings(raw) {
    const s = cloneDefaults();
    if (!raw || typeof raw !== 'object') return s;
    for (const key of Object.keys(LIMITS)) {
      const v = Number(raw[key]);
      if (Number.isFinite(v)) s[key] = clamp(v, LIMITS[key][0], LIMITS[key][1]);
    }
    for (const key of ['holdEnabled', 'autoRemove', 'muted']) {
      if (typeof raw[key] === 'boolean') s[key] = raw[key];
    }
    if (Sound.THEMES.some((t) => t.id === raw.theme)) s.theme = raw.theme;
    if (raw.sounds && typeof raw.sounds === 'object') {
      for (const key of Object.keys(s.sounds)) {
        if (typeof raw.sounds[key] === 'boolean') s.sounds[key] = raw.sounds[key];
      }
    }
    return s;
  }

  function loadState() {
    let data = null;
    try {
      data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (e) {
      data = null;
    }
    if (!data || typeof data !== 'object') {
      el.input.value = DEFAULT_ITEMS;
      return;
    }
    el.input.value = typeof data.items === 'string' ? data.items : DEFAULT_ITEMS;
    settings = sanitizeSettings(data.settings);
    if (Array.isArray(data.history)) {
      history = data.history
        .filter((h) => h && typeof h.label === 'string' && typeof h.color === 'string')
        .slice(0, MAX_HISTORY);
    }
    if (data.colors && typeof data.colors === 'object') {
      colorIndex = new Map(
        Object.entries(data.colors).filter(([, v]) => Number.isInteger(v) && v >= 0)
      );
    }
  }

  function saveState() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          v: 1,
          items: el.input.value,
          settings,
          history,
          colors: Object.fromEntries(colorIndex),
        })
      );
    } catch (e) {
      /* 保存できない環境（プライベートモード等）では何もしない */
    }
  }

  let saveTimer = 0;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 300);
  }

  /* ------------------------------------------------------------------ */
  /* 色（同じ文字列 → 同じ色）                                              */
  /* ------------------------------------------------------------------ */

  // OKLCH → リニア sRGB
  function oklchToLinear(L, C, hDeg) {
    const h = (hDeg * Math.PI) / 180;
    const a = C * Math.cos(h);
    const b = C * Math.sin(h);
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.291485548 * b;
    const l = l_ ** 3;
    const m = m_ ** 3;
    const s = s_ ** 3;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
  }

  const gammaDecode = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

  function hexToLinear(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => gammaDecode(v / 255));
  }

  const gammaEncode = (v) => {
    v = clamp(v, 0, 1);
    return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  };

  const paletteCache = [];
  function paletteColor(i) {
    if (paletteCache[i]) return paletteCache[i];
    // 黄金角で色相をずらすと、隣り合う番号の色がしっかり離れる
    const hue = (i * 137.508 + 28) % 360;
    const L = [0.79, 0.69, 0.74][i % 3];
    let C = 0.17;
    let lin = oklchToLinear(L, C, hue);
    while (C > 0 && lin.some((v) => v < -1e-4 || v > 1 + 1e-4)) {
      C -= 0.005;
      lin = oklchToLinear(L, C, hue);
    }
    const hex = '#' + lin.map((v) => Math.round(gammaEncode(v) * 255).toString(16).padStart(2, '0')).join('');
    const Y = 0.2126 * clamp(lin[0], 0, 1) + 0.7152 * clamp(lin[1], 0, 1) + 0.0722 * clamp(lin[2], 0, 1);
    const contrastDark = (Y + 0.05) / (0.0087 + 0.05);
    const contrastLight = 1.05 / (Y + 0.05);
    paletteCache[i] = { hex, ink: contrastDark >= contrastLight ? '#171a26' : '#ffffff' };
    return paletteCache[i];
  }

  // 既存の割り当てはなるべく維持し、新しい文字列には空いている一番小さい番号を割り当てる
  function assignColors(uniqueLabels) {
    const next = new Map();
    const taken = new Set();
    for (const label of uniqueLabels) {
      const idx = colorIndex.get(label);
      if (idx !== undefined && !taken.has(idx)) {
        next.set(label, idx);
        taken.add(idx);
      }
    }
    let free = 0;
    for (const label of uniqueLabels) {
      if (next.has(label)) continue;
      while (taken.has(free)) free++;
      next.set(label, free);
      taken.add(free);
    }
    colorIndex = next;
  }

  /* ------------------------------------------------------------------ */
  /* 項目                                                                 */
  /* ------------------------------------------------------------------ */

  function splitLines(text) {
    return text.split(/\r\n|\r|\n/);
  }

  function parseItems() {
    const list = [];
    const unique = [];
    const seen = new Set();
    splitLines(el.input.value).forEach((raw, line) => {
      const label = raw.trim();
      if (!label) return;
      if (!seen.has(label)) {
        seen.add(label);
        unique.push(label);
      }
      list.push({ label, line });
    });
    assignColors(unique);
    items = list.map((it) => {
      const c = paletteColor(colorIndex.get(it.label));
      return { ...it, color: c.hex, ink: c.ink };
    });

    const kinds = unique.length;
    el.itemCount.textContent = items.length
      ? `${items.length} 項目` + (kinds !== items.length ? `（${kinds} 種類）` : '')
      : '0 項目';
  }

  function onItemsChanged() {
    parseItems();
    if (!items.length && spin.active) {
      spin.active = false;
      spin.rpm = 0;
      Sound.stopRoll();
    }
    spin.boundary = boundaryIndex();
    wheel.rebuild();
    saveSoon();
  }

  function shuffleItems() {
    const lines = splitLines(el.input.value).filter((l) => l.trim());
    for (let i = lines.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [lines[i], lines[j]] = [lines[j], lines[i]];
    }
    el.input.value = lines.join('\n');
    onItemsChanged();
  }

  function removeResult(res, all) {
    if (!res) return;
    const prev = el.input.value;
    let lines = splitLines(prev);
    let removed = 0;
    if (all) {
      const kept = lines.filter((l) => l.trim() !== res.label);
      removed = lines.length - kept.length;
      lines = kept;
    } else {
      let idx = lines[res.line] !== undefined && lines[res.line].trim() === res.label ? res.line : -1;
      if (idx < 0) idx = lines.findIndex((l) => l.trim() === res.label);
      if (idx >= 0) {
        lines.splice(idx, 1);
        removed = 1;
      }
    }
    if (!removed) return;
    el.input.value = lines.join('\n');
    onItemsChanged();
    const what = all && removed > 1 ? `「${res.label}」を${removed}件除外しました` : `「${res.label}」を除外しました`;
    showToast(what, () => {
      el.input.value = prev;
      onItemsChanged();
    });
  }

  /* ------------------------------------------------------------------ */
  /* 回転の物理                                                            */
  /* ------------------------------------------------------------------ */

  // 摩擦：dω/dt = -(a + b·ω)
  //   a … 一定の減速（rpm/秒）、b … 速いほど強くかかる減速
  function frictionCoeffs() {
    const f = settings.friction;
    return { a: f * 1.2, b: f * 0.01 };
  }

  function timeToStop() {
    const { a, b } = frictionCoeffs();
    if (spin.rpm <= 0) return 0;
    if (a <= 0) return Infinity;
    if (b <= 1e-9) return spin.rpm / a;
    return Math.log(1 + (b * spin.rpm) / a) / b;
  }

  // 最高速度（0 は無制限）
  function speedCap() {
    return settings.maxSpeed > 0 ? settings.maxSpeed : BIG;
  }

  function segAngle() {
    return items.length ? TAU / items.length : TAU;
  }

  function boundaryIndex() {
    return items.length ? Math.floor(spin.angle / segAngle()) : 0;
  }

  // 針（真上）が指している項目の番号
  function pointerIndex() {
    const n = items.length;
    if (!n) return -1;
    const local = (((-spin.angle) % TAU) + TAU) % TAU;
    return Math.min(n - 1, Math.floor(local / segAngle()));
  }

  function impulse(kind, now) {
    if (modalOpen || now < spin.lockedUntil) return;

    if (kind === 'accel') {
      if (!items.length) {
        flashStatus('先に項目を入力してください');
        return;
      }
      spin.rpm = Math.min(speedCap(), spin.rpm + settings.accel);
      if (!spin.active) {
        spin.active = true;
        spin.everSpun = true;
        spin.boundary = boundaryIndex();
        fx.celebrateUntil = 0;
      }
      spin.lastAccelAt = now;
      fx.flash = 1;
      Sound.boost();
    } else {
      if (!spin.active) return;
      spin.rpm = Math.max(0, spin.rpm - settings.brake);
      Sound.brake();
      if (spin.rpm <= 0) finishSpin(now);
    }
  }

  function finishSpin(now) {
    spin.active = false;
    spin.rpm = 0;
    Sound.stopRoll();

    const idx = pointerIndex();
    if (idx < 0) return;
    const it = items[idx];
    const entry = {
      n: (history.length ? history[0].n || history.length : 0) + 1,
      label: it.label,
      color: it.color,
      ink: it.ink,
      at: Date.now(),
    };
    history.unshift(entry);
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    renderHistory();
    saveState();

    lastResult = { ...it, entry };
    fx.celebrateUntil = now + 3.2;
    spin.lockedUntil = now + RESULT_DELAY / 1000;
    Sound.result();
    releaseAll();
    setTimeout(() => openResult(lastResult), RESULT_DELAY);
  }

  /* ------------------------------------------------------------------ */
  /* 入力（クリック・長押し・キーボード）                                      */
  /* ------------------------------------------------------------------ */

  const holds = {
    accel: { count: 0, since: 0, acc: 0 },
    brake: { count: 0, since: 0, acc: 0 },
  };

  function press(kind) {
    Sound.unlock();
    const now = nowSec();
    const h = holds[kind];
    if (h.count === 0) {
      h.since = now;
      h.acc = 0;
    }
    h.count++;
    impulse(kind, now);
    syncPressedUI();
  }

  function release(kind) {
    const h = holds[kind];
    h.count = Math.max(0, h.count - 1);
    syncPressedUI();
  }

  function releaseAll() {
    holds.accel.count = 0;
    holds.brake.count = 0;
    wheelPointers.clear();
    buttonPointers.clear();
    heldKeys.clear();
    syncPressedUI();
  }

  function syncPressedUI() {
    el.btnAccel.classList.toggle('is-pressed', holds.accel.count > 0);
    el.btnBrake.classList.toggle('is-pressed', holds.brake.count > 0);
  }

  // 盤：左ボタン = 加速、右ボタン = 減速（同時押しにも対応）
  const wheelPointers = new Map();
  function onWheelPointer(e) {
    const ended = e.type === 'pointerup' || e.type === 'pointercancel' || e.type === 'lostpointercapture';
    const prev = wheelPointers.get(e.pointerId) || 0;
    const cur = ended ? 0 : e.buttons & 3;
    if (e.type === 'pointerdown') {
      e.preventDefault();
      // ボタン等にフォーカスが残っているとキー操作が効かないので外す
      const active = document.activeElement;
      if (active && active !== document.body && active !== el.wrap && active.blur) active.blur();
      try { el.wrap.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    }
    if (cur === prev) return;
    const pressed = cur & ~prev;
    const released = prev & ~cur;
    if (cur) wheelPointers.set(e.pointerId, cur);
    else wheelPointers.delete(e.pointerId);
    if (pressed & 1) press('accel');
    if (pressed & 2) press('brake');
    if (released & 1) release('accel');
    if (released & 2) release('brake');
  }

  ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture'].forEach((type) => {
    el.wrap.addEventListener(type, onWheelPointer);
  });
  el.wrap.addEventListener('contextmenu', (e) => e.preventDefault());

  // 画面下の「加速」「減速」ボタン（タッチ向け）
  const buttonPointers = new Map();
  function bindHoldButton(btn, kind) {
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { btn.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
      buttonPointers.set(e.pointerId, kind);
      press(kind);
    });
    const end = (e) => {
      if (buttonPointers.get(e.pointerId) !== kind) return;
      buttonPointers.delete(e.pointerId);
      release(kind);
    };
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) => btn.addEventListener(t, end));
    btn.addEventListener('click', (e) => {
      // キーボード（Enter / Space）で押されたとき
      if (e.detail === 0) {
        press(kind);
        release(kind);
      }
    });
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  bindHoldButton(el.btnAccel, 'accel');
  bindHoldButton(el.btnBrake, 'brake');

  // キーボード：Space / ↑ / Enter = 加速、↓ = 減速
  const heldKeys = new Map();
  function keyKind(e) {
    if (e.code === 'Space' || e.key === 'ArrowUp') return 'accel';
    if (e.key === 'Enter' && e.target === el.wrap) return 'accel';
    if (e.key === 'ArrowDown') return 'brake';
    return null;
  }
  function isFormTarget(t) {
    return !!(t && t.closest && t.closest('input, textarea, select, button, [contenteditable], [role="tab"], .modal'));
  }
  document.addEventListener('keydown', (e) => {
    if (modalOpen) {
      if (e.key === 'Escape') closeResult('close');
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || isFormTarget(e.target)) return;
    const kind = keyKind(e);
    if (!kind) return;
    e.preventDefault();
    if (e.repeat || heldKeys.has(e.code)) return;
    heldKeys.set(e.code, kind);
    press(kind);
  });
  document.addEventListener('keyup', (e) => {
    const kind = heldKeys.get(e.code);
    if (!kind) return;
    heldKeys.delete(e.code);
    release(kind);
  });

  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      releaseAll();
      Sound.suspend();
    } else {
      Sound.resume();
    }
  });

  // 最初の操作で音を有効化（ブラウザの自動再生制限）
  const unlockOnce = () => Sound.unlock();
  ['pointerdown', 'keydown', 'touchend'].forEach((t) => document.addEventListener(t, unlockOnce, { passive: true }));

  /* ------------------------------------------------------------------ */
  /* 盤の描画                                                              */
  /* ------------------------------------------------------------------ */

  const wheel = (() => {
    const canvas = el.canvas;
    const g = canvas.getContext('2d');
    const BULBS = 28;
    let S = 0;      // キャンバスの一辺（デバイスピクセル）
    let dpr = 1;
    let cx = 0;
    let cy = 0;
    let R = 0;      // 外枠の半径
    let Rf = 0;     // 盤面の半径
    let back = null;
    let front = null;
    let face = null;
    let spun = null;   // 超高速時用：色が混ざって見える盤
    let bulbOn = null;
    let bulbOff = null;
    let bulbR = 0;
    let visStep = 0;   // 1フレームあたりの回転角（平滑化）

    // この角度（ラジアン/フレーム）を超えたあたりから、混ざった盤へ切り替えていく
    const BLEND_START = 0.7;
    const BLEND_END = 2.4;

    const LABEL_FONT = '"Zen Kaku Gothic New", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", sans-serif';

    function makeCanvas(w, h) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.ceil(w));
      c.height = Math.max(1, Math.ceil(h));
      return c;
    }

    function resize() {
      const css = Math.floor(el.wrap.clientWidth);
      if (!css) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const px = Math.round(css * dpr);
      if (px === S) return;
      S = px;
      canvas.width = S;
      canvas.height = S;
      cx = S / 2;
      cy = S * 0.525;
      R = S * 0.445;
      Rf = R * 0.885;
      buildStatic();
      rebuild();
    }

    function buildStatic() {
      // 影
      back = makeCanvas(S, S);
      const b = back.getContext('2d');
      b.save();
      b.shadowColor = 'rgba(0, 0, 0, 0.38)';
      b.shadowBlur = R * 0.09;
      b.shadowOffsetY = R * 0.045;
      b.fillStyle = '#3a2a0c';
      b.beginPath();
      b.arc(cx, cy, R, 0, TAU);
      b.fill();
      b.restore();

      // 真鍮の外枠・ツヤ・中心のハブ
      front = makeCanvas(S, S);
      const f = front.getContext('2d');

      const rim = f.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
      rim.addColorStop(0, '#f7df97');
      rim.addColorStop(0.28, '#dcab48');
      rim.addColorStop(0.55, '#9c6d1b');
      rim.addColorStop(0.78, '#d7a745');
      rim.addColorStop(1, '#7a5313');
      f.beginPath();
      f.arc(cx, cy, R, 0, TAU);
      f.arc(cx, cy, Rf, 0, TAU, true);
      f.fillStyle = rim;
      f.fill('evenodd');

      f.lineWidth = Math.max(1, R * 0.007);
      f.strokeStyle = 'rgba(70, 45, 5, 0.65)';
      f.beginPath();
      f.arc(cx, cy, R - f.lineWidth / 2, 0, TAU);
      f.stroke();
      f.beginPath();
      f.arc(cx, cy, Rf, 0, TAU);
      f.stroke();

      // 盤面のふちの陰り
      const edge = f.createRadialGradient(cx, cy, Rf * 0.86, cx, cy, Rf);
      edge.addColorStop(0, 'rgba(0, 0, 0, 0)');
      edge.addColorStop(1, 'rgba(0, 0, 0, 0.26)');
      f.fillStyle = edge;
      f.beginPath();
      f.arc(cx, cy, Rf, 0, TAU);
      f.fill();

      // ツヤ
      const gloss = f.createRadialGradient(cx - Rf * 0.38, cy - Rf * 0.48, Rf * 0.04, cx - Rf * 0.2, cy - Rf * 0.3, Rf * 1.05);
      gloss.addColorStop(0, 'rgba(255, 255, 255, 0.24)');
      gloss.addColorStop(0.45, 'rgba(255, 255, 255, 0.06)');
      gloss.addColorStop(1, 'rgba(255, 255, 255, 0)');
      f.fillStyle = gloss;
      f.beginPath();
      f.arc(cx, cy, Rf, 0, TAU);
      f.fill();

      // 電球のソケット
      bulbR = (R - Rf) * 0.27;
      const ringR = (R + Rf) / 2;
      for (let i = 0; i < BULBS; i++) {
        const a = (i / BULBS) * TAU - Math.PI / 2;
        const x = cx + Math.cos(a) * ringR;
        const y = cy + Math.sin(a) * ringR;
        f.beginPath();
        f.arc(x, y, bulbR * 1.35, 0, TAU);
        f.fillStyle = 'rgba(60, 38, 4, 0.55)';
        f.fill();
      }

      // ハブ
      const hr = R * 0.13;
      f.save();
      f.shadowColor = 'rgba(0, 0, 0, 0.4)';
      f.shadowBlur = R * 0.04;
      f.shadowOffsetY = R * 0.015;
      const hub = f.createRadialGradient(cx - hr * 0.35, cy - hr * 0.45, hr * 0.1, cx, cy, hr);
      hub.addColorStop(0, '#fbebb6');
      hub.addColorStop(0.5, '#d9a845');
      hub.addColorStop(1, '#8a6118');
      f.fillStyle = hub;
      f.beginPath();
      f.arc(cx, cy, hr, 0, TAU);
      f.fill();
      f.restore();
      f.lineWidth = Math.max(1, R * 0.006);
      f.strokeStyle = 'rgba(70, 45, 5, 0.7)';
      f.beginPath();
      f.arc(cx, cy, hr, 0, TAU);
      f.stroke();
      f.beginPath();
      f.arc(cx, cy, hr * 0.62, 0, TAU);
      f.strokeStyle = 'rgba(90, 60, 10, 0.45)';
      f.stroke();
      const bolt = f.createRadialGradient(cx - hr * 0.08, cy - hr * 0.1, 0, cx, cy, hr * 0.22);
      bolt.addColorStop(0, '#fff6d6');
      bolt.addColorStop(1, '#a87a22');
      f.fillStyle = bolt;
      f.beginPath();
      f.arc(cx, cy, hr * 0.2, 0, TAU);
      f.fill();

      // 電球のスプライト
      const sz = bulbR * 6;
      bulbOn = makeCanvas(sz, sz);
      const on = bulbOn.getContext('2d');
      const halo = on.createRadialGradient(sz / 2, sz / 2, 0, sz / 2, sz / 2, sz / 2);
      halo.addColorStop(0, 'rgba(255, 236, 170, 0.95)');
      halo.addColorStop(0.18, 'rgba(255, 214, 110, 0.75)');
      halo.addColorStop(0.45, 'rgba(255, 190, 70, 0.22)');
      halo.addColorStop(1, 'rgba(255, 180, 60, 0)');
      on.fillStyle = halo;
      on.fillRect(0, 0, sz, sz);
      on.beginPath();
      on.arc(sz / 2, sz / 2, bulbR, 0, TAU);
      on.fillStyle = '#fff7dc';
      on.fill();

      bulbOff = makeCanvas(sz, sz);
      const off = bulbOff.getContext('2d');
      const dim = off.createRadialGradient(sz / 2 - bulbR * 0.3, sz / 2 - bulbR * 0.35, 0, sz / 2, sz / 2, bulbR);
      dim.addColorStop(0, '#f3dfa6');
      dim.addColorStop(1, '#8c6a2a');
      off.beginPath();
      off.arc(sz / 2, sz / 2, bulbR, 0, TAU);
      off.fillStyle = dim;
      off.fill();
    }

    function ellipsize(c, text, maxW) {
      if (c.measureText(text).width <= maxW) return text;
      const chars = Array.from(text);
      let lo = 0;
      let hi = chars.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (c.measureText(chars.slice(0, mid).join('') + '…').width <= maxW) lo = mid;
        else hi = mid - 1;
      }
      return chars.slice(0, lo).join('') + '…';
    }

    // 回転する盤面（項目が変わったときだけ描き直す）
    function rebuild() {
      if (!S) return;
      const size = Math.ceil(Rf * 2) + 4;
      spun = null;
      face = makeCanvas(size, size);
      const c = face.getContext('2d');
      const o = size / 2;
      const n = items.length;

      if (!n) {
        c.beginPath();
        c.arc(o, o, Rf, 0, TAU);
        c.fillStyle = '#d9dde6';
        c.fill();
        c.strokeStyle = 'rgba(255, 255, 255, 0.7)';
        c.lineWidth = Math.max(1, Rf * 0.006);
        c.setLineDash([Rf * 0.03, Rf * 0.03]);
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * TAU;
          c.beginPath();
          c.moveTo(o, o);
          c.lineTo(o + Math.cos(a) * Rf, o + Math.sin(a) * Rf);
          c.stroke();
        }
        c.setLineDash([]);
        c.fillStyle = '#5a6277';
        c.font = `700 ${Math.round(Rf * 0.075)}px ${LABEL_FONT}`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText('項目を入力してください', o, o - Rf * 0.45);
        return;
      }

      const seg = TAU / n;
      for (let i = 0; i < n; i++) {
        c.beginPath();
        c.moveTo(o, o);
        c.arc(o, o, Rf, -Math.PI / 2 + i * seg, -Math.PI / 2 + (i + 1) * seg);
        c.closePath();
        c.fillStyle = items[i].color;
        c.fill();
      }

      // 中心に向かって少し明るく
      const shade = c.createRadialGradient(o, o, Rf * 0.1, o, o, Rf);
      shade.addColorStop(0, 'rgba(255, 255, 255, 0.16)');
      shade.addColorStop(0.7, 'rgba(255, 255, 255, 0)');
      shade.addColorStop(1, 'rgba(0, 0, 0, 0.06)');
      c.fillStyle = shade;
      c.beginPath();
      c.arc(o, o, Rf, 0, TAU);
      c.fill();

      // 区切り線（同じ色が隣り合っても見分けられるように）
      if (n > 1) {
        c.strokeStyle = 'rgba(255, 255, 255, 0.92)';
        c.lineWidth = Math.max(1, Rf * (n > 60 ? 0.003 : 0.006));
        c.beginPath();
        for (let i = 0; i < n; i++) {
          const a = -Math.PI / 2 + i * seg;
          c.moveTo(o, o);
          c.lineTo(o + Math.cos(a) * Rf, o + Math.sin(a) * Rf);
        }
        c.stroke();
      }

      // 文字
      const fs = Math.min(Rf * 0.085, seg * Rf * 0.6 * 0.78);
      if (fs >= 7 * dpr) {
        c.font = `700 ${fs}px ${LABEL_FONT}`;
        c.textAlign = 'right';
        c.textBaseline = 'middle';
        const maxW = Rf * 0.6;
        for (let i = 0; i < n; i++) {
          const a = -Math.PI / 2 + (i + 0.5) * seg;
          c.save();
          c.translate(o, o);
          c.rotate(a);
          c.fillStyle = items[i].ink;
          c.fillText(ellipsize(c, items[i].label, maxW), Rf * 0.86, 0);
          c.restore();
        }
      }

      // ピン（針がはじく真鍮の釘）
      const pegR = Math.max(1.5 * dpr, Rf * 0.016);
      const showPegs = seg * Rf > pegR * 3.2;
      if (showPegs) {
        const pr = Rf * 0.955;
        for (let i = 0; i < n; i++) {
          const a = -Math.PI / 2 + i * seg;
          const x = o + Math.cos(a) * pr;
          const y = o + Math.sin(a) * pr;
          const pg = c.createRadialGradient(x - pegR * 0.35, y - pegR * 0.35, 0, x, y, pegR);
          pg.addColorStop(0, '#fff3c8');
          pg.addColorStop(1, '#a37520');
          c.beginPath();
          c.arc(x, y, pegR, 0, TAU);
          c.fillStyle = pg;
          c.fill();
          c.lineWidth = Math.max(1, pegR * 0.25);
          c.strokeStyle = 'rgba(60, 40, 5, 0.55)';
          c.stroke();
        }
      }

      // 超高速時用：全部の色が混ざり合った盤（色は光として平均する）
      spun = makeCanvas(size, size);
      const sc = spun.getContext('2d');
      const sum = [0, 0, 0];
      items.forEach((it) => {
        const l = hexToLinear(it.color);
        sum[0] += l[0];
        sum[1] += l[1];
        sum[2] += l[2];
      });
      const avg = '#' + sum.map((v) => Math.round(gammaEncode(v / n) * 255).toString(16).padStart(2, '0')).join('');
      sc.beginPath();
      sc.arc(o, o, Rf, 0, TAU);
      sc.fillStyle = avg;
      sc.fill();
      // 区切り線が集まる中心は明るく、文字が溶けた帯はわずかに暗く
      const blend = sc.createRadialGradient(o, o, Rf * 0.08, o, o, Rf);
      blend.addColorStop(0, 'rgba(255, 255, 255, 0.38)');
      blend.addColorStop(0.3, 'rgba(255, 255, 255, 0.08)');
      blend.addColorStop(0.6, 'rgba(0, 0, 0, 0.05)');
      blend.addColorStop(0.88, 'rgba(0, 0, 0, 0.02)');
      blend.addColorStop(1, 'rgba(0, 0, 0, 0.06)');
      sc.fillStyle = blend;
      sc.beginPath();
      sc.arc(o, o, Rf, 0, TAU);
      sc.fill();
      if (showPegs) {
        // ピンが溶けて真鍮色の輪に見える
        sc.beginPath();
        sc.arc(o, o, Rf * 0.955, 0, TAU);
        sc.lineWidth = pegR * 2;
        sc.strokeStyle = `rgba(214, 170, 80, ${Math.min(0.75, (n * pegR * 2) / (TAU * Rf * 0.955) + 0.1).toFixed(3)})`;
        sc.stroke();
      }
    }

    function bulbLevel(i, now) {
      let lv;
      if (now < fx.celebrateUntil) {
        lv = (Math.floor(now * 7) + i) % 2 ? 1 : 0.12;
      } else if (spin.active) {
        const k = (((i - Math.floor(fx.bulbPhase)) % 4) + 4) % 4;
        lv = k === 0 ? 1 : k === 1 ? 0.45 : 0.1;
      } else {
        const breathe = 0.5 + 0.5 * Math.sin(now * 1.7 + (i % 2) * Math.PI);
        lv = 0.15 + 0.5 * breathe;
      }
      return Math.max(lv, fx.flash * 0.9);
    }

    function drawBulbs(now) {
      const ringR = (R + Rf) / 2;
      const half = bulbOn.width / 2;
      for (let i = 0; i < BULBS; i++) {
        const a = (i / BULBS) * TAU - Math.PI / 2;
        const x = cx + Math.cos(a) * ringR - half;
        const y = cy + Math.sin(a) * ringR - half;
        g.globalAlpha = 1;
        g.drawImage(bulbOff, x, y);
        g.globalAlpha = bulbLevel(i, now);
        g.drawImage(bulbOn, x, y);
      }
      g.globalAlpha = 1;
    }

    function drawPointer() {
      const L = R * 0.21;
      const w = R * 0.072;
      g.save();
      g.translate(cx, cy - R * 1.0);
      g.rotate(-fx.flap);

      g.shadowColor = 'rgba(0, 0, 0, 0.35)';
      g.shadowBlur = R * 0.03;
      g.shadowOffsetY = R * 0.015;
      g.beginPath();
      g.moveTo(0, L);
      g.bezierCurveTo(w * 0.45, L * 0.6, w, L * 0.2, w, 0);
      g.arc(0, 0, w, 0, Math.PI, true);
      g.bezierCurveTo(-w, L * 0.2, -w * 0.45, L * 0.6, 0, L);
      g.closePath();
      const body = g.createLinearGradient(-w, 0, w, 0);
      body.addColorStop(0, '#ff7a63');
      body.addColorStop(0.45, '#d4321f');
      body.addColorStop(1, '#8c1a0f');
      g.fillStyle = body;
      g.fill();
      g.shadowColor = 'transparent';
      g.lineWidth = Math.max(1, R * 0.006);
      g.strokeStyle = 'rgba(70, 8, 2, 0.6)';
      g.stroke();

      const pv = g.createRadialGradient(-w * 0.15, -w * 0.18, 0, 0, 0, w * 0.48);
      pv.addColorStop(0, '#fff3c8');
      pv.addColorStop(1, '#a37520');
      g.beginPath();
      g.arc(0, 0, w * 0.46, 0, TAU);
      g.fillStyle = pv;
      g.fill();
      g.strokeStyle = 'rgba(70, 45, 5, 0.7)';
      g.stroke();
      g.restore();
    }

    function draw(now, dt) {
      if (!S || !face) return;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, S, S);
      g.drawImage(back, 0, 0);

      // 1フレームで回る角度。フレーム間隔のゆらぎで見た目がちらつかないよう平滑化
      const raw = Math.min(BLEND_END * 2, (spin.rpm / 60) * TAU * Math.min(dt, 1 / 30));
      visStep = spin.active ? visStep + (raw - visStep) * 0.25 : 0;
      const step = visStep;
      const mix = spun ? clamp((step - BLEND_START) / (BLEND_END - BLEND_START), 0, 1) : 0;
      const half = face.width / 2;

      // 速いときはモーションブラー（数枚を少しずつずらして重ねる）
      if (mix < 1) {
        const span = Math.min(step, BLEND_END);
        const layers = span > 0.03 ? Math.min(16, Math.ceil(span / 0.025)) : 1;
        for (let k = 0; k < layers; k++) {
          g.globalAlpha = 1 / (k + 1);
          g.setTransform(1, 0, 0, 1, cx, cy);
          g.rotate(spin.angle - (span * k) / layers);
          g.drawImage(face, -half, -half);
        }
      }
      // さらに速いと色が混ざった盤に切り替え、ストロボのようなちらつきを少し重ねる
      if (mix > 0) {
        g.setTransform(1, 0, 0, 1, cx, cy);
        g.globalAlpha = mix;
        g.drawImage(spun, -half, -half);
        g.globalAlpha = 0.16 * mix;
        g.rotate(Math.random() * TAU);
        g.drawImage(face, -half, -half);
      }
      g.globalAlpha = 1;
      g.setTransform(1, 0, 0, 1, 0, 0);

      g.drawImage(front, 0, 0);
      drawBulbs(now);
      drawPointer();
    }

    return { resize, rebuild, draw };
  })();

  /* ------------------------------------------------------------------ */
  /* メインループ                                                          */
  /* ------------------------------------------------------------------ */

  let lastFrame = performance.now();
  let lastNowKey = '';
  let lastRpmText = '';
  let lastState = '';
  let lastStatus = '';

  function step(now, dt) {
    // 長押しの連打
    for (const kind of ['accel', 'brake']) {
      const h = holds[kind];
      if (h.count > 0 && settings.holdEnabled && now - h.since >= HOLD_DELAY) {
        h.acc += dt * settings.holdRate;
        while (h.acc >= 1) {
          h.acc -= 1;
          impulse(kind, now);
        }
      }
    }

    if (spin.active) {
      const cap = speedCap();
      if (spin.rpm > cap) spin.rpm = cap;
      const { a, b } = frictionCoeffs();
      spin.rpm = Math.max(0, spin.rpm - (a + b * spin.rpm) * dt);

      // 角度は 0〜2π に収める。とんでもなく速いときは「何回転＋どこまで」の端数が
      // 計算の精度を超えるので、そのフレームで止まって見える位置はランダムにする
      const revs = (spin.rpm / 60) * dt;
      const frac = revs < 2 ** 40 ? revs % 1 : Math.random();
      spin.angle = (((spin.angle + frac * TAU) % TAU) + TAU) % TAU;

      // 針がピンを越えた（1フレームで1区画以上回ったときも含む）
      const bi = boundaryIndex();
      const crossed = bi !== spin.boundary || revs * items.length >= 1;
      spin.boundary = bi;
      if (crossed) {
        fx.flap = Math.min(0.42, fx.flap + 0.3);
        if (fx.flapV < 0) fx.flapV = 0;
        Sound.tick(spin.rpm / SOUND_REF_RPM);
      }

      // 止まる直前のドラムロール
      const tts = timeToStop();
      const wantRoll = spin.rpm > 0 && tts <= ROLL_WINDOW && now - spin.lastAccelAt > 0.35;
      if (wantRoll) {
        Sound.setRollIntensity(1 - tts / ROLL_WINDOW);
        if (!Sound.rolling) Sound.startRoll();
      } else if (Sound.rolling) {
        Sound.stopRoll();
      }

      if (spin.rpm <= 0) finishSpin(now);
    }

    // 針のばね
    const sub = 4;
    for (let i = 0; i < sub; i++) {
      const h = dt / sub;
      const acc = -520 * fx.flap - 18 * fx.flapV;
      fx.flapV += acc * h;
      fx.flap += fx.flapV * h;
    }

    fx.flash = Math.max(0, fx.flash - dt * 3.5);
    fx.bulbPhase = (fx.bulbPhase + Math.min(spin.rpm, 600) * dt * 0.06) % 4;

    const tickRate = items.length ? (spin.rpm / 60) * items.length : 0;
    Sound.update(Math.min(1, spin.rpm / SOUND_REF_RPM), tickRate, spin.active);
  }

  function updateHud(now) {
    // 針の位置
    const idx = pointerIndex();
    const it = idx >= 0 ? items[idx] : null;
    const key = it ? it.label + '\u0000' + it.color : '';
    if (key !== lastNowKey) {
      lastNowKey = key;
      el.nowValue.textContent = it ? it.label : '—';
      el.nowChip.style.background = it ? it.color : '';
    }

    // 速度計
    const rpmText = formatRpm(spin.rpm);
    if (rpmText !== lastRpmText) {
      lastRpmText = rpmText;
      el.rpmValue.textContent = rpmText;
      el.rpmValue.classList.toggle('is-long', rpmText.length > 5);
      // 最高速度が無制限のときは対数目盛り（1万 rpm で満タン）
      const ratio = settings.maxSpeed > 0 ? spin.rpm / settings.maxSpeed : Math.log10(1 + spin.rpm) / 4;
      el.rpmFill.style.width = `${clamp(ratio * 100, 0, 100)}%`;
    }

    let state;
    if (!spin.active) state = spin.everSpun ? '停止' : '待機中';
    else if (Sound.rolling || timeToStop() <= ROLL_WINDOW) state = 'まもなく停止';
    else if (now - spin.lastAccelAt < 0.6) state = '加速中';
    else state = settings.friction > 0 ? '減速中' : '回転中';
    if (state !== lastState) {
      lastState = state;
      el.stateLabel.textContent = state;
    }

    let status;
    if (now < tempStatus.until) status = tempStatus.text;
    else if (!items.length) status = touchOnly.matches ? '下の欄に項目を入力してください' : '右の欄に項目を入力してください';
    else if (spin.active) status = touchOnly.matches ? '盤をタップで加速 · 減速ボタンでブレーキ' : '左クリックで加速 · 右クリックで減速';
    else if (lastResult && spin.everSpun) status = `結果：${lastResult.label}　もう一度回すには盤をクリック`;
    else status = touchOnly.matches ? '盤をタップしてスタート' : '盤を左クリックしてスタート';
    if (status !== lastStatus) {
      lastStatus = status;
      el.status.textContent = status;
    }
  }

  const fmtInt = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });
  const fmtCompact = new Intl.NumberFormat('ja-JP', { notation: 'compact', maximumFractionDigits: 1 });
  function formatRpm(v) {
    if (v < 1e5) return fmtInt.format(Math.round(v));   // 12,345
    if (v < 1e20) return fmtCompact.format(v);           // 12.3万 / 4.5億 / 6.7兆 / 8.9京
    return v.toExponential(1).replace('e+', 'e');        // 1.2e25
  }

  function flashStatus(text) {
    tempStatus = { text, until: nowSec() + 2.2 };
  }

  function frame(ts) {
    let dt = (ts - lastFrame) / 1000;
    lastFrame = ts;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.05) dt = 0.05;
    const now = ts / 1000;
    step(now, dt);
    wheel.draw(now, dt);
    updateHud(now);
    requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------------------ */
  /* 結果ポップアップ                                                       */
  /* ------------------------------------------------------------------ */

  function openResult(res) {
    if (!res) return;
    modalOpen = true;
    releaseAll();
    el.resultBand.style.setProperty('--c', res.color);
    el.resultBand.style.setProperty('--t', res.ink);
    el.resultTitle.textContent = res.label;
    el.resultMeta.textContent = `第 ${res.entry.n} 回の結果`;
    const dup = items.filter((x) => x.label === res.label).length;
    el.btnRemoveOne.hidden = settings.autoRemove;
    el.btnRemoveAll.hidden = settings.autoRemove || dup < 2;
    el.resultNote.hidden = !settings.autoRemove;
    el.modal.hidden = false;
    el.btnCloseResult.focus({ preventScroll: true });

    const others = items.slice(0, 6).map((x) => x.color);
    confetti.burst([res.color, res.color, '#d9a845', '#fff3c8', ...others]);
  }

  function closeResult(action) {
    if (!modalOpen) return;
    modalOpen = false;
    el.modal.hidden = true;
    if (action === 'one' || (action === 'close' && settings.autoRemove)) removeResult(lastResult, false);
    else if (action === 'all') removeResult(lastResult, true);
    if (usingKeyboard) el.wrap.focus({ preventScroll: true });
    else if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  // キーボード操作中かどうか（ポップアップを閉じた後のフォーカス先に使う）
  let usingKeyboard = false;
  document.addEventListener('keydown', () => { usingKeyboard = true; }, true);
  document.addEventListener('pointerdown', () => { usingKeyboard = false; }, true);

  el.modal.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeResult('close');
  });
  el.modal.addEventListener('contextmenu', (e) => e.preventDefault());
  el.btnRemoveOne.addEventListener('click', () => closeResult('one'));
  el.btnRemoveAll.addEventListener('click', () => closeResult('all'));

  // フォーカスをポップアップ内に留める
  el.modal.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusables = [...el.modal.querySelectorAll('button:not([hidden])')];
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  /* ------------------------------------------------------------------ */
  /* 紙吹雪                                                               */
  /* ------------------------------------------------------------------ */

  const confetti = (() => {
    const cv = el.confetti;
    const g = cv.getContext('2d');
    let parts = [];
    let running = false;
    let W = 0;
    let H = 0;
    let dpr = 1;
    let last = 0;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth;
      H = window.innerHeight;
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }

    function burst(colors) {
      if (reduceMotion.matches) return;
      resize();
      const count = Math.min(220, Math.round(W / 6) + 80);
      for (let i = 0; i < count; i++) {
        const fromLeft = i % 2 === 0;
        const ang = fromLeft ? -Math.PI / 2 + Math.random() * 0.9 : -Math.PI / 2 - Math.random() * 0.9;
        const sp = 500 + Math.random() * 700;
        parts.push({
          x: fromLeft ? W * 0.12 : W * 0.88,
          y: H + 10,
          vx: Math.cos(ang) * sp * (0.6 + Math.random() * 0.5),
          vy: Math.sin(ang) * sp * (1 + Math.random() * 0.5) - 200,
          w: 7 + Math.random() * 7,
          h: 4 + Math.random() * 5,
          rot: Math.random() * TAU,
          vr: (Math.random() - 0.5) * 12,
          flip: Math.random() * TAU,
          vf: 6 + Math.random() * 8,
          color: colors[Math.floor(Math.random() * colors.length)],
          life: 0,
          max: 3 + Math.random() * 1.5,
        });
      }
      if (!running) {
        running = true;
        last = performance.now();
        requestAnimationFrame(tick);
      }
    }

    function tick(ts) {
      const dt = Math.min(0.05, (ts - last) / 1000);
      last = ts;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      parts = parts.filter((p) => p.life < p.max && p.y < H + 60);
      for (const p of parts) {
        p.life += dt;
        p.vx *= 1 - 1.1 * dt;
        p.vy = p.vy * (1 - 1.1 * dt) + 900 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        p.flip += p.vf * dt;
        const fade = Math.min(1, (p.max - p.life) / 0.6);
        g.save();
        g.globalAlpha = fade;
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        g.scale(1, Math.cos(p.flip));
        g.fillStyle = p.color;
        g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        g.restore();
      }
      if (parts.length) {
        requestAnimationFrame(tick);
      } else {
        running = false;
        g.clearRect(0, 0, W, H);
      }
    }

    return { burst };
  })();

  /* ------------------------------------------------------------------ */
  /* トースト（元に戻す）                                                    */
  /* ------------------------------------------------------------------ */

  let toastTimer = 0;
  let toastUndo = null;
  function showToast(text, undo) {
    el.toastText.textContent = text;
    toastUndo = undo || null;
    el.toastUndo.hidden = !undo;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 6000);
  }
  function hideToast() {
    el.toast.hidden = true;
    toastUndo = null;
  }
  el.toastUndo.addEventListener('click', () => {
    const fn = toastUndo;
    hideToast();
    if (fn) fn();
  });

  /* ------------------------------------------------------------------ */
  /* 履歴                                                                 */
  /* ------------------------------------------------------------------ */

  const pad = (n) => String(n).padStart(2, '0');
  function formatTime(ts) {
    const d = new Date(ts);
    const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return t;
    return `${d.getMonth() + 1}/${d.getDate()} ${t.slice(0, 5)}`;
  }

  function renderHistory() {
    const frag = document.createDocumentFragment();
    history.slice(0, 200).forEach((h) => {
      const li = document.createElement('li');
      const no = document.createElement('span');
      no.className = 'h-no';
      no.textContent = `#${h.n || ''}`;
      const chip = document.createElement('span');
      chip.className = 'h-chip';
      chip.style.background = h.color;
      const label = document.createElement('span');
      label.className = 'h-label';
      label.textContent = h.label;
      label.title = h.label;
      const time = document.createElement('span');
      time.className = 'h-time';
      time.textContent = h.at ? formatTime(h.at) : '';
      li.append(no, chip, label, time);
      frag.append(li);
    });
    el.historyList.replaceChildren(frag);
    el.historyEmpty.hidden = history.length > 0;
    el.historyCount.textContent = String(history.length);
    el.btnClearHistory.hidden = history.length === 0;
  }

  let clearConfirmTimer = 0;
  el.btnClearHistory.addEventListener('click', () => {
    if (!el.btnClearHistory.classList.contains('is-confirm')) {
      el.btnClearHistory.classList.add('is-confirm');
      el.btnClearHistory.textContent = 'もう一度押すと消去';
      clearTimeout(clearConfirmTimer);
      clearConfirmTimer = setTimeout(resetClearButton, 3000);
      return;
    }
    resetClearButton();
    history = [];
    renderHistory();
    saveState();
  });
  function resetClearButton() {
    el.btnClearHistory.classList.remove('is-confirm');
    el.btnClearHistory.textContent = '履歴を消去';
  }

  /* ------------------------------------------------------------------ */
  /* タブ                                                                 */
  /* ------------------------------------------------------------------ */

  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function selectTab(tab, focus) {
    tabs.forEach((t) => {
      const sel = t === tab;
      t.setAttribute('aria-selected', String(sel));
      t.tabIndex = sel ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !sel;
    });
    if (focus) tab.focus();
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab, false));
    tab.addEventListener('keydown', (e) => {
      let j = -1;
      if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = tabs.length - 1;
      if (j < 0) return;
      e.preventDefault();
      selectTab(tabs[j], true);
    });
  });

  /* ------------------------------------------------------------------ */
  /* 設定 UI                                                              */
  /* ------------------------------------------------------------------ */

  const numberFields = [
    [el.setAccel, 'accel'],
    [el.setBrake, 'brake'],
    [el.setFriction, 'friction'],
    [el.setMax, 'maxSpeed'],
    [el.setHoldRate, 'holdRate'],
  ];

  function fillPlaySettings() {
    numberFields.forEach(([input, key]) => {
      input.value = settings[key];
    });
    el.setHold.checked = settings.holdEnabled;
    el.setAutoRemove.checked = settings.autoRemove;
    syncHoldField();
  }

  function syncHoldField() {
    el.setHoldRate.disabled = !settings.holdEnabled;
    el.holdRateField.classList.toggle('is-disabled', !settings.holdEnabled);
  }

  numberFields.forEach(([input, key]) => {
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      if (!Number.isFinite(v)) return;
      settings[key] = clamp(v, LIMITS[key][0], LIMITS[key][1]);
      saveSoon();
    });
    input.addEventListener('change', () => {
      input.value = settings[key];
    });
  });

  el.setHold.addEventListener('change', () => {
    settings.holdEnabled = el.setHold.checked;
    syncHoldField();
    saveSoon();
  });

  el.setAutoRemove.addEventListener('change', () => {
    settings.autoRemove = el.setAutoRemove.checked;
    saveSoon();
  });

  el.btnResetSettings.addEventListener('click', () => {
    PLAY_KEYS.forEach((k) => {
      settings[k] = DEFAULTS[k];
    });
    fillPlaySettings();
    saveState();
    flashStatus('操作の設定を初期値に戻しました');
  });

  // サウンド
  function buildSoundUI() {
    const play = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 0.5l8 4.5-8 4.5z"/></svg>';
    el.themeList.innerHTML = Sound.THEMES.map(
      (t) => `
      <div class="theme" data-theme="${t.id}">
        <label class="theme-pick">
          <input type="radio" name="soundTheme" value="${t.id}" id="theme-${t.id}">
          <span class="theme-body">
            <span class="theme-name">${t.name}</span>
            <span class="theme-desc">${t.desc}</span>
          </span>
        </label>
        <button type="button" class="theme-play" data-preview="${t.id}" aria-label="${t.name}を試聴">${play}試聴</button>
      </div>`
    ).join('');

    el.eventList.innerHTML = Sound.EVENTS.map(
      (ev) => `
      <label class="event">
        <input type="checkbox" id="snd-${ev.id}" data-sound="${ev.id}">
        <span>${ev.name}<small>${ev.desc}</small></span>
      </label>`
    ).join('');

    el.themeList.addEventListener('change', (e) => {
      if (e.target.name !== 'soundTheme') return;
      settings.theme = e.target.value;
      Sound.setTheme(settings.theme);
      syncThemeUI();
      saveSoon();
    });
    el.themeList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-preview]');
      if (!btn) return;
      Sound.unlock();
      if (settings.muted) {
        flashStatus('ミュート中です');
        return;
      }
      Sound.preview(btn.dataset.preview);
    });
    el.eventList.addEventListener('change', (e) => {
      const key = e.target.dataset.sound;
      if (!key) return;
      settings.sounds[key] = e.target.checked;
      Sound.setEnabled(key, e.target.checked);
      saveSoon();
    });

    el.setVolume.addEventListener('input', () => {
      settings.volume = clamp(Number(el.setVolume.value) || 0, 0, 100);
      if (settings.muted && settings.volume > 0) settings.muted = false;
      applySound();
      saveSoon();
    });
    el.btnMute.addEventListener('click', () => {
      Sound.unlock();
      settings.muted = !settings.muted;
      applySound();
      saveSoon();
    });
  }

  function syncThemeUI() {
    el.themeList.querySelectorAll('.theme').forEach((node) => {
      const sel = node.dataset.theme === settings.theme;
      node.classList.toggle('is-selected', sel);
      node.querySelector('input').checked = sel;
    });
  }

  function applySound() {
    Sound.setTheme(settings.theme);
    Sound.setVolume(settings.volume / 100);
    Sound.setMuted(settings.muted);
    Object.entries(settings.sounds).forEach(([k, v]) => Sound.setEnabled(k, v));
    el.setVolume.value = settings.volume;
    el.volumeValue.textContent = String(Math.round(settings.volume));
    el.btnMute.setAttribute('aria-pressed', String(settings.muted));
    el.btnMute.setAttribute('aria-label', settings.muted ? 'ミュートを解除' : 'ミュート');
    el.eventList.querySelectorAll('[data-sound]').forEach((cb) => {
      cb.checked = !!settings.sounds[cb.dataset.sound];
    });
    syncThemeUI();
  }

  /* ------------------------------------------------------------------ */
  /* 起動                                                                 */
  /* ------------------------------------------------------------------ */

  el.input.addEventListener('input', onItemsChanged);
  el.btnShuffle.addEventListener('click', shuffleItems);

  loadState();
  buildSoundUI();
  applySound();
  fillPlaySettings();
  parseItems();
  renderHistory();

  // 最初は1番目の項目の真ん中に針が来るように
  spin.angle = -segAngle() / 2;
  spin.boundary = boundaryIndex();

  wheel.resize();
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => wheel.resize()).observe(el.wrap);
  }
  window.addEventListener('resize', () => wheel.resize());

  // Web フォントが届いたら盤の文字を描き直す
  if (document.fonts && document.fonts.load) {
    document.fonts.load('700 24px "Zen Kaku Gothic New"').then(() => wheel.rebuild()).catch(() => {});
    document.fonts.ready.then(() => wheel.rebuild()).catch(() => {});
  }

  requestAnimationFrame((ts) => {
    lastFrame = ts;
    requestAnimationFrame(frame);
  });
})();
