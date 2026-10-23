/*
 * casino.js — カジノモード（ボールが入ったポケットが当たり）
 *
 *   layoutPockets … 項目をマスに並べる（等倍率のまま約38マスに増やし、交互に並べる）
 *   Ball          … ボールの動き（トラック → すり鉢 → ダイヤ → 回転部 → ポケット）
 *   draw*         … すり鉢・回転部・ボールの描画
 *
 * 寸法は「盤の外枠の半径 = 1」、時間は秒で計算しています。
 * 角度は canvas と同じく時計回りが正、真上が -π/2 です。
 * script.js から使いますが、DOM には触らないので Node.js でも動きます（シミュレーション用）。
 */
(function (root) {
  'use strict';

  const TAU = Math.PI * 2;
  const mod = (a, m) => ((a % m) + m) % m;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  /* ------------------------------------------------------------------ */
  /* 寸法と物理の定数                                                      */
  /* ------------------------------------------------------------------ */

  // 電球の外枠はなし。そのぶん文字の輪を広くとって、項目名を読みやすくしている
  const GEO = Object.freeze({
    TRACK_OUT: 0.975,  // ボールトラック（外側の溝）の外側。その外は細い真鍮のふち
    TRACK_IN: 0.885,   // ボールトラックの内側
    WALL: 0.95,        // ボールの中心が行ける一番外側（トラックの壁）
    DIAMOND: 0.83,     // ダイヤ（障害物）が並ぶ半径
    ROTOR: 0.765,      // 回転部の外周
    RING_IN: 0.49,     // 文字の輪の内側 ＝ ポケットの外側
    POCKET_IN: 0.38,   // ポケットの内側
    POCKET_MID: 0.435, // ポケットの真ん中
    TURRET: 0.12,      // 中央の取っ手
    BALL: 0.022,       // ボールの半径
  });

  const PHY = Object.freeze({
    // すり鉢（内向きの加速度。内側ほど急）
    G_WALL: 23,
    G_STEEP: 0.8,
    // トラック・すり鉢の摩擦
    MU_TRACK: 0.55,
    MU_WALL: 0.006,    // 壁に押しつけられる力に比例する摩擦
    MU_BOWL: 0.5,
    DRAG: 0.0012,      // 空気抵抗
    E_WALL: 0.1,
    // ダイヤ
    DIAMOND_LEN: 0.034,
    DIAMOND_W: 0.011,
    // 回転部
    G_RING: 14,        // 文字の輪 → ポケットへの傾き
    MU_RING: 0.6,
    MU_EDGE: 0.02,     // 回転部の縁に押しつけられたときの摩擦
    V_STEP: 0.5,       // 回転部からすり鉢へ登るのに必要な外向きの速さ
    E_STEP: 0.25,
    K_POCKET: 300,     // ポケットの底（真ん中へ戻す強さ）
    C_POCKET: 12,
    MU_POCKET: 0.9,
    G_CONE: 40,        // 中央の円すい（外へ押し出す）
    V_LIP: 0.7,        // ポケットから外へ飛び出すのに必要な速さ
    E_LIP: 0.3,
    FRET: 0.004,       // 仕切りの厚み（半分）
    V_HOP: 1.0,        // これより速いと仕切りを飛び越えることがある
    P_HOP: 0.75,
    SETTLE_V: 0.08,    // この速さ以下が続いたら止まったとみなす
    SETTLE_T: 0.3,
    // 計算
    STEP_DIST: 0.004,  // 1回の計算でボールが進む距離の目安
    MAX_SUBSTEPS: 400,
    OMEGA_MAX: 150,    // 物理計算に使う盤の角速度の上限（rad/s）
    FORCE_AFTER: 10,   // 落ちてからこの秒数を過ぎたらポケットに収まりやすくする
    GIVE_UP: 180,      // それでも収まらないときの最終手段
  });

  /* ------------------------------------------------------------------ */
  /* マスの並べ方                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * 各項目（行）を同じ数ずつマスにして、なるべく交互になるよう並べる。
   *   2項目・目安38 → 19マスずつ、A B A B … の38マス
   *   3項目・目安38 → 13マスずつ、39マス（38に一番近い、項目数で割り切れる数）
   * 同じ文字列の行が複数あれば、その文字列のマスはそのぶん多くなる（確率も行数に比例）。
   *
   * @param {{label:string,color:string,ink:string}[]} items
   * @param {number} target マス数の目安
   * @returns {{itemIndex:number,label:string,color:string,ink:string}[]}
   */
  function layoutPockets(items, target) {
    const n = items.length;
    if (!n) return [];
    const per = Math.max(1, Math.round(target / n));
    const groups = [];
    const byLabel = new Map();
    items.forEach((it, idx) => {
      let g = byLabel.get(it.label);
      if (!g) {
        g = { label: it.label, color: it.color, ink: it.ink, entries: [] };
        byLabel.set(it.label, g);
        groups.push(g);
      }
      g.entries.push(idx);
    });
    // 各マスに「理想の位置（0〜1）」を割り当てて並べると、どの項目も均等な間隔になる
    const slots = [];
    groups.forEach((g, gi) => {
      const count = g.entries.length * per;
      for (let j = 0; j < count; j++) slots.push({ key: (j + 0.5) / count, gi, j });
    });
    slots.sort((a, b) => a.key - b.key || a.gi - b.gi);
    return slots.map(({ gi, j }) => {
      const g = groups[gi];
      return { itemIndex: g.entries[j % g.entries.length], label: g.label, color: g.color, ink: g.ink };
    });
  }

  // 回転部の中での角度 → マスの番号
  function pocketIndexAt(localAngle, count) {
    if (!count) return -1;
    return Math.min(count - 1, Math.floor(mod(localAngle + Math.PI / 2, TAU) / (TAU / count)));
  }

  /* ------------------------------------------------------------------ */
  /* ダイヤ（すり鉢の障害物）                                               */
  /* ------------------------------------------------------------------ */

  const DIAMONDS = Array.from({ length: 8 }, (_, k) => {
    const a = (k / 8) * TAU + TAU / 16;
    const radial = k % 2 === 1; // 縦向き・横向きを交互に
    const cx = Math.cos(a) * GEO.DIAMOND;
    const cy = Math.sin(a) * GEO.DIAMOND;
    const ux = radial ? Math.cos(a) : -Math.sin(a);
    const uy = radial ? Math.sin(a) : Math.cos(a);
    const h = PHY.DIAMOND_LEN / 2;
    return { a, radial, cx, cy, ux, uy, x1: cx - ux * h, y1: cy - uy * h };
  });

  /* ------------------------------------------------------------------ */
  /* ボール                                                               */
  /* ------------------------------------------------------------------ */

  // すり鉢の傾き（内向きの加速度）
  function gBowl(r) {
    const t = clamp((GEO.WALL - r) / (GEO.WALL - GEO.ROTOR), 0, 1);
    return PHY.G_WALL * (1 + PHY.G_STEEP * t);
  }

  class Ball {
    constructor() {
      this.reset();
    }

    reset() {
      this.state = 'idle'; // idle / track / bowl / rotor / settled
      this.r = GEO.WALL;
      this.th = 0;         // 角度（盤の外から見た向き）
      this.vr = 0;         // 半径方向の速さ
      this.w = 0;          // 角速度（rad/s、時計回りが正）
      this.age = 0;
      this.dropped = false;
      this.sinceDrop = 0;
      this.forced = false;
      this.settleT = 0;
      this.stallT = 0;
      this.shake = 0;      // ポケットの中でカタッと揺れる大きさ（ラジアン）
      this.shakeT = 0;
      this.air = 0;        // 空中にいる残り時間（跳ねたとき）
      this.airDur = 0;
      this.lock = null;
      this.pocket = -1;
      this.appear = 0;
      this.trail = [];     // [r, th, r, th, …] このフレームで通った道
      this.trailPrev = [];
    }

    get inPlay() {
      return this.state === 'track' || this.state === 'bowl' || this.state === 'rotor';
    }

    /** トラックにボールを投げ入れる（omega は rad/s。反時計回りなら負） */
    launch(theta, omega) {
      this.reset();
      this.state = 'track';
      this.th = theta;
      this.w = omega;
    }

    rpm() {
      return (Math.abs(this.w) * 60) / TAU;
    }

    /** 描画用の位置。ポケットに収まった後は盤と一緒に回る */
    position(rotorAngle) {
      if (this.state === 'settled' && this.lock) {
        const k = easeOut(clamp(this.lock.t / 0.25, 0, 1));
        let lam = this.lock.from + (this.lock.to - this.lock.from) * k;
        // 盤が急に進むと、ボールは一瞬取り残されて（反時計回りに）揺れる
        if (this.shake > 0) lam -= this.shake * Math.exp(-this.shakeT / 0.16) * Math.sin(this.shakeT * 45);
        return {
          r: this.lock.fromR + (this.lock.toR - this.lock.fromR) * k,
          th: rotorAngle + lam,
        };
      }
      return { r: this.r, th: this.th };
    }

    /**
     * ポケットの中で揺らす（飛び出すほどではない加速を受けたとき）
     * @param {number} frac 飛び出すまでの割合 0〜1
     * @param {number} count マスの数
     */
    rattle(frac, count) {
      if (this.state !== 'settled') return;
      const alpha = TAU / Math.max(1, count);
      const room = Math.max(0, alpha / 2 - (GEO.BALL + PHY.FRET) / GEO.POCKET_MID);
      this.shake = room * clamp(frac, 0, 1) * 0.9;
      this.shakeT = 0;
    }

    /**
     * 盤の急な加速で、ポケットに収まっていたボールを弾き出す
     * @param {number} phi 盤の角度
     * @param {number} omega 加速したあとの盤の角速度（rad/s）
     * @param {number} jolt 加速でボールにかかった勢い（外枠の半径/秒）
     */
    eject(phi, omega, jolt, rand = Math.random) {
      if (this.state !== 'settled' || !this.lock) return false;
      const p = this.position(phi);
      const Om = clamp(omega, -PHY.OMEGA_MAX, PHY.OMEGA_MAX);
      this.r = p.r;
      this.th = p.th;
      // 盤だけが急に進むので、ボールは取り残されて盤に対して逆向きに動き、外へ跳ね上がる
      this.w = Om - (jolt * (0.75 + rand() * 0.35)) / this.r;
      this.vr = jolt * (0.25 + rand() * 0.45);
      this.state = 'rotor';
      this.lock = null;
      this.pocket = -1;
      this.settleT = 0;
      this.shake = 0;
      this.dropped = true;
      this.sinceDrop = 0;
      this.forced = false;
      this.age = 0;
      this.air = 0;
      this.airDur = 0;
      this.jump(clamp(0.08 + jolt * (0.04 + rand() * 0.04), 0.1, 0.4));
      this.trail = [this.r, this.th];
      this.trailPrev = [];
      return true;
    }

    /** 跳ねているときの高さ（見た目用、外枠の半径 = 1） */
    height() {
      if (this.air <= 0 || this.airDur <= 0) return 0;
      const p = 1 - this.air / this.airDur;
      return this.airDur * this.airDur * 1.1 * 4 * p * (1 - p);
    }

    jump(duration) {
      this.air = Math.max(this.air, duration);
      this.airDur = Math.max(this.airDur * (this.air > 0 ? 1 : 0), this.air);
    }

    /** ボールの下にあるマスの番号 */
    pocketUnder(rotorAngle, count) {
      if (this.state === 'settled') return this.pocket;
      return pocketIndexAt(this.th - rotorAngle, count);
    }

    /**
     * 1フレーム進める
     * @param {number} dt 秒
     * @param {number} phi0 このフレーム開始時の盤の角度
     * @param {number} omega 盤の角速度（rad/s）
     * @param {number} count マスの数
     * @param {() => number} [rand]
     * @returns {{type:string, v?:number, pocket?:number}[]} 起きたこと（音・演出用）
     */
    step(dt, phi0, omega, count, rand = Math.random) {
      const ev = [];
      if (this.state === 'idle') return ev;
      this.appear = Math.min(1, this.appear + dt / 0.18);
      if (this.state === 'settled') {
        if (this.lock) this.lock.t += dt;
        this.shakeT += dt;
        return ev;
      }

      const Om = clamp(omega, -PHY.OMEGA_MAX, PHY.OMEGA_MAX);
      this.age += dt;
      if (this.dropped) {
        this.sinceDrop += dt;
        if (this.sinceDrop > PHY.FORCE_AFTER) this.forced = true;
      }

      const speed = Math.hypot(this.vr, this.r * this.w) + Math.abs(Om) * this.r;
      const n = clamp(Math.ceil((speed * dt) / PHY.STEP_DIST), 1, PHY.MAX_SUBSTEPS);
      const h = dt / n;
      const every = Math.max(1, Math.floor(n / 12));
      this.trailPrev = this.trail;
      this.trail = [this.r, this.th];
      for (let i = 1; i <= n; i++) {
        this.sub(h, phi0 + Om * h * i, Om, count, rand, ev);
        if (this.state === 'settled') break;
        if (i % every === 0 || i === n) this.trail.push(this.r, this.th);
      }

      if (this.inPlay && this.age > PHY.GIVE_UP) this.settle(phi0 + Om * dt, count, ev);
      return ev;
    }

    sub(h, phi, Om, count, rand, ev) {
      if (this.air > 0) {
        this.fly(h, Om, ev);
        return;
      }
      const r = this.r;
      const onRotor = r < GEO.ROTOR;
      const inBand = onRotor && r < GEO.RING_IN && r >= GEO.POCKET_IN;
      const Os = onRotor ? Om : 0; // ボールの下の面の角速度

      // 傾き・ポケットの底による半径方向の力
      let Fr;
      let mu;
      if (!onRotor) {
        Fr = -gBowl(r);
        mu = r >= GEO.WALL - 1e-4 ? PHY.MU_TRACK : PHY.MU_BOWL;
      } else if (r >= GEO.RING_IN) {
        Fr = -PHY.G_RING;
        mu = PHY.MU_RING;
      } else if (r >= GEO.POCKET_IN) {
        Fr = -PHY.K_POCKET * (r - GEO.POCKET_MID) - PHY.C_POCKET * this.vr;
        mu = PHY.MU_POCKET;
      } else {
        Fr = PHY.G_CONE;
        mu = PHY.MU_RING;
      }
      if (this.forced) {
        // 長引いたとき：盤が速すぎても飛び出さないようにして、早めに収める
        mu *= 3;
        if (onRotor) Fr -= r * this.w * this.w;
      }

      // 壁に押しつけられているときは、その力に比例した摩擦も
      const outward = r * this.w * this.w + Fr;
      if (outward > 0) {
        if (r >= GEO.WALL - 1e-4) mu += PHY.MU_WALL * outward;
        else if (onRotor && r >= GEO.ROTOR - 2e-4) mu += PHY.MU_EDGE * outward;
      }

      const vt = r * this.w;
      const vtRel = r * (this.w - Os);
      const s = Math.hypot(this.vr, vtRel);
      let Ft = 0;
      if (s > 1e-9) {
        const f = Math.min(mu, s / h); // 摩擦で向きが逆転しないように
        Fr -= (f * this.vr) / s;
        Ft -= (f * vtRel) / s;
      }
      const v = Math.hypot(this.vr, vt);
      Fr -= PHY.DRAG * v * this.vr;
      Ft -= PHY.DRAG * v * vt;

      // 極座標の運動方程式（半陰的オイラー法）
      this.vr += (r * this.w * this.w + Fr) * h;
      this.w += ((Ft - 2 * this.vr * this.w) / r) * h;
      let nr = r + this.vr * h;
      this.th += this.w * h;

      // トラックの壁
      if (nr > GEO.WALL) {
        nr = GEO.WALL;
        if (this.vr > 0) this.vr = -PHY.E_WALL * this.vr;
      }
      // 回転部 → すり鉢（段差を登れなければ跳ね返る）
      if (r < GEO.ROTOR && nr >= GEO.ROTOR && (this.forced || this.vr < PHY.V_STEP)) {
        nr = GEO.ROTOR - 1e-4;
        this.vr = -PHY.E_STEP * this.vr;
      }
      // すり鉢 → 回転部に落ちた
      if (r >= GEO.ROTOR && nr < GEO.ROTOR) {
        ev.push({ type: 'rotor', v: Math.abs(this.vr) + 0.3 * Math.abs(r * (this.w - Om)) });
        this.vr *= 0.5;
        this.w += (rand() - 0.5) * 0.6;
        this.jump(0.06 + rand() * 0.08);
      }
      // ポケット → 文字の輪（よほど勢いがないと縁を越えられない）
      if (r < GEO.RING_IN && nr >= GEO.RING_IN && (this.forced || this.vr < PHY.V_LIP)) {
        nr = GEO.RING_IN - 1e-4;
        this.vr = -PHY.E_LIP * this.vr;
      }
      // 中央へ入り込みすぎない
      if (nr < GEO.POCKET_IN - 0.08) {
        nr = GEO.POCKET_IN - 0.08;
        if (this.vr < 0) this.vr = -0.3 * this.vr;
      }
      this.r = nr;

      if (!onRotor && Math.abs(nr - GEO.DIAMOND) < 0.06) this.hitDiamonds(rand, ev);

      // すり鉢の途中で止まりかけたら、転がり落ちるように少し押す
      if (!onRotor && nr < GEO.WALL - 1e-4) {
        this.stallT = Math.hypot(this.vr, nr * this.w) < 0.25 ? this.stallT + h : 0;
        if (this.stallT > 0.25) {
          this.w += ((rand() < 0.5 ? -1 : 1) * (0.6 + rand() * 0.6)) / nr;
          this.vr -= 0.3;
          this.stallT = 0;
        }
      }
      if (nr < GEO.RING_IN && nr >= GEO.POCKET_IN && nr < GEO.ROTOR) this.hitFrets(phi, Om, count, rand, ev);

      // 状態の更新
      const next = this.r < GEO.ROTOR ? 'rotor' : this.r >= GEO.WALL - 1e-4 ? 'track' : 'bowl';
      if (next !== this.state) {
        if (this.state === 'track' && next === 'bowl' && !this.dropped) {
          this.dropped = true;
          ev.push({ type: 'drop' });
        }
        this.state = next;
      }

      // ポケットに収まったか
      if (inBand && this.state === 'rotor') {
        const rel = Math.hypot(this.vr, this.r * (this.w - Om));
        if (rel < 0.03) {
          this.w = Om; // 静止摩擦：盤と一緒に回る
          this.vr *= 0.8;
        }
        this.settleT = rel < PHY.SETTLE_V ? this.settleT + h : 0;
        if (this.settleT >= PHY.SETTLE_T) this.settle(phi, count, ev);
      } else {
        this.settleT = 0;
      }
    }

    // 跳ねて空中にいる間：摩擦も傾きも仕切りもなし（トラックの壁だけ）
    fly(h, Om, ev) {
      const r = this.r;
      const vt = r * this.w;
      const v = Math.hypot(this.vr, vt);
      this.vr += (r * this.w * this.w - PHY.DRAG * v * this.vr) * h;
      this.w += ((-PHY.DRAG * v * vt - 2 * this.vr * this.w) / r) * h;
      let nr = r + this.vr * h;
      this.th += this.w * h;
      if (nr > GEO.WALL) {
        nr = GEO.WALL;
        if (this.vr > 0) this.vr = -PHY.E_WALL * this.vr;
      }
      if (nr < GEO.POCKET_IN - 0.06) {
        nr = GEO.POCKET_IN - 0.06;
        if (this.vr < 0) this.vr = -0.3 * this.vr;
      }
      if (r >= GEO.ROTOR && nr < GEO.ROTOR) ev.push({ type: 'rotor', v: Math.abs(this.vr) });
      this.r = nr;
      this.air -= h;
      if (this.air <= 0) {
        this.air = 0;
        this.airDur = 0;
        this.vr *= 0.6;
        ev.push({ type: 'land', v: Math.hypot(this.vr, this.r * (this.w - (this.r < GEO.ROTOR ? Om : 0))) });
      }
      this.state = this.r < GEO.ROTOR ? 'rotor' : this.r >= GEO.WALL - 1e-4 ? 'track' : 'bowl';
    }

    hitDiamonds(rand, ev) {
      const c = Math.cos(this.th);
      const s = Math.sin(this.th);
      const x = this.r * c;
      const y = this.r * s;
      const vt = this.r * this.w;
      let vx = this.vr * c - vt * s;
      let vy = this.vr * s + vt * c;
      const reach = GEO.BALL + PHY.DIAMOND_W;
      for (const d of DIAMONDS) {
        const t = clamp((x - d.x1) * d.ux + (y - d.y1) * d.uy, 0, PHY.DIAMOND_LEN);
        const dx = x - (d.x1 + d.ux * t);
        const dy = y - (d.y1 + d.uy * t);
        const dist = Math.hypot(dx, dy);
        if (dist >= reach || dist < 1e-9) continue;
        const nx = dx / dist;
        const ny = dy / dist;
        const vn = vx * nx + vy * ny;
        if (vn >= 0) continue;
        const e = 0.35 + rand() * 0.25;
        vx -= (1 + e) * vn * nx;
        vy -= (1 + e) * vn * ny;
        // はじかれる向きを少しランダムに
        const turn = (rand() - 0.5) * 0.5;
        const ct = Math.cos(turn);
        const st = Math.sin(turn);
        let rvx = (vx * ct - vy * st) * 0.92;
        let rvy = (vx * st + vy * ct) * 0.92;
        // ゆっくり当たったときは、ダイヤの端へ転がり落ちる
        if (Math.hypot(rvx, rvy) < 0.8) {
          const off = t - PHY.DIAMOND_LEN / 2;
          const side = Math.abs(off) > 1e-3 ? Math.sign(off) : rand() < 0.5 ? -1 : 1;
          rvx += d.ux * side * (0.5 + rand() * 0.4);
          rvy += d.uy * side * (0.5 + rand() * 0.4);
        }
        const px = d.x1 + d.ux * t + nx * reach;
        const py = d.y1 + d.uy * t + ny * reach;
        this.r = Math.hypot(px, py);
        this.th = Math.atan2(py, px) + Math.round((this.th - Math.atan2(py, px)) / TAU) * TAU;
        const c2 = Math.cos(this.th);
        const s2 = Math.sin(this.th);
        this.vr = rvx * c2 + rvy * s2;
        this.w = (-rvx * s2 + rvy * c2) / this.r;
        ev.push({ type: 'diamond', v: -vn });
        if (-vn > 1) this.jump(Math.min(0.2, -vn * 0.04));
        return;
      }
    }

    hitFrets(phi, Om, count, rand, ev) {
      if (count < 1) return;
      const alpha = TAU / count;
      const lim = (GEO.BALL + PHY.FRET) / this.r;
      if (alpha <= 2 * lim) return; // マスがボールより細いときは仕切りなし扱い
      const u = mod(this.th - phi + Math.PI / 2, alpha); // マスの中での位置
      const wRel = this.w - Om;
      let dir = 0;
      if (u < lim && wRel < 0) dir = -1;
      else if (alpha - u < lim && wRel > 0) dir = 1;
      if (!dir) return;
      const vRel = Math.abs(wRel) * this.r;
      if (!this.forced && vRel > PHY.V_HOP && rand() < PHY.P_HOP) {
        // 仕切りに当たって跳ね上がり、いくつか先のマスまで飛ぶ
        this.w = Om + wRel * (0.7 + rand() * 0.22);
        this.vr += (rand() - 0.4) * vRel * 0.2;
        this.th += dir * 2 * lim;
        this.jump(clamp(0.06 + vRel * (0.03 + rand() * 0.04), 0.07, 0.36));
      } else {
        // 仕切りに当たってはね返る
        const e = 0.35 + rand() * 0.35;
        this.w = Om - wRel * e;
        this.vr += (rand() - 0.45) * vRel * 0.45;
        this.th += dir === -1 ? lim - u : -(lim - (alpha - u));
        if (!this.forced && vRel > 0.6 && rand() < 0.5) this.jump(0.05 + rand() * 0.08);
      }
      ev.push({ type: 'fret', v: vRel });
    }

    settle(phi, count, ev) {
      const lam = this.th - phi;
      const i = pocketIndexAt(lam, count);
      const alpha = TAU / Math.max(1, count);
      let to = -Math.PI / 2 + (i + 0.5) * alpha;
      to += Math.round((lam - to) / TAU) * TAU; // 今の角度に近い表し方にそろえる
      this.lock = { from: lam, to, fromR: this.r, toR: GEO.POCKET_MID, t: 0 };
      this.pocket = i;
      this.state = 'settled';
      this.vr = 0;
      this.air = 0;
      this.airDur = 0;
      this.trail = [];
      this.trailPrev = [];
      ev.push({ type: 'settle', pocket: i });
    }
  }

  /* ------------------------------------------------------------------ */
  /* 色の小道具                                                            */
  /* ------------------------------------------------------------------ */

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function mix(hex, toward, t) {
    const a = hexToRgb(hex);
    const b = hexToRgb(toward);
    return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
  }

  function averageColor(colors, toward, t) {
    // 光として平均（リニア空間）
    const lin = (v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const enc = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
    const sum = [0, 0, 0];
    colors.forEach((hex) => {
      const rgb = hexToRgb(hex);
      const tb = hexToRgb(toward);
      rgb.forEach((v, i) => {
        sum[i] += lin(v + (tb[i] - v) * t);
      });
    });
    return `rgb(${sum.map((v) => Math.round(clamp(enc(v / colors.length), 0, 1) * 255)).join(',')})`;
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
    return lo ? chars.slice(0, lo).join('') + '…' : '';
  }

  function sector(c, x, y, r0, r1, a0, a1) {
    c.beginPath();
    c.arc(x, y, r1, a0, a1);
    c.arc(x, y, r0, a1, a0, true);
    c.closePath();
  }

  /* ------------------------------------------------------------------ */
  /* 描画：すり鉢（固定部分）                                               */
  /* ------------------------------------------------------------------ */

  function drawStator(c, cx, cy, R) {
    // 細い真鍮のふち
    const bezel = c.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    bezel.addColorStop(0, '#f7df97');
    bezel.addColorStop(0.3, '#dcab48');
    bezel.addColorStop(0.55, '#9c6d1b');
    bezel.addColorStop(0.8, '#d7a745');
    bezel.addColorStop(1, '#7a5313');
    c.beginPath();
    c.arc(cx, cy, R, 0, TAU);
    c.arc(cx, cy, GEO.TRACK_OUT * R, 0, TAU, true);
    c.fillStyle = bezel;
    c.fill('evenodd');
    c.lineWidth = Math.max(1, R * 0.005);
    c.strokeStyle = 'rgba(70, 45, 5, 0.7)';
    c.beginPath();
    c.arc(cx, cy, R - c.lineWidth / 2, 0, TAU);
    c.stroke();

    // トラック（外側の溝）
    const track = c.createRadialGradient(cx, cy, GEO.TRACK_IN * R, cx, cy, GEO.TRACK_OUT * R);
    track.addColorStop(0, '#2b140a');
    track.addColorStop(0.45, '#5b2c16');
    track.addColorStop(0.8, '#43200f');
    track.addColorStop(1, '#1d0d06');
    c.beginPath();
    c.arc(cx, cy, GEO.TRACK_OUT * R, 0, TAU);
    c.arc(cx, cy, GEO.TRACK_IN * R, 0, TAU, true);
    c.fillStyle = track;
    c.fill('evenodd');
    // 溝のツヤ
    c.lineWidth = Math.max(1, R * 0.004);
    c.strokeStyle = 'rgba(255, 220, 180, 0.16)';
    c.beginPath();
    c.arc(cx, cy, GEO.WALL * R, 0, TAU);
    c.stroke();

    // すり鉢
    const bowl = c.createRadialGradient(cx, cy, GEO.ROTOR * R, cx, cy, GEO.TRACK_IN * R);
    bowl.addColorStop(0, '#4a2a14');
    bowl.addColorStop(0.55, '#7b4a25');
    bowl.addColorStop(1, '#9a643a');
    c.beginPath();
    c.arc(cx, cy, GEO.TRACK_IN * R, 0, TAU);
    c.arc(cx, cy, GEO.ROTOR * R, 0, TAU, true);
    c.fillStyle = bowl;
    c.fill('evenodd');
    // 木目っぽい細い輪
    c.lineWidth = Math.max(0.5, R * 0.0015);
    for (let k = 0; k < 6; k++) {
      const rr = GEO.ROTOR + ((GEO.TRACK_IN - GEO.ROTOR) * (k + 0.5)) / 6;
      c.strokeStyle = `rgba(30, 12, 4, ${0.05 + (k % 2) * 0.04})`;
      c.beginPath();
      c.arc(cx, cy, rr * R, 0, TAU);
      c.stroke();
    }
    // トラックとすり鉢の境目
    c.lineWidth = Math.max(1, R * 0.005);
    c.strokeStyle = 'rgba(20, 8, 2, 0.6)';
    c.beginPath();
    c.arc(cx, cy, GEO.TRACK_IN * R, 0, TAU);
    c.stroke();

    // 回転部との隙間
    c.lineWidth = Math.max(1, R * 0.01);
    c.strokeStyle = '#140904';
    c.beginPath();
    c.arc(cx, cy, (GEO.ROTOR + 0.004) * R, 0, TAU);
    c.stroke();

    // ダイヤ
    DIAMONDS.forEach((d) => {
      const x = cx + d.cx * R;
      const y = cy + d.cy * R;
      const L = PHY.DIAMOND_LEN * R * 1.25;
      const W = PHY.DIAMOND_W * R * 1.9;
      const ang = Math.atan2(d.uy, d.ux);
      c.save();
      c.translate(x, y);
      c.rotate(ang);
      c.shadowColor = 'rgba(0, 0, 0, 0.45)';
      c.shadowBlur = R * 0.012;
      c.shadowOffsetY = R * 0.004;
      c.beginPath();
      c.moveTo(-L, 0);
      c.lineTo(0, -W);
      c.lineTo(L, 0);
      c.lineTo(0, W);
      c.closePath();
      const gr = c.createLinearGradient(0, -W, 0, W);
      gr.addColorStop(0, '#fbe7a6');
      gr.addColorStop(0.5, '#d4a443');
      gr.addColorStop(1, '#7d5715');
      c.fillStyle = gr;
      c.fill();
      c.shadowColor = 'transparent';
      c.lineWidth = Math.max(1, R * 0.003);
      c.strokeStyle = 'rgba(60, 38, 4, 0.7)';
      c.stroke();
      c.beginPath();
      c.moveTo(-L * 0.9, 0);
      c.lineTo(L * 0.9, 0);
      c.strokeStyle = 'rgba(255, 245, 210, 0.55)';
      c.stroke();
      c.restore();
    });
  }

  // すり鉢全体にうっすらツヤ
  function drawCasinoGloss(c, cx, cy, R) {
    const gl = c.createRadialGradient(cx - R * 0.32, cy - R * 0.42, R * 0.03, cx - R * 0.18, cy - R * 0.25, R * 0.95);
    gl.addColorStop(0, 'rgba(255, 255, 255, 0.16)');
    gl.addColorStop(0.5, 'rgba(255, 255, 255, 0.04)');
    gl.addColorStop(1, 'rgba(255, 255, 255, 0)');
    c.fillStyle = gl;
    c.beginPath();
    c.arc(cx, cy, GEO.TRACK_OUT * R, 0, TAU);
    c.fill();
  }

  /* ------------------------------------------------------------------ */
  /* 描画：回転部（ポケット・文字の輪・中央の円すい）                          */
  /* ------------------------------------------------------------------ */

  /**
   * @param {CanvasRenderingContext2D} c
   * @param {number} o キャンバス内の中心
   * @param {number} R 外枠の半径（px）
   * @param {{label:string,color:string,ink:string}[]} pockets
   * @param {{font:string, dpr:number, spun?:boolean}} opt spun=true で「速すぎて色が混ざった」見た目
   */
  function drawRotor(c, o, R, pockets, opt) {
    const P = pockets.length;
    const rRot = GEO.ROTOR * R;
    const rRing = GEO.RING_IN * R;
    const rPin = GEO.POCKET_IN * R;
    const alpha = TAU / Math.max(1, P);

    // 土台
    c.beginPath();
    c.arc(o, o, rRot, 0, TAU);
    c.fillStyle = '#2a170b';
    c.fill();

    if (opt.spun || !P) {
      const ring = P ? averageColor(pockets.map((p) => p.color), '#ffffff', 0.15) : '#8a8f9c';
      const pocket = P ? averageColor(pockets.map((p) => p.color), '#000000', 0.22) : '#5b606c';
      c.beginPath();
      c.arc(o, o, rRot - R * 0.006, 0, TAU);
      c.arc(o, o, rRing, 0, TAU, true);
      c.fillStyle = ring;
      c.fill('evenodd');
      c.beginPath();
      c.arc(o, o, rRing, 0, TAU);
      c.arc(o, o, rPin, 0, TAU, true);
      c.fillStyle = pocket;
      c.fill('evenodd');
      // 仕切りが溶けて見える真鍮色
      const fretShare = P ? Math.min(0.5, (P * R * 0.008) / (TAU * GEO.POCKET_MID * R)) : 0;
      c.fillStyle = `rgba(214, 170, 80, ${fretShare.toFixed(3)})`;
      c.fill('evenodd');
    } else {
      for (let i = 0; i < P; i++) {
        const a0 = -Math.PI / 2 + i * alpha;
        const a1 = a0 + alpha;
        sector(c, o, o, rRing, rRot - R * 0.006, a0, a1);
        c.fillStyle = mix(pockets[i].color, '#ffffff', 0.15);
        c.fill();
        sector(c, o, o, rPin, rRing, a0, a1);
        c.fillStyle = mix(pockets[i].color, '#000000', 0.22);
        c.fill();
      }
    }

    // ポケットの奥行き（外側ほど暗い）
    const depth = c.createRadialGradient(o, o, rPin, o, o, rRing);
    depth.addColorStop(0, 'rgba(0, 0, 0, 0.05)');
    depth.addColorStop(0.7, 'rgba(0, 0, 0, 0.12)');
    depth.addColorStop(1, 'rgba(0, 0, 0, 0.42)');
    c.beginPath();
    c.arc(o, o, rRing, 0, TAU);
    c.arc(o, o, rPin, 0, TAU, true);
    c.fillStyle = depth;
    c.fill('evenodd');

    if (!opt.spun && P) {
      // 文字の輪の区切り線
      if (P > 1) {
        c.strokeStyle = 'rgba(255, 255, 255, 0.75)';
        c.lineWidth = Math.max(1, R * 0.003);
        c.beginPath();
        for (let i = 0; i < P; i++) {
          const a = -Math.PI / 2 + i * alpha;
          c.moveTo(o + Math.cos(a) * rRing, o + Math.sin(a) * rRing);
          c.lineTo(o + Math.cos(a) * (rRot - R * 0.006), o + Math.sin(a) * (rRot - R * 0.006));
        }
        c.stroke();
      }
      // ポケットの仕切り（真鍮）
      const gap = alpha * GEO.POCKET_MID * R;
      if (gap > 3 * opt.dpr) {
        const fw = Math.max(1.2 * opt.dpr, Math.min(R * 0.009, gap * 0.18));
        for (let i = 0; i < P; i++) {
          const a = -Math.PI / 2 + i * alpha;
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          c.lineCap = 'round';
          c.lineWidth = fw;
          c.strokeStyle = '#8c6218';
          c.beginPath();
          c.moveTo(o + ca * rPin, o + sa * rPin);
          c.lineTo(o + ca * rRing, o + sa * rRing);
          c.stroke();
          c.lineWidth = fw * 0.45;
          c.strokeStyle = '#ffe9a8';
          c.beginPath();
          c.moveTo(o + ca * rPin - sa * fw * 0.15, o + sa * rPin + ca * fw * 0.15);
          c.lineTo(o + ca * rRing - sa * fw * 0.15, o + sa * rRing + ca * fw * 0.15);
          c.stroke();
        }
        c.lineCap = 'butt';
      }

      // 文字（中心から外へ向かって読む向き）
      //   入りきらなければ小さくする。それでも長ければ「…」で省略するが、最低3文字は見せる
      const arc = alpha * ((GEO.RING_IN + GEO.ROTOR) / 2) * R;
      const fs = Math.min(R * 0.055, arc * 0.62);
      if (fs >= 5 * opt.dpr) {
        c.textAlign = 'right';
        c.textBaseline = 'middle';
        const maxW = (GEO.ROTOR - GEO.RING_IN - 0.03) * R;
        const minFs = Math.min(fs, Math.max(8 * opt.dpr, fs * 0.6));
        const fit = new Map();
        for (let i = 0; i < P; i++) {
          const p = pockets[i];
          let f = fit.get(p.label);
          if (!f) {
            const chars = Array.from(p.label);
            c.font = `700 ${fs}px ${opt.font}`;
            const full = c.measureText(p.label).width;
            let size = fs;
            if (full > maxW) {
              size = (fs * maxW * 0.96) / full; // 全部入る大きさ
              if (size < minFs) {
                // 全部は無理：「3文字＋…」が必ず入る大きさにする
                const head = chars.slice(0, 3).join('') + '…';
                const hw = c.measureText(head).width;
                size = Math.min(fs, Math.max(minFs, (fs * maxW * 0.96) / full));
                if ((hw * size) / fs > maxW * 0.96) size = (fs * maxW * 0.96) / hw;
              }
            }
            c.font = `700 ${size}px ${opt.font}`;
            f = { size, text: ellipsize(c, p.label, maxW) };
            fit.set(p.label, f);
          }
          if (!f.text) continue;
          c.save();
          c.translate(o, o);
          c.rotate(-Math.PI / 2 + (i + 0.5) * alpha);
          c.font = `700 ${f.size}px ${opt.font}`;
          c.fillStyle = p.ink;
          c.fillText(f.text, (GEO.ROTOR - 0.018) * R, 0);
          c.restore();
        }
      }
    }

    // 真鍮の輪（文字の輪とポケットの境目、ポケットの内側）
    c.lineWidth = Math.max(1, R * 0.006);
    c.strokeStyle = '#c99a3c';
    c.beginPath();
    c.arc(o, o, rRing, 0, TAU);
    c.stroke();
    c.beginPath();
    c.arc(o, o, rPin, 0, TAU);
    c.stroke();
    c.lineWidth = Math.max(1, R * 0.004);
    c.strokeStyle = 'rgba(40, 20, 4, 0.8)';
    c.beginPath();
    c.arc(o, o, rRot - R * 0.003, 0, TAU);
    c.stroke();

    // 中央の円すい（木）
    const cone = c.createRadialGradient(o - rPin * 0.25, o - rPin * 0.3, rPin * 0.05, o, o, rPin);
    cone.addColorStop(0, '#b77a45');
    cone.addColorStop(0.6, '#7d4a25');
    cone.addColorStop(1, '#4d2a12');
    c.beginPath();
    c.arc(o, o, rPin - R * 0.003, 0, TAU);
    c.fillStyle = cone;
    c.fill();
    c.lineWidth = Math.max(0.5, R * 0.0015);
    for (let k = 1; k < 5; k++) {
      c.strokeStyle = 'rgba(30, 12, 4, 0.12)';
      c.beginPath();
      c.arc(o, o, rPin * (k / 5), 0, TAU);
      c.stroke();
    }

    // 取っ手（4本の腕）
    const arm = GEO.TURRET * R * 2.1;
    if (opt.spun) {
      c.beginPath();
      c.arc(o, o, arm, 0, TAU);
      c.fillStyle = 'rgba(214, 170, 80, 0.28)';
      c.fill();
    } else {
      for (let k = 0; k < 4; k++) {
        c.save();
        c.translate(o, o);
        c.rotate((k * Math.PI) / 2 + Math.PI / 4);
        const g = c.createLinearGradient(0, -R * 0.02, 0, R * 0.02);
        g.addColorStop(0, '#fff0bf');
        g.addColorStop(0.5, '#d4a443');
        g.addColorStop(1, '#7d5715');
        c.fillStyle = g;
        c.beginPath();
        c.moveTo(0, -R * 0.022);
        c.lineTo(arm - R * 0.02, -R * 0.012);
        c.arc(arm - R * 0.02, 0, R * 0.024, -Math.PI / 2, Math.PI / 2);
        c.lineTo(0, R * 0.022);
        c.closePath();
        c.fill();
        c.lineWidth = Math.max(1, R * 0.003);
        c.strokeStyle = 'rgba(60, 38, 4, 0.6)';
        c.stroke();
        c.restore();
      }
    }
    const tr = GEO.TURRET * R;
    const knob = c.createRadialGradient(o - tr * 0.35, o - tr * 0.4, tr * 0.08, o, o, tr);
    knob.addColorStop(0, '#fff3c8');
    knob.addColorStop(0.45, '#d9a845');
    knob.addColorStop(1, '#7a5313');
    c.beginPath();
    c.arc(o, o, tr * 0.72, 0, TAU);
    c.fillStyle = knob;
    c.fill();
    c.lineWidth = Math.max(1, R * 0.004);
    c.strokeStyle = 'rgba(60, 38, 4, 0.7)';
    c.stroke();
    c.beginPath();
    c.arc(o, o, tr * 0.28, 0, TAU);
    c.fillStyle = 'rgba(255, 250, 230, 0.55)';
    c.fill();
  }

  /* ------------------------------------------------------------------ */
  /* 描画：ボール                                                          */
  /* ------------------------------------------------------------------ */

  function drawTrail(c, cx, cy, R, pts, alpha) {
    if (pts.length < 4) return;
    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const segs = pts.length / 2 - 1;
    for (let i = 0; i < segs; i++) {
      const r0 = pts[i * 2];
      const t0 = pts[i * 2 + 1];
      const r1 = pts[i * 2 + 2];
      const t1 = pts[i * 2 + 3];
      const k = (i + 1) / segs;
      c.strokeStyle = `rgba(255, 250, 236, ${(alpha * k * 0.55).toFixed(3)})`;
      c.lineWidth = GEO.BALL * R * (0.9 + 0.8 * k);
      c.beginPath();
      c.moveTo(cx + Math.cos(t0) * r0 * R, cy + Math.sin(t0) * r0 * R);
      c.lineTo(cx + Math.cos(t1) * r1 * R, cy + Math.sin(t1) * r1 * R);
      c.stroke();
    }
    c.restore();
  }

  /**
   * @param {number} lift 跳ねている高さ（px）。影が離れて薄くなる
   */
  function drawBall(c, x, y, rad, alpha = 1, lift = 0) {
    c.save();
    c.globalAlpha = alpha;
    const sx = x + rad * 0.3 + lift * 0.5;
    const sy = y + rad * 0.5 + lift * 0.9;
    const sr = rad * 1.5 + lift * 0.4;
    const sh = c.createRadialGradient(sx, sy, 0, sx, sy, sr);
    sh.addColorStop(0, `rgba(0, 0, 0, ${(0.45 / (1 + lift / rad / 3)).toFixed(3)})`);
    sh.addColorStop(1, 'rgba(0, 0, 0, 0)');
    c.fillStyle = sh;
    c.beginPath();
    c.arc(sx, sy, sr, 0, TAU);
    c.fill();
    const body = c.createRadialGradient(x - rad * 0.38, y - rad * 0.42, rad * 0.08, x, y, rad);
    body.addColorStop(0, '#ffffff');
    body.addColorStop(0.35, '#f5f2ea');
    body.addColorStop(0.85, '#cfc9ba');
    body.addColorStop(1, '#a29c8e');
    c.fillStyle = body;
    c.beginPath();
    c.arc(x, y, rad, 0, TAU);
    c.fill();
    c.lineWidth = Math.max(0.75, rad * 0.08);
    c.strokeStyle = 'rgba(40, 32, 20, 0.35)';
    c.stroke();
    c.restore();
  }

  // 当たったマスを光らせる
  function drawPocketGlow(c, cx, cy, R, rotorAngle, count, index, pulse) {
    if (index < 0 || !count) return;
    const alpha = TAU / count;
    const a0 = rotorAngle - Math.PI / 2 + index * alpha;
    const a1 = a0 + alpha;
    c.save();
    sector(c, cx, cy, GEO.POCKET_IN * R, (GEO.ROTOR - 0.004) * R, a0, a1);
    c.fillStyle = `rgba(255, 236, 160, ${(0.12 + 0.18 * pulse).toFixed(3)})`;
    c.fill();
    c.shadowColor = 'rgba(255, 205, 80, 0.95)';
    c.shadowBlur = R * (0.02 + 0.03 * pulse);
    c.lineWidth = Math.max(1.5, R * 0.007);
    c.strokeStyle = '#ffe08a';
    c.stroke();
    c.restore();
  }

  const api = {
    GEO,
    PHY,
    layoutPockets,
    pocketIndexAt,
    Ball,
    drawStator,
    drawCasinoGloss,
    drawRotor,
    drawTrail,
    drawBall,
    drawPocketGlow,
  };

  root.Casino = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
