/*
 * sounds.js — 加速ルーレットのサウンドエンジン
 *
 * 音源ファイルは使わず、すべて Web Audio API でその場で合成しています。
 * （著作権を気にせず GitHub で公開できるように）
 *
 * 使い方（script.js から呼ぶ）:
 *   RouletteSound.unlock()            … 最初のクリックで呼ぶ（ブラウザの自動再生制限の解除）
 *   RouletteSound.setTheme('classic') … テーマ切替
 *   RouletteSound.setVolume(0.7)      … 0〜1
 *   RouletteSound.setMuted(true)
 *   RouletteSound.setEnabled('tick', false)
 *   RouletteSound.tick(norm) / boost() / brake() / result()
 *   RouletteSound.update(norm, tickRate, spinning)  … 毎フレーム呼ぶ（回転音）
 *   RouletteSound.startRoll() / setRollIntensity(v) / stopRoll()  … ドラムロール
 */
(function (global) {
  'use strict';

  /** @type {AudioContext|null} */
  let ctx = null;
  let master = null;   // 音量
  let bus = null;      // 効果音のまとめ
  let noiseBuffer = null;

  let volume = 0.7;
  let muted = false;
  let themeId = 'classic';

  const enabled = { tick: true, boost: true, brake: true, hum: true, roll: true, result: true, ball: true };

  let hum = null;          // 回転中の持続音
  let humIdleSince = 0;
  let ballRoll = null;     // ボールが転がる持続音（カジノモード）
  let chargeVoice = null;  // パワーをためている間の音
  let ballIdleSince = 0;
  let lastBallHitAt = -1;
  const roll = { active: false, next: 0, intensity: 0 };
  let lastTickAt = -1;

  const rand = (a, b) => a + Math.random() * (b - a);

  /* ------------------------------------------------------------------ */
  /* 初期化                                                               */
  /* ------------------------------------------------------------------ */

  function ensure() {
    if (!ctx) {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;

      master = ctx.createGain();
      master.gain.value = outputGain();
      bus = ctx.createGain();
      bus.gain.value = 0.9;

      bus.connect(master);
      master.connect(comp);
      comp.connect(ctx.destination);

      noiseBuffer = makeNoise(3);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }

  function ready() {
    return !!ctx && ctx.state !== 'closed';
  }

  function outputGain() {
    // 耳の感じ方に合わせて二乗カーブ
    return muted ? 0 : volume * volume;
  }

  function makeNoise(seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /* ------------------------------------------------------------------ */
  /* 音の部品                                                             */
  /* ------------------------------------------------------------------ */

  // 打楽器的な減衰エンベロープ
  function envelope(gainNode, t, peak, attack, decay) {
    const g = gainNode.gain;
    // 開始前のゲインは既定値 1 のままだと、開始の瞬間に1サンプルだけ大きなクリック音が出るので 0 にしておく
    g.value = 0;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
    g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  // 発振器ひとつ（f → f2 へピッチ変化も可）
  function osc({ t, type = 'sine', f = 440, f2 = null, glide = null, a = 0.002, d = 0.2, g = 0.3, detune = 0, dest = bus }) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + (glide == null ? a + d : glide));
    o.detune.value = detune;
    const gn = ctx.createGain();
    envelope(gn, t, g, a, d);
    o.connect(gn);
    gn.connect(dest);
    o.start(t);
    o.stop(t + a + d + 0.05);
  }

  // フィルタを通したノイズ
  function noise({ t, a = 0.001, d = 0.05, g = 0.3, type = 'bandpass', f = 1000, f2 = null, glide = null, q = 1, dest = bus }) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const fl = ctx.createBiquadFilter();
    fl.type = type;
    fl.frequency.setValueAtTime(f, t);
    if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + (glide == null ? a + d : glide));
    fl.Q.value = q;
    const gn = ctx.createGain();
    envelope(gn, t, g, a, d);
    src.connect(fl);
    fl.connect(gn);
    gn.connect(dest);
    const len = a + d + 0.05;
    const offset = Math.max(0, Math.random() * (noiseBuffer.duration - len - 0.01));
    src.start(t, offset, len);
  }

  // 8bit 風：音を伸ばしてからスパッと切る
  function chip({ t, type = 'square', f = 440, dur = 0.1, g = 0.1, dest = bus }) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    const gn = ctx.createGain();
    gn.gain.value = 0;
    gn.gain.setValueAtTime(0.0001, t);
    gn.gain.linearRampToValueAtTime(g, t + 0.004);
    gn.gain.setValueAtTime(g, t + Math.max(0.005, dur - 0.015));
    gn.gain.linearRampToValueAtTime(0.0001, t + dur);
    o.connect(gn);
    gn.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  function bell(t, f, g = 0.2, d = 1.2) {
    // 非整数倍音で金属っぽく
    [[1, 1], [2.0, 0.5], [2.76, 0.32], [5.4, 0.12]].forEach(([ratio, amp]) => {
      osc({ t, f: f * ratio, a: 0.002, d: d / Math.sqrt(ratio), g: g * amp });
    });
  }

  function snare(t, g) {
    noise({ t, d: 0.1, g, type: 'bandpass', f: 1900, q: 0.7 });
    osc({ t, type: 'triangle', f: 210, f2: 160, d: 0.06, g: g * 0.5 });
  }

  function crash(t, g) {
    noise({ t, a: 0.002, d: 1.9, g, type: 'highpass', f: 4200, q: 0.4 });
    noise({ t, a: 0.002, d: 0.7, g: g * 0.6, type: 'bandpass', f: 7500, q: 0.8 });
  }

  function brassChord(t, freqs, dur, g) {
    const fl = ctx.createBiquadFilter();
    fl.type = 'lowpass';
    fl.Q.value = 1.5;
    fl.frequency.setValueAtTime(500, t);
    fl.frequency.exponentialRampToValueAtTime(3800, t + 0.05);
    fl.frequency.exponentialRampToValueAtTime(1400, t + dur);
    const gn = ctx.createGain();
    gn.gain.value = 0;
    gn.gain.setValueAtTime(0.0001, t);
    gn.gain.exponentialRampToValueAtTime(g, t + 0.025);
    gn.gain.setValueAtTime(g * 0.85, t + dur * 0.55);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    fl.connect(gn);
    gn.connect(bus);
    freqs.forEach((f) => {
      [-9, 9].forEach((det) => {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = det;
        o.connect(fl);
        o.start(t);
        o.stop(t + dur + 0.05);
      });
    });
  }

  function taiko(t, g, f = 120) {
    osc({ t, f, f2: f * 0.45, glide: 0.35, a: 0.003, d: 0.55, g });
    osc({ t, f: f * 1.6, f2: f * 0.7, a: 0.002, d: 0.18, g: g * 0.3 });
    noise({ t, d: 0.06, g: g * 0.45, type: 'lowpass', f: 450, q: 0.5 });
  }

  function woodblock(t, g, f = 950) {
    osc({ t, f, a: 0.001, d: 0.05, g });
    osc({ t, f: f * 1.8, a: 0.001, d: 0.025, g: g * 0.35 });
    noise({ t, d: 0.008, g: g * 0.5, type: 'bandpass', f: f * 2.3, q: 3 });
  }

  function hyoshigi(t, g) {
    osc({ t, f: 2150, a: 0.001, d: 0.16, g });
    osc({ t, f: 3300, a: 0.001, d: 0.09, g: g * 0.45 });
    noise({ t, d: 0.012, g: g * 0.8, type: 'bandpass', f: 3000, q: 2 });
  }

  function suzu(t, dur, g) {
    const n = Math.floor(dur * 36);
    for (let i = 0; i < n; i++) {
      const tt = t + (i / n) * dur + rand(0, 0.02);
      const fade = 1 - i / n;
      osc({ t: tt, f: rand(4200, 6800), a: 0.001, d: rand(0.08, 0.18), g: g * (0.4 + Math.random() * 0.6) * (0.3 + 0.7 * fade) });
    }
  }

  function koto(t, f, g) {
    osc({ t, type: 'triangle', f, a: 0.002, d: 0.9, g });
    osc({ t, type: 'sine', f: f * 2, a: 0.002, d: 0.35, g: g * 0.35 });
    noise({ t, d: 0.01, g: g * 0.5, type: 'bandpass', f: f * 3, q: 4 });
  }

  function coins(t, count, dur, g) {
    for (let i = 0; i < count; i++) {
      const tt = t + Math.pow(Math.random(), 1.4) * dur;
      const f = rand(2300, 4800);
      osc({ t: tt, f, a: 0.001, d: rand(0.1, 0.25), g });
      osc({ t: tt, f: f * 2.71, a: 0.001, d: rand(0.05, 0.12), g: g * 0.4 });
    }
  }

  // 拍手：小さなノイズ破裂をたくさん重ねる
  function applause(t, dur, g) {
    const n = Math.floor(dur * 85);
    for (let i = 0; i < n; i++) {
      const u = Math.random();
      const tt = t + Math.pow(u, 1.35) * dur;
      const fade = Math.max(0.05, 1 - (tt - t) / dur);
      const swell = Math.min(1, (tt - t) / 0.25 + 0.3);
      noise({
        t: tt,
        a: 0.001,
        d: rand(0.015, 0.04),
        g: g * (0.35 + Math.random() * 0.65) * fade * swell,
        type: 'bandpass',
        f: rand(800, 2600),
        q: 1.2,
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* テーマ                                                               */
  /*   tick(t, v)   … 針がピンを越えた音（v: 0〜1 の音量係数）              */
  /*   boost(t)     … 加速                                                */
  /*   brake(t)     … 減速                                                */
  /*   hum          … 回転中の持続音の設定                                  */
  /*   roll(t, v)   … ドラムロール1打（v: 盛り上がり 0〜1）                  */
  /*   result(t)    … 当選                                                */
  /* ------------------------------------------------------------------ */

  const THEMES = {
    classic: {
      name: 'クラシック',
      desc: '木と真鍮の盤。パチパチ鳴る針と拍手',
      hum: { kind: 'noise', type: 'bandpass', fMin: 180, fMax: 900, q: 0.9, g: 0.55, depth: 0.55 },
      rollInterval: 0.055,
      tick(t, v) {
        noise({ t, d: 0.016, g: 0.45 * v, type: 'bandpass', f: rand(2150, 2650), q: 2.2 });
        osc({ t, f: 240, f2: 150, d: 0.035, g: 0.22 * v });
      },
      boost(t) {
        noise({ t, a: 0.03, d: 0.22, g: 0.3, type: 'bandpass', f: 500, f2: 2600, q: 1.1 });
        osc({ t, f: 130, f2: 70, d: 0.12, g: 0.35 });
      },
      brake(t) {
        noise({ t, a: 0.005, d: 0.24, g: 0.32, type: 'bandpass', f: 1700, f2: 600, q: 3.5 });
        osc({ t, f: 95, f2: 60, d: 0.12, g: 0.3 });
      },
      roll(t, v) {
        snare(t, 0.07 + 0.2 * v);
      },
      result(t) {
        [1047, 1319, 1568, 2093].forEach((f, i) => bell(t + i * 0.09, f, 0.22, 1.4));
        applause(t + 0.2, 2.6, 0.5);
      },
    },

    casino: {
      name: 'カジノ',
      desc: '転がるボールとチップの音、ジャックポット',
      hum: { kind: 'noise', type: 'bandpass', fMin: 900, fMax: 3200, q: 1.4, g: 0.32, depth: 0.6 },
      rollInterval: 0.065,
      tick(t, v) {
        const f = rand(3000, 4000);
        osc({ t, f, a: 0.001, d: 0.025, g: 0.17 * v });
        osc({ t, f: f * 2.3, a: 0.001, d: 0.015, g: 0.06 * v });
        noise({ t, d: 0.01, g: 0.14 * v, type: 'highpass', f: 6500, q: 0.7 });
      },
      boost(t) {
        [0, 0.035, 0.065].forEach((dt, i) => noise({ t: t + dt, d: 0.03, g: 1.3 - i * 0.3, type: 'bandpass', f: rand(3800, 4600), q: 4 }));
        noise({ t, a: 0.02, d: 0.16, g: 0.35, type: 'bandpass', f: 900, f2: 3000, q: 1 });
      },
      brake(t) {
        osc({ t, f: 160, f2: 70, d: 0.15, g: 0.32 });
        noise({ t, d: 0.08, g: 0.2, type: 'lowpass', f: 900, q: 0.6 });
      },
      roll(t, v) {
        osc({ t, f: rand(2800, 4200), a: 0.001, d: 0.02, g: 0.06 + 0.12 * v });
        noise({ t, d: 0.008, g: 0.05 + 0.08 * v, type: 'highpass', f: 6000, q: 0.7 });
      },
      result(t) {
        [523, 659, 784, 1047, 1319, 1568, 2093].forEach((f, i) => osc({ t: t + i * 0.045, type: 'triangle', f, a: 0.003, d: 0.28, g: 0.21 }));
        for (let i = 0; i < 10; i++) chip({ t: t + 0.36 + i * 0.09, type: 'triangle', f: i % 2 ? 1319 : 1568, dur: 0.08, g: 0.17 });
        bell(t + 0.32, 2093, 0.22, 1.4);
        coins(t + 0.3, 28, 1.7, 0.09);
      },
    },

    retro: {
      name: 'レトロゲーム',
      desc: 'ピコピコ8bit。矩形波のファンファーレ',
      hum: { kind: 'osc', type: 'square', fMin: 50, fMax: 200, lp: 1100, g: 0.1, depth: 0.5 },
      rollInterval: 0.06,
      tick(t, v) {
        osc({ t, type: 'square', f: 1600, f2: 900, a: 0.001, d: 0.022, g: 0.22 * v });
      },
      boost(t) {
        osc({ t, type: 'square', f: 260, f2: 1040, glide: 0.1, a: 0.003, d: 0.12, g: 0.26 });
        osc({ t: t + 0.06, type: 'square', f: 520, f2: 2080, glide: 0.08, a: 0.003, d: 0.08, g: 0.12 });
      },
      brake(t) {
        osc({ t, type: 'square', f: 900, f2: 160, glide: 0.15, a: 0.003, d: 0.16, g: 0.26 });
      },
      roll(t, v) {
        noise({ t, d: 0.035, g: 0.04 + 0.09 * v, type: 'highpass', f: 2500, q: 0.6 });
      },
      result(t) {
        // オリジナルのジングル
        const lead = [
          [784, 0.07], [1047, 0.07], [1319, 0.07], [1568, 0.07], [0, 0.07],
          [1319, 0.1], [1568, 0.5],
        ];
        let tt = t;
        lead.forEach(([f, dur]) => {
          if (f) {
            chip({ t: tt, type: 'square', f, dur, g: 0.1 });
            chip({ t: tt, type: 'square', f: f * 1.005, dur, g: 0.035 });
          }
          tt += dur;
        });
        chip({ t, type: 'triangle', f: 131, dur: 0.28, g: 0.22 });
        chip({ t: t + 0.28, type: 'triangle', f: 196, dur: 0.17, g: 0.22 });
        chip({ t: t + 0.45, type: 'triangle', f: 262, dur: 0.5, g: 0.22 });
        for (let i = 0; i < 6; i++) chip({ t: t + 0.95 + i * 0.05, type: 'square', f: 2093 + i * 220, dur: 0.04, g: 0.04 });
      },
    },

    quiz: {
      name: 'クイズ番組',
      desc: 'ドラムロールとシンバル、ジャジャーン',
      hum: { kind: 'noise', type: 'bandpass', fMin: 260, fMax: 1400, q: 0.7, g: 0.42, depth: 0.5 },
      rollInterval: 0.045,
      tick(t, v) {
        osc({ t, f: 1900, f2: 1300, a: 0.001, d: 0.025, g: 0.28 * v });
        noise({ t, d: 0.008, g: 0.2 * v, type: 'bandpass', f: 4000, q: 2 });
      },
      boost(t) {
        noise({ t, a: 0.04, d: 0.2, g: 0.26, type: 'highpass', f: 1200, f2: 5000, q: 0.7 });
        osc({ t, f: 160, f2: 80, d: 0.1, g: 0.32 });
      },
      brake(t) {
        osc({ t, type: 'sawtooth', f: 180, f2: 90, d: 0.14, g: 0.24 });
        noise({ t, d: 0.1, g: 0.6, type: 'bandpass', f: 900, q: 2 });
      },
      roll(t, v) {
        snare(t, 0.09 + 0.28 * v);
      },
      result(t) {
        crash(t, 0.3);
        brassChord(t, [262, 330, 392, 523], 0.14, 0.16);
        brassChord(t + 0.18, [392, 523, 659, 784], 1.5, 0.17);
        crash(t + 0.18, 0.32);
        applause(t + 0.4, 2.6, 0.45);
      },
    },

    wafu: {
      name: '和風',
      desc: '木魚の針、太鼓の加速、鈴と琴で当選',
      hum: { kind: 'noise', type: 'lowpass', fMin: 220, fMax: 800, q: 0.5, g: 0.5, depth: 0.4 },
      rollInterval: 0.085,
      tick(t, v) {
        woodblock(t, 0.3 * v, rand(900, 1000));
      },
      boost(t) {
        taiko(t, 0.55, 120);
      },
      brake(t) {
        noise({ t, d: 0.045, g: 1.0, type: 'bandpass', f: 2600, q: 5 });
        osc({ t, f: 700, a: 0.001, d: 0.045, g: 0.3 });
      },
      roll(t, v) {
        osc({ t, f: 260, f2: 190, a: 0.002, d: 0.12, g: 0.1 + 0.32 * v });
        noise({ t, d: 0.03, g: 0.05 + 0.12 * v, type: 'lowpass', f: 600, q: 0.5 });
      },
      result(t) {
        taiko(t, 0.85, 110);
        taiko(t + 0.24, 0.55, 115);
        taiko(t + 0.36, 0.9, 105);
        hyoshigi(t + 0.62, 0.22);
        [659, 698, 880, 988, 1047, 1319].forEach((f, i) => koto(t + 0.7 + i * 0.085, f, 0.13));
        suzu(t + 0.62, 1.3, 0.05);
      },
    },
  };

  function theme(id) {
    return THEMES[id || themeId] || THEMES.classic;
  }

  /* ------------------------------------------------------------------ */
  /* ボールの音（カジノモード）                                              */
  /*   テーマに ball がなければ、この実物っぽい音を使う                        */
  /* ------------------------------------------------------------------ */

  const BALL = {
    roll: { kind: 'noise', fMin: 700, fMax: 3300, q: 0.8, g: 0.5, rumble: 0.4 },
    throw(t, v) {
      // 強く投げるほど「シュッ」が長く高く
      noise({ t, a: 0.01, d: 0.07 + 0.1 * v, g: 0.15 + 0.25 * v, type: 'highpass', f: 1500, f2: 3500 + 3500 * v, q: 0.7 });
      osc({ t: t + 0.07, f: 3200, a: 0.001, d: 0.02, g: 0.16 });
      noise({ t: t + 0.07, d: 0.012, g: 0.22, type: 'highpass', f: 5000, q: 0.7 });
    },
    drop(t) {
      noise({ t, a: 0.01, d: 0.1, g: 0.25, type: 'bandpass', f: 1300, f2: 800, q: 1.5 });
    },
    diamond(t, v) {
      const f = rand(2300, 2700);
      osc({ t, f, a: 0.001, d: 0.05, g: 0.3 * v });
      osc({ t, f: f * 2.6, a: 0.001, d: 0.03, g: 0.12 * v });
      noise({ t, d: 0.012, g: 0.6 * v, type: 'bandpass', f: 4000, q: 2 });
    },
    rotor(t, v) {
      osc({ t, f: 520, f2: 380, a: 0.002, d: 0.08, g: 0.32 * v });
      noise({ t, d: 0.03, g: 0.4 * v, type: 'bandpass', f: 1600, q: 1.2 });
      osc({ t, f: 2500, a: 0.001, d: 0.015, g: 0.14 * v });
    },
    fret(t, v) {
      const f = rand(3000, 3800);
      osc({ t, f, a: 0.001, d: 0.03, g: 0.22 * v });
      osc({ t, f: f * 2.3, a: 0.001, d: 0.015, g: 0.08 * v });
      noise({ t, d: 0.008, g: 0.3 * v, type: 'highpass', f: 6000, q: 0.7 });
      osc({ t, f: 900, a: 0.001, d: 0.03, g: 0.12 * v });
    },
    land(t, v) {
      osc({ t, f: rand(700, 900), a: 0.001, d: 0.04, g: 0.22 * v });
      noise({ t, d: 0.015, g: 0.3 * v, type: 'bandpass', f: 2000, q: 1.5 });
    },
    settle(t) {
      osc({ t, f: 650, a: 0.001, d: 0.06, g: 0.32 });
      osc({ t, f: 1300, a: 0.001, d: 0.03, g: 0.1 });
      osc({ t: t + 0.075, f: 700, a: 0.001, d: 0.05, g: 0.16 });
    },
    // 盤の急加速でポケットから飛び出す「カコーン」
    eject(t, v) {
      osc({ t, f: 900, f2: 1500, glide: 0.06, a: 0.001, d: 0.06, g: 0.1 + 0.25 * v });
      noise({ t, d: 0.02, g: 0.2 + 0.4 * v, type: 'bandpass', f: 3200, q: 2 });
      noise({ t: t + 0.02, a: 0.02, d: 0.18, g: 0.1 + 0.15 * v, type: 'highpass', f: 1500, f2: 4500, q: 0.7 });
    },
    // マスに入った瞬間のズームアップ「シュワーン」
    zoom(t) {
      noise({ t: t + 0.08, a: 0.35, d: 0.45, g: 0.22, type: 'bandpass', f: 350, f2: 2400, glide: 0.6, q: 1.2 });
      osc({ t: t + 0.08, f: 110, f2: 220, glide: 0.6, a: 0.3, d: 0.5, g: 0.16 });
      bell(t + 0.75, 1568, 0.08, 0.9);
    },
  };

  // レトロゲームだけはボールの音も 8bit に
  THEMES.retro.ball = {
    roll: { kind: 'osc', type: 'square', fMin: 90, fMax: 360, lp: 1300, g: 0.08 },
    throw(t, v) {
      osc({ t, type: 'square', f: 300 + 200 * v, f2: 900 + 1100 * v, glide: 0.12, a: 0.003, d: 0.14, g: 0.2 });
    },
    drop(t) {
      osc({ t, type: 'square', f: 700, f2: 350, glide: 0.1, a: 0.003, d: 0.1, g: 0.14 });
    },
    diamond(t, v) {
      osc({ t, type: 'square', f: 1800, a: 0.001, d: 0.04, g: 0.18 * v });
    },
    rotor(t, v) {
      osc({ t, type: 'square', f: 300, f2: 180, a: 0.002, d: 0.07, g: 0.2 * v });
    },
    fret(t, v) {
      osc({ t, type: 'square', f: rand(1300, 1700), a: 0.001, d: 0.025, g: 0.16 * v });
    },
    land(t, v) {
      osc({ t, type: 'square', f: rand(500, 650), a: 0.001, d: 0.03, g: 0.14 * v });
    },
    settle(t) {
      chip({ t, type: 'square', f: 880, dur: 0.06, g: 0.12 });
      chip({ t: t + 0.07, type: 'square', f: 1320, dur: 0.1, g: 0.12 });
    },
    zoom(t) {
      osc({ t: t + 0.08, type: 'square', f: 200, f2: 900, glide: 0.55, a: 0.02, d: 0.6, g: 0.07 });
    },
    eject(t) {
      osc({ t, type: 'square', f: 500, f2: 1400, glide: 0.1, a: 0.002, d: 0.12, g: 0.16 });
    },
  };

  function ballSounds() {
    return theme().ball || BALL;
  }

  /* ------------------------------------------------------------------ */
  /* 回転中の持続音                                                        */
  /* ------------------------------------------------------------------ */

  function buildHum() {
    const p = theme().hum;
    const h = { themeId, p };
    let src;
    if (p.kind === 'osc') {
      src = ctx.createOscillator();
      src.type = p.type;
      src.frequency.value = p.fMin;
      h.osc = src;
    } else {
      src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      src.loop = true;
    }
    const filter = ctx.createBiquadFilter();
    if (p.kind === 'osc') {
      filter.type = 'lowpass';
      filter.frequency.value = p.lp;
      filter.Q.value = 0.7;
    } else {
      filter.type = p.type;
      filter.frequency.value = p.fMin;
      filter.Q.value = p.q;
    }
    // ピンを叩くリズムで「ブルルル」と揺らす
    const am = ctx.createGain();
    am.gain.value = 1 - p.depth / 2;
    const lfo = ctx.createOscillator();
    lfo.type = 'triangle';
    lfo.frequency.value = 5;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = p.depth / 2;
    const vol = ctx.createGain();
    vol.gain.value = 0;

    src.connect(filter);
    filter.connect(am);
    am.connect(vol);
    vol.connect(bus);
    lfo.connect(lfoGain);
    lfoGain.connect(am.gain);
    src.start();
    lfo.start();

    Object.assign(h, { src, filter, lfo, vol });
    return h;
  }

  function buildBallRoll() {
    const p = ballSounds().roll;
    const v = { themeId, p };
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(bus);
    if (p.kind === 'osc') {
      const o = ctx.createOscillator();
      o.type = p.type;
      o.frequency.value = p.fMin;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = p.lp;
      o.connect(lp);
      lp.connect(out);
      o.start();
      Object.assign(v, { srcs: [o], osc: o, out });
      return v;
    }
    // 転がる「ゴロゴロ」：高めのノイズを細かく揺らし、低いうなりを重ねる
    const hiSrc = ctx.createBufferSource();
    hiSrc.buffer = noiseBuffer;
    hiSrc.loop = true;
    const hi = ctx.createBiquadFilter();
    hi.type = 'bandpass';
    hi.frequency.value = p.fMin;
    hi.Q.value = p.q;
    const am = ctx.createGain();
    am.gain.value = 0.7;
    const lfo = ctx.createOscillator();
    lfo.type = 'triangle';
    lfo.frequency.value = 9;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.3;
    lfo.connect(lfoGain);
    lfoGain.connect(am.gain);
    hiSrc.connect(hi);
    hi.connect(am);
    am.connect(out);
    const loSrc = ctx.createBufferSource();
    loSrc.buffer = noiseBuffer;
    loSrc.loop = true;
    loSrc.loopStart = 1;
    const lo = ctx.createBiquadFilter();
    lo.type = 'lowpass';
    lo.frequency.value = 220;
    const loGain = ctx.createGain();
    loGain.gain.value = p.rumble;
    loSrc.connect(lo);
    lo.connect(loGain);
    loGain.connect(out);
    hiSrc.start();
    loSrc.start(0, 1);
    lfo.start();
    Object.assign(v, { srcs: [hiSrc, loSrc, lfo], hi, lo, lfo, out });
    return v;
  }

  // パワーをためている間の「ウィーン」（パワーに合わせて音の高さが上下する）
  function buildCharge() {
    const retro = themeId === 'retro';
    const o = ctx.createOscillator();
    o.type = retro ? 'square' : 'triangle';
    o.frequency.value = 220;
    const vib = ctx.createOscillator();
    vib.frequency.value = 7;
    const vibGain = ctx.createGain();
    vibGain.gain.value = retro ? 0 : 6;
    vib.connect(vibGain);
    vibGain.connect(o.frequency);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    const out = ctx.createGain();
    out.gain.value = 0;
    o.connect(lp);
    lp.connect(out);
    out.connect(bus);
    o.start();
    vib.start();
    return { themeId, osc: o, srcs: [o, vib], out, level: retro ? 0.05 : 0.1 };
  }

  function destroyCharge() {
    if (!chargeVoice) return;
    const v = chargeVoice;
    chargeVoice = null;
    const t = ctx.currentTime;
    v.out.gain.cancelScheduledValues(t);
    v.out.gain.setTargetAtTime(0, t, 0.02);
    setTimeout(() => {
      try {
        v.srcs.forEach((n) => n.stop());
        v.out.disconnect();
      } catch (e) { /* noop */ }
    }, 200);
  }

  function destroyBallRoll() {
    if (!ballRoll) return;
    const v = ballRoll;
    ballRoll = null;
    const t = ctx.currentTime;
    v.out.gain.cancelScheduledValues(t);
    v.out.gain.setTargetAtTime(0, t, 0.03);
    setTimeout(() => {
      try {
        v.srcs.forEach((n) => n.stop());
        v.out.disconnect();
      } catch (e) { /* noop */ }
    }, 300);
  }

  function destroyHum() {
    if (!hum) return;
    const h = hum;
    hum = null;
    const t = ctx.currentTime;
    h.vol.gain.cancelScheduledValues(t);
    h.vol.gain.setTargetAtTime(0, t, 0.03);
    setTimeout(() => {
      try { h.src.stop(); h.lfo.stop(); h.vol.disconnect(); } catch (e) { /* noop */ }
    }, 300);
  }

  /* ------------------------------------------------------------------ */
  /* 公開 API                                                             */
  /* ------------------------------------------------------------------ */

  const api = {
    THEMES: Object.keys(THEMES).map((id) => ({ id, name: THEMES[id].name, desc: THEMES[id].desc })),
    EVENTS: [
      { id: 'tick', name: 'カチカチ音', desc: '針がピンを越えるたび' },
      { id: 'boost', name: '加速音', desc: '左クリック' },
      { id: 'brake', name: '減速音', desc: '右クリック' },
      { id: 'hum', name: '回転音', desc: '速さに合わせてうなる' },
      { id: 'roll', name: 'ドラムロール', desc: '止まる直前に' },
      { id: 'result', name: '当選音', desc: 'ファンファーレ' },
      { id: 'ball', name: 'ボールの音', desc: '転がる・跳ねる（カジノ）' },
    ],

    unlock() {
      return ensure();
    },

    suspend() {
      if (ready() && ctx.state === 'running') ctx.suspend();
    },

    resume() {
      if (ready() && ctx.state === 'suspended') ctx.resume();
    },

    setVolume(v) {
      volume = Math.min(1, Math.max(0, v));
      if (master) master.gain.setTargetAtTime(outputGain(), ctx.currentTime, 0.02);
    },

    setMuted(m) {
      muted = !!m;
      if (master) master.gain.setTargetAtTime(outputGain(), ctx.currentTime, 0.02);
    },

    setTheme(id) {
      if (!THEMES[id]) return;
      themeId = id;
      if (hum && hum.themeId !== id) destroyHum();
      if (ballRoll && ballRoll.themeId !== id) destroyBallRoll();
    },

    setEnabled(key, on) {
      if (key in enabled) enabled[key] = !!on;
      if (key === 'roll' && !on) roll.active = false;
    },

    // 針がピンを越えた（norm: 速さ 0〜1。速いほど少し小さく）
    tick(norm = 0) {
      if (!ready() || muted || !enabled.tick) return;
      const now = ctx.currentTime;
      if (now - lastTickAt < 0.022) return; // 鳴らしすぎ防止
      lastTickAt = now;
      theme().tick(now + 0.002, 1 - 0.45 * Math.min(1, norm));
    },

    boost() {
      if (!ready() || muted || !enabled.boost) return;
      theme().boost(ctx.currentTime + 0.002);
    },

    brake() {
      if (!ready() || muted || !enabled.brake) return;
      theme().brake(ctx.currentTime + 0.002);
    },

    result() {
      if (!ready()) return;
      this.stopRoll();
      if (muted || !enabled.result) return;
      theme().result(ctx.currentTime + 0.02);
    },

    startRoll() {
      if (!ready() || !enabled.roll || roll.active) return;
      roll.active = true;
      roll.next = ctx.currentTime + 0.02;
    },

    setRollIntensity(v) {
      roll.intensity = Math.min(1, Math.max(0, v));
    },

    stopRoll() {
      roll.active = false;
    },

    get rolling() {
      return roll.active;
    },

    // 毎フレーム呼ぶ
    update(norm, tickRate, spinning) {
      if (!ready()) return;
      const now = ctx.currentTime;

      // 回転音
      const want = spinning && enabled.hum && !muted && norm > 0;
      if (want) {
        if (!hum || hum.themeId !== themeId) {
          destroyHum();
          hum = buildHum();
        }
        const p = hum.p;
        const n = Math.min(1, Math.max(0, norm));
        const target = p.g * Math.pow(n, 0.7);
        hum.vol.gain.setTargetAtTime(target, now, 0.08);
        if (p.kind === 'osc') {
          hum.osc.frequency.setTargetAtTime(p.fMin * Math.pow(p.fMax / p.fMin, n), now, 0.08);
        } else {
          hum.filter.frequency.setTargetAtTime(p.fMin * Math.pow(p.fMax / p.fMin, n), now, 0.08);
        }
        hum.lfo.frequency.setTargetAtTime(Math.min(70, Math.max(2, tickRate)), now, 0.05);
        humIdleSince = 0;
      } else if (hum) {
        hum.vol.gain.setTargetAtTime(0, now, 0.12);
        if (!humIdleSince) humIdleSince = now;
        if (now - humIdleSince > 1.2) {
          destroyHum();
          humIdleSince = 0;
        }
      }

      // ドラムロール（少し先まで予約して、リズムを揃える）
      if (roll.active && enabled.roll && !muted) {
        const th = theme();
        if (roll.next < now) roll.next = now + 0.01;
        while (roll.next < now + 0.12) {
          th.roll(roll.next, roll.intensity);
          roll.next += th.rollInterval;
        }
      }
    },

    /**
     * ボールの音（カジノモード）
     * @param {'throw'|'drop'|'diamond'|'rotor'|'fret'|'land'|'settle'} kind
     * @param {number} [v] 強さ 0〜1
     */
    /**
     * パワーをためている間の音（毎フレーム呼ぶ）
     * @param {number} power 0〜1。負の値で止める
     */
    updateCharge(power) {
      if (!ready()) return;
      const want = power >= 0 && enabled.ball && !muted;
      if (!want) {
        destroyCharge();
        return;
      }
      if (!chargeVoice || chargeVoice.themeId !== themeId) {
        destroyCharge();
        chargeVoice = buildCharge();
      }
      const now = ctx.currentTime;
      chargeVoice.osc.frequency.setTargetAtTime(200 + 700 * power, now, 0.012);
      chargeVoice.out.gain.setTargetAtTime(chargeVoice.level * (0.6 + 0.4 * power), now, 0.03);
    },

    // パワーが最大に届いた合図
    chargePeak() {
      if (!ready() || muted || !enabled.ball) return;
      const t = ctx.currentTime + 0.002;
      osc({ t, f: 1760, a: 0.001, d: 0.06, g: 0.07 });
      osc({ t, f: 2640, a: 0.001, d: 0.04, g: 0.035 });
    },

    ball(kind, v = 1) {
      if (!ready() || muted || !enabled.ball) return;
      const now = ctx.currentTime;
      if (kind === 'fret' || kind === 'land') {
        if (now - lastBallHitAt < 0.018) return;
        lastBallHitAt = now;
      }
      const fn = ballSounds()[kind];
      if (fn) fn(now + 0.002, Math.min(1, Math.max(0.15, v)));
    },

    /**
     * ボールが転がる音（毎フレーム呼ぶ）
     * @param {number} norm 速さ 0〜1
     * @param {'track'|'bowl'|'rotor'|null} where どこを転がっているか（null なら止める）
     */
    updateBall(norm, where) {
      if (!ready()) return;
      const now = ctx.currentTime;
      const want = !!where && enabled.ball && !muted && norm > 0.01;
      if (want) {
        if (!ballRoll || ballRoll.themeId !== themeId) {
          destroyBallRoll();
          ballRoll = buildBallRoll();
        }
        const p = ballRoll.p;
        const n = Math.min(1, Math.max(0, norm));
        const place = where === 'rotor' ? 0.45 : where === 'bowl' ? 0.8 : 1;
        ballRoll.out.gain.setTargetAtTime(p.g * Math.pow(n, 0.8) * place, now, 0.06);
        if (p.kind === 'osc') {
          ballRoll.osc.frequency.setTargetAtTime(p.fMin + (p.fMax - p.fMin) * n, now, 0.05);
        } else {
          ballRoll.hi.frequency.setTargetAtTime(p.fMin + (p.fMax - p.fMin) * n, now, 0.05);
          ballRoll.lo.frequency.setTargetAtTime(160 + 260 * n, now, 0.05);
          ballRoll.lfo.frequency.setTargetAtTime(5 + 22 * n * (0.85 + Math.random() * 0.3), now, 0.05);
        }
        ballIdleSince = 0;
      } else if (ballRoll) {
        ballRoll.out.gain.setTargetAtTime(0, now, 0.08);
        if (!ballIdleSince) ballIdleSince = now;
        if (now - ballIdleSince > 1) {
          destroyBallRoll();
          ballIdleSince = 0;
        }
      }
    },

    // 試聴：加速 → カチカチ（だんだん遅く）→ 当選
    preview(id) {
      if (!ensure()) return;
      if (muted) return;
      const th = theme(id);
      const t0 = ctx.currentTime + 0.05;
      th.boost(t0);
      let t = t0 + 0.18;
      let gap = 0.05;
      for (let i = 0; i < 16; i++) {
        th.tick(t, 1 - 0.3 * (1 - i / 16));
        gap *= 1.17;
        t += gap;
      }
      th.result(t + 0.15);
    },
  };

  global.RouletteSound = api;
})(window);
