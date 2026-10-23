/*
 * script.js — 加速ルーレット本体
 *
 *  - 左クリック（タップ）で加速、右クリックで減速。いつでも押せる
 *  - 何もしなければ摩擦で自然に減速して止まる
 *  - 項目はテキスト欄に改行区切り。同じ文字列は同じ色
 *  - 結果ポップアップ・履歴・除外・設定の自動保存（localStorage）
 *  - カジノモード：ボールが入ったポケットが当たり（ボールは casino.js）
 */
(() => {
  'use strict';

  const Sound = window.RouletteSound;
  const Casino = window.Casino;
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
    mode: 'normal',   // normal = 針で決まる / casino = ボールで決まる
    ballSpeed: 180,   // カジノ：パワー100%で投げたときのボールの速さ（rpm）
    pocketTarget: 38, // カジノ：マス数の目安
    theme: 'classic',
    volume: 70,
    muted: false,
    sounds: Object.freeze({ tick: true, boost: true, brake: true, hum: true, roll: true, result: true, ball: true }),
  });

  const PLAY_KEYS = ['accel', 'brake', 'friction', 'maxSpeed', 'holdEnabled', 'holdRate', 'autoRemove', 'ballSpeed', 'pocketTarget'];

  // 加速量・減速量・最高速度は上限なし（JavaScript で扱える最大の数まで）
  const BIG = Number.MAX_VALUE;
  const LIMITS = {
    accel: [1, BIG],
    brake: [1, BIG],
    friction: [0, 50],
    maxSpeed: [0, BIG], // 0 = 無制限
    holdRate: [1, 30],
    ballSpeed: [10, 3000],
    pocketTarget: [2, 200],
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
    nowLabel: $('nowLabel'),
    nowValue: $('nowValue'),
    nowChip: $('nowChip'),
    modeButtons: [...document.querySelectorAll('.mode-btn')],
    btnBall: $('btnBall'),
    btnBallText: $('btnBallText'),
    power: $('power'),
    powerNum: $('powerNum'),
    powerFill: $('powerFill'),
    setBallSpeed: $('setBallSpeed'),
    setPockets: $('setPockets'),
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
  let pockets = [];          // カジノ：マス（{ itemIndex, label, color, ink }）
  const ball = new Casino.Ball();
  let ballDropAt = 0;

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
    if (raw.mode === 'normal' || raw.mode === 'casino') s.mode = raw.mode;
    s.pocketTarget = Math.round(s.pocketTarget);
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
    layoutCasino();
  }

  // カジノ：等倍率のまま目安の数に近いマスに分けて、交互に並べる
  function layoutCasino() {
    pockets = Casino.layoutPockets(items, settings.pocketTarget);
    updateItemCount();
  }

  function updateItemCount() {
    const kinds = new Set(items.map((it) => it.label)).size;
    let text = items.length ? `${items.length} 項目` + (kinds !== items.length ? `（${kinds} 種類）` : '') : '0 項目';
    if (settings.mode === 'casino' && items.length) text += ` → ${pockets.length} マス`;
    el.itemCount.textContent = text;
  }

  function onItemsChanged() {
    parseItems();
    if (!items.length && spin.active) {
      spin.active = false;
      spin.rpm = 0;
      Sound.stopRoll();
    }
    // マスの並びが変わるので、止まっているボールは片付ける
    if (!items.length || ball.state === 'settled') {
      if (ball.inPlay) Sound.stopRoll();
      cancelReveal();
      ball.reset();
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
      const before = spin.rpm;
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
      if (settings.mode === 'casino') joltBall(now, ((spin.rpm - before) / 60) * TAU);
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
    if (settings.mode === 'casino') return; // カジノはボールで決まる
    Sound.stopRoll();

    const idx = pointerIndex();
    if (idx < 0) return;
    declareResult(items[idx], now, 'normal');
  }

  function declareResult(it, now, mode, delay = RESULT_DELAY) {
    const entry = {
      n: (history.length ? history[0].n || history.length : 0) + 1,
      label: it.label,
      color: it.color,
      ink: it.ink,
      at: Date.now(),
      mode,
    };
    history.unshift(entry);
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    renderHistory();
    saveState();

    lastResult = { ...it, entry };
    fx.celebrateUntil = now + 3.2;
    spin.lockedUntil = now + delay / 1000;
    Sound.result();
    releaseAll();
    setTimeout(() => openResult(lastResult), delay);
  }

  /* ------------------------------------------------------------------ */
  /* カジノ：ボール                                                        */
  /* ------------------------------------------------------------------ */

  // パワーメーター：押している間 0% → 100% → 0% … と往復し、離した瞬間のパワーで投げる
  const POWER_SWEEP = 1.2; // 0% から 100% まで上がる秒数
  const charge = { active: false, source: null, t0: 0, power: 0, lap: 0, hideAt: 0 };

  // いまボールを投げられるか（だめなときは理由を表示）
  function canThrow(now, quiet) {
    if (settings.mode !== 'casino' || modalOpen || now < spin.lockedUntil) return false;
    if (!items.length) {
      if (!quiet) flashStatus('先に項目を入力してください');
      return false;
    }
    if (ball.inPlay) {
      if (!quiet) flashStatus('ボールが止まるまで待ってください');
      return false;
    }
    if (revealPending()) {
      if (!quiet) flashStatus('結果発表まで待ってください');
      return false;
    }
    return true;
  }

  function powerAt(now) {
    const phase = ((now - charge.t0) / POWER_SWEEP) % 2;
    return phase <= 1 ? phase : 2 - phase;
  }

  // 押した：メーターを出して、パワーを 0 から動かす
  function startCharge(source) {
    Sound.unlock();
    if (charge.active) return;
    const now = nowSec();
    if (!canThrow(now)) return;
    Object.assign(charge, { active: true, source, t0: now, power: 0, lap: 0, hideAt: 0 });
    el.power.hidden = false;
    el.power.classList.remove('is-fired');
    el.btnBall.classList.add('is-charging');
    renderPower(0);
  }

  // 離した：そのときのパワーで投げる
  function releaseCharge(source) {
    if (!charge.active || (source && charge.source !== source)) return;
    const now = nowSec();
    charge.power = powerAt(now);
    charge.active = false;
    Sound.updateCharge(-1);
    el.btnBall.classList.remove('is-charging');
    renderPower(charge.power);
    if (!canThrow(now, true)) {
      hidePower();
      return;
    }
    launchBall(charge.power);
    el.power.classList.add('is-fired'); // 投げたパワーを少しだけ見せてから消す
    charge.hideAt = now + 0.6;
  }

  function cancelCharge() {
    if (!charge.active) return;
    charge.active = false;
    Sound.updateCharge(-1);
    hidePower();
  }

  function hidePower() {
    el.power.hidden = true;
    el.power.classList.remove('is-fired');
    el.btnBall.classList.remove('is-charging');
    charge.hideAt = 0;
  }

  function renderPower(p) {
    el.powerNum.textContent = String(Math.round(p * 100));
    el.powerFill.style.clipPath = `inset(0 ${(100 - p * 100).toFixed(2)}% 0 0)`;
  }

  // 毎フレーム：メーターを動かす
  function updateCharge(now) {
    if (charge.active) {
      const lap = Math.floor((now - charge.t0) / POWER_SWEEP);
      if (lap !== charge.lap) {
        if (lap % 2 === 1) Sound.chargePeak(); // 100% に届いた
        charge.lap = lap;
      }
      charge.power = powerAt(now);
      renderPower(charge.power);
      Sound.updateCharge(charge.power);
    } else if (charge.hideAt && now >= charge.hideAt) {
      hidePower();
    }
  }

  // 盤と逆向き（反時計回り）に投げる。パワー0%でも少しは転がる
  function launchBall(power) {
    const rpm = settings.ballSpeed * (0.15 + 0.85 * power) * (0.97 + Math.random() * 0.06);
    // 投げ入れる位置は毎回ランダム（どのマスにも同じ確率で入るように）
    ball.launch(Math.random() * TAU, -(rpm / 60) * TAU);
    fx.celebrateUntil = 0;
    fx.flash = 0.6;
    Sound.ball('throw', 0.3 + 0.7 * power);
  }

  function stepBall(now, dt, angle0) {
    if (ball.state === 'idle') return;
    const omega = spin.active ? (spin.rpm / 60) * TAU : 0;
    const events = ball.step(dt, angle0, omega, pockets.length);
    for (const e of events) {
      if (e.type === 'drop') {
        ballDropAt = now;
        Sound.ball('drop');
      } else if (e.type === 'settle') {
        Sound.ball('settle');
        onBallSettled(now);
      } else {
        Sound.ball(e.type, (e.v || 0) / 4);
      }
    }
    // ボールが落ちてから止まるまでドラムロール
    if (ball.inPlay && ball.dropped) {
      Sound.setRollIntensity(0.25 + 0.75 * clamp((now - ballDropAt) / 2.5, 0, 1));
      if (!Sound.rolling) Sound.startRoll();
    }
  }

  // ボールがマスに入った：すぐには発表せず、ズームアップ → 全体に戻ってから発表
  function onBallSettled(now) {
    Sound.stopRoll();
    const p = pockets[ball.pocket];
    const it = p ? items[p.itemIndex] : null;
    if (it) startReveal(now, it, ball.pocket);
  }

  // ボールがマスに入ってから結果発表まで：ズームアップ → 全体に戻る → その RESULT_AFTER_ZOOM 秒後に発表
  // （盤がまだ回っていても、止まるのは待たない）
  const ZOOM_IN = 0.7;       // ズームアップにかける秒数
  const ZOOM_HOLD_MIN = 1.3; // ズームしたまま見せる秒数（発表までに盤が止まるとき）
  const ZOOM_HOLD_MAX = 2.3; // ズームしたまま見せる秒数（盤がまだ回り続けるとき）
  const ZOOM_OUT = 0.6;
  const RESULT_AFTER_ZOOM = 1.0;   // ズームが終わってから結果のポップアップが出るまでの秒数
  const REVEAL_POPUP_DELAY = 0.15; // 発表の音を鳴らしてからポップアップが出るまで
  const REVEAL_START = Math.max(0, RESULT_AFTER_ZOOM - REVEAL_POPUP_DELAY); // ズームが終わってから発表の音を鳴らすまで
  const reveal = { phase: 'none', t0: 0, start: 0, item: null, pocket: -1, eStart: 0, from: 0 };
  const cam = { e: 0, theta: 0 }; // e: ズームの度合い（0〜1） theta: 見せるマスの向き

  const normAngle = (a) => a - TAU * Math.round(a / TAU);
  const easeInOut = (t) => {
    t = clamp(t, 0, 1);
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  };

  function pocketCenter(i) {
    return -Math.PI / 2 + (i + 0.5) * (TAU / Math.max(1, pockets.length));
  }

  function startReveal(now, it, pocket) {
    const eStart = reveal.phase === 'abort' ? cam.e : 0; // 引いている途中でまた入ったときは、そこから寄る
    Object.assign(reveal, { phase: 'zoomIn', t0: now, start: now, item: it, pocket, eStart });
    cam.theta = normAngle(spin.angle + pocketCenter(pocket));
    cam.e = eStart;
    jolt = 0;
    Sound.ball('zoom');
  }

  // 結果発表を待っているところか（ボールがマスに入ってから、ポップアップが出るまで）
  function revealPending() {
    return reveal.phase !== 'none' && reveal.phase !== 'abort';
  }

  // ボールが飛び出したとき：ズームを引いて、もう一度入るのを待つ
  function abortReveal(now) {
    if (!revealPending()) return;
    Sound.stopRoll();
    reveal.item = null;
    if (cam.e > 0.001) Object.assign(reveal, { phase: 'abort', t0: now, from: cam.e });
    else reveal.phase = 'none';
  }

  /* 発表前に盤を急に加速すると、ポケットのボールが飛び出す ---------------- */
  //   加速するたびにボールへ「揺れ」がたまり、すぐに収まっていく（JOLT_DECAY 秒で約 1/3）
  //   1〜2回のクリック（初期値 +20 rpm）では揺れるだけ。素早く3回以上の連打・長押し・
  //   1回 +45 rpm 以上の大きな加速だと飛び出す
  const JOLT_DECAY = 0.3;
  const JOLT_EJECT = 1.9; // これを超えたら飛び出す（ボールにかかる勢い：外枠の半径/秒）
  let jolt = 0;
  let joltAt = 0;

  function joltBall(now, dOmega) {
    if (ball.state !== 'settled' || !revealPending() || !(dOmega > 0)) return;
    const v = Math.min(dOmega * Casino.GEO.POCKET_MID, 50);
    jolt = jolt * Math.exp(-(now - joltAt) / JOLT_DECAY) + v;
    joltAt = now;
    if (jolt >= JOLT_EJECT) {
      ejectBall(now, jolt);
      return;
    }
    const frac = jolt / JOLT_EJECT;
    ball.rattle(frac, pockets.length);
    Sound.ball('fret', 0.25 + 0.5 * frac);
    if (frac >= 0.6) flashStatus('ボールが揺れた！あと少しで飛び出す');
  }

  function ejectBall(now, strength) {
    const omega = spin.active ? (spin.rpm / 60) * TAU : 0;
    if (!ball.eject(spin.angle, omega, Math.min(strength, 8))) return;
    jolt = 0;
    abortReveal(now);
    ballDropAt = now; // ドラムロールは最初から
    Sound.ball('eject', Math.min(1, strength / 4));
    flashStatus('ボールが飛び出した！');
  }

  function cancelReveal() {
    if (reveal.phase === 'none') return;
    reveal.phase = 'none';
    reveal.item = null;
    cam.e = 0;
    Sound.stopRoll();
  }

  function finishReveal(now) {
    const it = reveal.item;
    reveal.phase = 'none';
    reveal.item = null;
    cam.e = 0;
    if (it) declareResult(it, now, 'casino', REVEAL_POPUP_DELAY * 1000);
  }

  // 毎フレーム：ズームの進み具合と、結果を出すタイミング
  function stepReveal(now) {
    if (reveal.phase === 'none') {
      cam.e = 0;
      return;
    }
    if (reveal.pocket >= pockets.length) {
      cancelReveal();
      return;
    }
    // 盤と一緒に回るマスを追いかける（角度は飛ばないようにつなげる）
    cam.theta += normAngle(spin.angle + pocketCenter(reveal.pocket) - cam.theta);
    if (reveal.phase === 'abort') {
      // ボールが飛び出した：ズームを引く
      const ta = now - reveal.t0;
      cam.e = reveal.from * (1 - easeInOut(ta / 0.35));
      if (ta >= 0.35) {
        reveal.phase = 'none';
        cam.e = 0;
      }
      return;
    }
    const tts = spin.active ? timeToStop() : 0; // 盤が止まるまでの秒数
    const t = now - reveal.t0;
    if (reveal.phase === 'zoomIn') {
      cam.e = reveal.eStart + (1 - reveal.eStart) * easeInOut(t / ZOOM_IN);
      if (t >= ZOOM_IN) Object.assign(reveal, { phase: 'hold', t0: now });
    } else if (reveal.phase === 'hold') {
      cam.e = 1;
      // 発表までに盤が止まるなら短め、まだ回り続けるなら長めにズームを見せる
      if (t >= ZOOM_HOLD_MIN && (tts <= ZOOM_OUT + RESULT_AFTER_ZOOM || t >= ZOOM_HOLD_MAX)) {
        cam.theta = normAngle(cam.theta); // 近い向きを通って全体に戻る
        Object.assign(reveal, { phase: 'zoomOut', t0: now });
      }
    } else if (reveal.phase === 'zoomOut') {
      cam.e = 1 - easeInOut(t / ZOOM_OUT);
      if (t >= ZOOM_OUT) {
        cam.e = 0;
        Object.assign(reveal, { phase: 'wait', t0: now }); // ここでズームが終わる
      }
    }
    // ズームが終わってから RESULT_AFTER_ZOOM 秒後にポップアップが出るように発表する
    if (reveal.phase === 'wait' && now - reveal.t0 >= REVEAL_START) {
      finishReveal(now);
      return;
    }
    // 結果発表に向けてドラムロール（ズームしきってから発表まで、だんだん強く）
    if (reveal.phase !== 'zoomIn') {
      const k = (now - reveal.start - ZOOM_IN) / (ZOOM_HOLD_MIN + ZOOM_OUT + REVEAL_START);
      Sound.setRollIntensity(clamp(k, 0.2, 1));
      if (!Sound.rolling) Sound.startRoll();
    } else if (Sound.rolling) {
      Sound.stopRoll();
    }
  }

  // ボールが転がる音の大きさ（ボールの下の面に対する速さ）
  function ballRollLevel() {
    if (!ball.inPlay || ball.air > 0) return 0;
    const surface = ball.state === 'rotor' && spin.active ? (spin.rpm / 60) * TAU : 0;
    return clamp(Math.hypot(ball.vr, ball.r * (ball.w - surface)) / 10, 0, 1);
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
    ballPointers.clear();
    heldKeys.clear();
    cancelCharge();
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
    const cur = ended ? 0 : e.buttons & 7;
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
    if (pressed & 4) startCharge('middle'); // ホイールクリック（中ボタン）の長押しでもボール
    if (released & 1) release('accel');
    if (released & 2) release('brake');
    if (released & 4) {
      if (e.type === 'pointercancel') cancelCharge();
      else releaseCharge('middle');
    }
  }

  ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture'].forEach((type) => {
    el.wrap.addEventListener(type, onWheelPointer);
  });
  el.wrap.addEventListener('contextmenu', (e) => e.preventDefault());
  // 中ボタンの自動スクロールを止める
  el.wrap.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  el.wrap.addEventListener('auxclick', (e) => e.preventDefault());

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

  // 「ボールを投げる」：押している間パワーをためて、離すと発射
  const ballPointers = new Set();
  el.btnBall.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // フォーカスを移さない（続けて Space で盤を加速できるように）
    try { el.btnBall.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    ballPointers.add(e.pointerId);
    startCharge('button');
  });
  el.btnBall.addEventListener('pointerup', (e) => {
    if (ballPointers.delete(e.pointerId)) releaseCharge('button');
  });
  el.btnBall.addEventListener('lostpointercapture', (e) => {
    if (ballPointers.delete(e.pointerId)) releaseCharge('button');
  });
  el.btnBall.addEventListener('pointercancel', (e) => {
    if (ballPointers.delete(e.pointerId)) cancelCharge();
  });
  el.btnBall.addEventListener('contextmenu', (e) => e.preventDefault());
  // Tab でボタンを選んだとき：Space / Enter を押している間ためる
  el.btnBall.addEventListener('keydown', (e) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (!e.repeat) startCharge('keyboard');
  });
  el.btnBall.addEventListener('keyup', (e) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    releaseCharge('keyboard');
  });

  // キーボード：Space / ↑ / Enter = 加速、↓ = 減速、B = ボールを投げる
  const heldKeys = new Map();
  function keyKind(e) {
    if (e.code === 'KeyB') return 'ball';
    if (e.code === 'Space' || e.key === 'ArrowUp') return 'accel';
    if (e.key === 'Enter' && e.target === el.wrap) return 'accel';
    if (e.key === 'ArrowDown') return 'brake';
    return null;
  }
  function isFormTarget(t) {
    return !!(t && t.closest && t.closest('input, textarea, select, button, [contenteditable], [role="tab"], .modal'));
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && charge.active) {
      cancelCharge();
      return;
    }
    if (modalOpen) {
      if (e.key === 'Escape') closeResult('close');
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const kind = keyKind(e);
    if (!kind) return;
    if (kind === 'ball') {
      // B はボタンにフォーカスがあっても効くように（文字入力中は除く）
      if (settings.mode !== 'casino' || (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]'))) return;
      e.preventDefault();
      if (!e.repeat) startCharge('key');
      return;
    }
    if (isFormTarget(e.target)) return;
    e.preventDefault();
    if (e.repeat || heldKeys.has(e.code)) return;
    heldKeys.set(e.code, kind);
    press(kind);
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'KeyB') releaseCharge('key');
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
    let mode = 'normal';
    let S = 0;      // キャンバスの一辺（デバイスピクセル）
    let dpr = 1;
    let cx = 0;
    let cy = 0;
    let R = 0;      // 外枠の半径
    let Rf = 0;     // 盤面の半径（通常モード）
    let base = null;   // 影
    let stator = null; // カジノ：すり鉢（回らない部分）
    let top = null;    // 回る部分の上に重ねるもの（ツヤ・中心のハブ）
    let rim = null;    // 真鍮の外枠と電球のソケット
    let face = null;   // 回る部分（通常：盤面 / カジノ：ポケットのある回転部）
    let spun = null;   // 超高速時用：色が混ざって見える回る部分
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

    function setMode(m) {
      mode = m;
      if (!S) return;
      buildStatic();
      rebuild();
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
      cy = S * 0.515;
      R = S * 0.47;
      Rf = R * 0.885;
      buildStatic();
      rebuild();
    }

    function buildStatic() {
      // 影（カジノはその上にすり鉢）
      base = makeCanvas(S, S);
      const b = base.getContext('2d');
      b.save();
      b.shadowColor = 'rgba(0, 0, 0, 0.38)';
      b.shadowBlur = R * 0.08;
      b.shadowOffsetY = R * 0.035;
      b.fillStyle = '#3a2a0c';
      b.beginPath();
      b.arc(cx, cy, R, 0, TAU);
      b.fill();
      b.restore();
      stator = null;
      if (mode === 'casino') {
        stator = makeCanvas(S, S);
        Casino.drawStator(stator.getContext('2d'), cx, cy, R);
      }

      // 真鍮の外枠と電球（通常モードだけ。カジノは外枠なしで盤を大きく使う）
      rim = null;
      bulbOn = null;
      bulbOff = null;
      if (mode === 'normal') buildRim();

      // 回る部分の上に重ねるもの
      top = makeCanvas(S, S);
      const t = top.getContext('2d');
      if (mode === 'casino') {
        Casino.drawCasinoGloss(t, cx, cy, R);
      } else {
        // 盤面のふちの陰り
        const edge = t.createRadialGradient(cx, cy, Rf * 0.86, cx, cy, Rf);
        edge.addColorStop(0, 'rgba(0, 0, 0, 0)');
        edge.addColorStop(1, 'rgba(0, 0, 0, 0.26)');
        t.fillStyle = edge;
        t.beginPath();
        t.arc(cx, cy, Rf, 0, TAU);
        t.fill();
        // ツヤ
        const gloss = t.createRadialGradient(cx - Rf * 0.38, cy - Rf * 0.48, Rf * 0.04, cx - Rf * 0.2, cy - Rf * 0.3, Rf * 1.05);
        gloss.addColorStop(0, 'rgba(255, 255, 255, 0.24)');
        gloss.addColorStop(0.45, 'rgba(255, 255, 255, 0.06)');
        gloss.addColorStop(1, 'rgba(255, 255, 255, 0)');
        t.fillStyle = gloss;
        t.beginPath();
        t.arc(cx, cy, Rf, 0, TAU);
        t.fill();
        // ハブ
        const hr = R * 0.13;
        t.save();
        t.shadowColor = 'rgba(0, 0, 0, 0.4)';
        t.shadowBlur = R * 0.04;
        t.shadowOffsetY = R * 0.015;
        const hub = t.createRadialGradient(cx - hr * 0.35, cy - hr * 0.45, hr * 0.1, cx, cy, hr);
        hub.addColorStop(0, '#fbebb6');
        hub.addColorStop(0.5, '#d9a845');
        hub.addColorStop(1, '#8a6118');
        t.fillStyle = hub;
        t.beginPath();
        t.arc(cx, cy, hr, 0, TAU);
        t.fill();
        t.restore();
        t.lineWidth = Math.max(1, R * 0.006);
        t.strokeStyle = 'rgba(70, 45, 5, 0.7)';
        t.beginPath();
        t.arc(cx, cy, hr, 0, TAU);
        t.stroke();
        t.beginPath();
        t.arc(cx, cy, hr * 0.62, 0, TAU);
        t.strokeStyle = 'rgba(90, 60, 10, 0.45)';
        t.stroke();
        const bolt = t.createRadialGradient(cx - hr * 0.08, cy - hr * 0.1, 0, cx, cy, hr * 0.22);
        bolt.addColorStop(0, '#fff6d6');
        bolt.addColorStop(1, '#a87a22');
        t.fillStyle = bolt;
        t.beginPath();
        t.arc(cx, cy, hr * 0.2, 0, TAU);
        t.fill();
      }
    }

    function buildRim() {
      rim = makeCanvas(S, S);
      const f = rim.getContext('2d');
      const grad = f.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
      grad.addColorStop(0, '#f7df97');
      grad.addColorStop(0.28, '#dcab48');
      grad.addColorStop(0.55, '#9c6d1b');
      grad.addColorStop(0.78, '#d7a745');
      grad.addColorStop(1, '#7a5313');
      f.beginPath();
      f.arc(cx, cy, R, 0, TAU);
      f.arc(cx, cy, Rf, 0, TAU, true);
      f.fillStyle = grad;
      f.fill('evenodd');
      f.lineWidth = Math.max(1, R * 0.007);
      f.strokeStyle = 'rgba(70, 45, 5, 0.65)';
      f.beginPath();
      f.arc(cx, cy, R - f.lineWidth / 2, 0, TAU);
      f.stroke();
      f.beginPath();
      f.arc(cx, cy, Rf, 0, TAU);
      f.stroke();
      bulbR = (R - Rf) * 0.27;
      const ringR = (R + Rf) / 2;
      for (let i = 0; i < BULBS; i++) {
        const a = (i / BULBS) * TAU - Math.PI / 2;
        f.beginPath();
        f.arc(cx + Math.cos(a) * ringR, cy + Math.sin(a) * ringR, bulbR * 1.35, 0, TAU);
        f.fillStyle = 'rgba(60, 38, 4, 0.55)';
        f.fill();
      }

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

    // 回る部分（項目が変わったときだけ描き直す）
    function rebuild() {
      if (!S) return;
      if (mode === 'casino') {
        const size = Math.ceil(Casino.GEO.ROTOR * R * 2) + 4;
        face = makeCanvas(size, size);
        Casino.drawRotor(face.getContext('2d'), size / 2, R, pockets, { font: LABEL_FONT, dpr });
        spun = makeCanvas(size, size);
        Casino.drawRotor(spun.getContext('2d'), size / 2, R, pockets, { font: LABEL_FONT, dpr, spun: true });
        return;
      }

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
      const chasing = spin.active || (mode === 'casino' && ball.inPlay);
      if (now < fx.celebrateUntil) {
        lv = (Math.floor(now * 7) + i) % 2 ? 1 : 0.12;
      } else if (chasing) {
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

    // カジノ：ボール（と、速いときの残像）
    function drawBall(mix) {
      if (ball.state === 'idle') return;
      const GEO = Casino.GEO;
      const pos = ball.position(spin.angle);
      const h = ball.height();
      const appear = ball.appear;
      if (ball.inPlay) {
        const speed = Math.hypot(ball.vr, ball.r * ball.w);
        const ta = clamp((speed - 1.2) / 5, 0, 1) * appear;
        if (ta > 0.02) {
          Casino.drawTrail(g, cx, cy, R, ball.trailPrev, ta * 0.6);
          Casino.drawTrail(g, cx, cy, R, ball.trail, ta);
        }
      }
      let alpha = appear;
      if (ball.state === 'settled' && mix > 0) {
        // 盤が速すぎるときは、ボールも輪のようにぼやけて見える
        g.save();
        g.globalAlpha = 0.35 * mix;
        g.strokeStyle = '#f5f2ea';
        g.lineWidth = GEO.BALL * R * 1.6;
        g.beginPath();
        g.arc(cx, cy, pos.r * R, 0, TAU);
        g.stroke();
        g.restore();
        alpha *= 1 - 0.7 * mix;
      }
      const x = cx + Math.cos(pos.th) * pos.r * R;
      const y = cy + Math.sin(pos.th) * pos.r * R;
      const rad = GEO.BALL * R * (1 + h * 2.2) * (0.6 + 0.4 * appear);
      Casino.drawBall(g, x, y, rad, alpha, h * R);
    }

    // カジノ：ボールがマスに入ったときのズームアップ（盤と一緒に回るカメラ）
    //   マスが右向きになるように回すので、項目名が横書きで読める
    const ZOOM = 2.7;     // 拡大率
    const FOCUS_R = 0.58; // 画面の真ん中に持ってくる位置（ボールのマスと項目名の間）

    function applyCamera(e) {
      const th = cam.theta;
      const z = 1 + (ZOOM - 1) * e;
      g.translate(cx, cy);
      g.scale(z, z);
      g.rotate(-th * e);
      g.translate(-(cx + Math.cos(th) * FOCUS_R * R * e), -(cy + Math.sin(th) * FOCUS_R * R * e));
    }

    // ズーム中の「レンズ」：ふちを暗くして真鍮の枠をつける
    function drawLens(e) {
      g.save();
      const v = g.createRadialGradient(cx, cy, R * 0.5, cx, cy, R);
      v.addColorStop(0, 'rgba(0, 0, 0, 0)');
      v.addColorStop(1, `rgba(0, 0, 0, ${(0.5 * e).toFixed(3)})`);
      g.fillStyle = v;
      g.beginPath();
      g.arc(cx, cy, R, 0, TAU);
      g.fill();
      g.globalAlpha = e;
      const ring = g.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
      ring.addColorStop(0, '#f7df97');
      ring.addColorStop(0.3, '#dcab48');
      ring.addColorStop(0.55, '#9c6d1b');
      ring.addColorStop(0.8, '#d7a745');
      ring.addColorStop(1, '#7a5313');
      g.lineWidth = R * 0.028;
      g.strokeStyle = ring;
      g.beginPath();
      g.arc(cx, cy, R - R * 0.014, 0, TAU);
      g.stroke();
      g.restore();
    }

    function draw(now, dt) {
      if (!S || !face) return;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, S, S);
      g.drawImage(base, 0, 0);

      const lens = mode === 'casino' ? clamp(cam.e, 0, 1) : 0;
      g.save();
      if (lens > 0.001) {
        g.beginPath();
        g.arc(cx, cy, R, 0, TAU);
        g.clip();
        applyCamera(lens);
      }
      // 1フレームで回る角度。フレーム間隔のゆらぎで見た目がちらつかないよう平滑化
      const raw = Math.min(BLEND_END * 2, (spin.rpm / 60) * TAU * Math.min(dt, 1 / 30));
      visStep = spin.active ? visStep + (raw - visStep) * 0.25 : 0;
      const zoomed = lens > 0.001;
      const step = zoomed ? 0 : visStep; // ズーム中はカメラが盤と一緒に回るので、ぶれて見えない
      const mix = spun ? clamp((step - BLEND_START) / (BLEND_END - BLEND_START), 0, 1) : 0;
      const half = face.width / 2;

      if (zoomed) {
        // ズーム中はその場で描き直して、拡大しても文字やふちがぼやけないように
        Casino.drawStator(g, cx, cy, R);
        g.save();
        g.translate(cx, cy);
        g.rotate(spin.angle);
        Casino.drawRotor(g, 0, R, pockets, { font: LABEL_FONT, dpr });
        g.restore();
      } else if (stator) {
        g.drawImage(stator, 0, 0);
      }

      // 速いときはモーションブラー（数枚を少しずつずらして重ねる）
      if (!zoomed && mix < 1) {
        const span = Math.min(step, BLEND_END);
        const layers = span > 0.03 ? Math.min(16, Math.ceil(span / 0.025)) : 1;
        for (let k = 0; k < layers; k++) {
          g.save();
          g.globalAlpha = 1 / (k + 1);
          g.translate(cx, cy);
          g.rotate(spin.angle - (span * k) / layers);
          g.drawImage(face, -half, -half);
          g.restore();
        }
      }
      // さらに速いと色が混ざった盤に切り替え、ストロボのようなちらつきを少し重ねる
      if (!zoomed && mix > 0) {
        g.save();
        g.translate(cx, cy);
        g.globalAlpha = mix;
        g.drawImage(spun, -half, -half);
        g.globalAlpha = 0.16 * mix;
        g.rotate(Math.random() * TAU);
        g.drawImage(face, -half, -half);
        g.restore();
      }

      if (mode === 'casino') {
        if (ball.state === 'settled' && pockets.length) {
          Casino.drawPocketGlow(g, cx, cy, R, spin.angle, pockets.length, ball.pocket, 0.5 + 0.5 * Math.sin(now * 6));
        }
        drawBall(mix);
        g.restore(); // カメラを戻す
        g.drawImage(top, 0, 0); // ツヤは画面に固定
        if (lens > 0.001) drawLens(lens);
      } else {
        g.restore();
        g.drawImage(top, 0, 0);
        g.drawImage(rim, 0, 0);
        drawBulbs(now);
        drawPointer();
      }
    }

    return { resize, rebuild, draw, setMode };
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

    const casino = settings.mode === 'casino';
    const angle0 = spin.angle; // このフレーム開始時の盤の角度（ボールの計算用）

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

      if (!casino) {
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
      }

      if (spin.rpm <= 0) finishSpin(now);
    }

    if (casino) {
      stepBall(now, dt, angle0);
      stepReveal(now);
    } else {
      cam.e = 0;
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
    const chaseRpm = casino && ball.inPlay ? Math.max(spin.rpm, ball.rpm()) : spin.rpm;
    fx.bulbPhase = (fx.bulbPhase + Math.min(chaseRpm, 600) * dt * 0.06) % 4;

    const slots = casino ? pockets.length : items.length;
    const tickRate = slots ? (spin.rpm / 60) * slots : 0;
    Sound.update(Math.min(1, spin.rpm / SOUND_REF_RPM), tickRate, spin.active);
    Sound.updateBall(casino ? ballRollLevel() : 0, casino && ball.inPlay ? ball.state : null);
  }

  function updateHud(now) {
    const casino = settings.mode === 'casino';
    // 針の位置（カジノはボールの真下のマス）
    let it = null;
    if (casino) {
      if (ball.state !== 'idle' && pockets.length) it = pockets[ball.pocketUnder(spin.angle, pockets.length)] || null;
    } else {
      const idx = pointerIndex();
      it = idx >= 0 ? items[idx] : null;
    }
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

    // 状態（速度計の下）
    const state = stateText(now, casino);
    if (state !== lastState) {
      lastState = state;
      el.stateLabel.textContent = state;
      el.stateLabel.title = state;
    }
    // 読み上げ用（数字が変わるたびには読ませない）
    const status = state.replace(/\s*[\d,.]+\s*rpm$/, '');
    if (status !== lastStatus) {
      lastStatus = status;
      el.status.textContent = status;
    }

    // ボールを投げるボタン
    const ballUi = !casino ? 'idle' : ball.inPlay ? 'busy' : revealPending() ? 'waiting' : charge.active ? 'charging' : 'idle';
    if (ballUi !== lastBallBusy) {
      lastBallBusy = ballUi;
      el.btnBall.disabled = ballUi === 'busy' || ballUi === 'waiting';
      el.btnBallText.textContent = {
        busy: 'ボール投入中',
        waiting: '結果発表を待っています',
        charging: '離して発射',
        idle: 'ボールを投げる',
      }[ballUi];
    }
  }

  let lastBallBusy = null;

  function stateText(now, casino) {
    if (now < tempStatus.until) return tempStatus.text;
    if (!items.length) return touchOnly.matches ? '下の欄に項目を入力してください' : '右の欄に項目を入力してください';
    if (casino) {
      if (charge.active) return '離すと発射！';
      if (reveal.phase === 'zoomIn' || reveal.phase === 'hold') return 'ボールが入った！';
      if (revealPending()) return 'まもなく結果発表…';
      if (ball.state === 'track') return `ボール周回中 ${Math.round(ball.rpm())} rpm`;
      if (ball.state === 'bowl') return 'ボールが落ちた！';
      if (ball.state === 'rotor') return 'ボールが跳ねている…';
      if (ball.state === 'settled' && lastResult) return `結果：${lastResult.label}`;
      return touchOnly.matches ? 'ボールを長押し → 離して発射' : '長押しでパワー → 離して発射（B）';
    }
    if (spin.active) {
      if (Sound.rolling || timeToStop() <= ROLL_WINDOW) return 'まもなく停止';
      if (now - spin.lastAccelAt < 0.6) return '加速中';
      return settings.friction > 0 ? '減速中' : '回転中';
    }
    if (lastResult && lastResult.entry.mode !== 'casino' && spin.everSpun) return `結果：${lastResult.label}`;
    return touchOnly.matches ? '盤をタップしてスタート' : '盤を左クリックしてスタート';
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
    updateCharge(nowSec());
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
    el.resultMeta.textContent = `第 ${res.entry.n} 回の結果` + (res.entry.mode === 'casino' ? '（カジノ）' : '');
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
      label.title = h.label;
      const text = document.createElement('span');
      text.className = 'h-label-text';
      text.textContent = h.label;
      label.append(text);
      if (h.mode === 'casino') {
        const tag = document.createElement('span');
        tag.className = 'h-tag';
        tag.textContent = 'カジノ';
        label.append(tag);
      }
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
    [el.setBallSpeed, 'ballSpeed'],
    [el.setPockets, 'pocketTarget'],
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
      if (key === 'pocketTarget') {
        settings.pocketTarget = Math.round(settings.pocketTarget);
        onPocketsChanged();
      }
      saveSoon();
    });
    input.addEventListener('change', () => {
      input.value = settings[key];
    });
  });

  // マス数の目安が変わった
  function onPocketsChanged() {
    const before = pockets.length;
    layoutCasino();
    if (pockets.length !== before && ball.state === 'settled') {
      cancelReveal();
      ball.reset();
    }
    if (settings.mode === 'casino') wheel.rebuild();
  }

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
    onPocketsChanged();
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
  /* モード（ルーレット / カジノ）                                            */
  /* ------------------------------------------------------------------ */

  function setMode(m) {
    if ((m !== 'normal' && m !== 'casino') || m === settings.mode) return;
    settings.mode = m;
    cancelCharge();
    hidePower();
    cancelReveal();
    ball.reset();
    Sound.stopRoll();
    Sound.updateBall(0, null);
    spin.boundary = boundaryIndex();
    applyModeUI();
    wheel.setMode(m);
    saveSoon();
  }

  function applyModeUI() {
    const casino = settings.mode === 'casino';
    document.body.dataset.mode = settings.mode;
    el.modeButtons.forEach((btn) => {
      const on = btn.dataset.mode === settings.mode;
      btn.setAttribute('aria-checked', String(on));
      btn.tabIndex = on ? 0 : -1;
    });
    el.nowLabel.textContent = casino ? 'ボールの位置' : '針の位置';
    updateItemCount();
    lastNowKey = null;
    lastState = '';
    lastBallBusy = null;
  }

  el.modeButtons.forEach((btn, i) => {
    btn.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') e.preventDefault();
    });
    btn.addEventListener('click', () => {
      Sound.unlock();
      setMode(btn.dataset.mode);
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const next = el.modeButtons[(i + 1) % el.modeButtons.length];
      setMode(next.dataset.mode);
      next.focus();
    });
  });

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
  applyModeUI();

  // 最初は1番目の項目の真ん中に針が来るように
  spin.angle = -segAngle() / 2;
  spin.boundary = boundaryIndex();

  wheel.setMode(settings.mode);
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
