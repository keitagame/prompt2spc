// ============================================================================
// SPC Player Library (Web Audio API / Main Thread)
// ============================================================================

// ----------------------------------------------------------------------------
// ざらつき低減設定（ここだけ触れば調整できます）
// ----------------------------------------------------------------------------
const SMOOTH_CONFIG = {
  // true: 実機準拠の出力(DSPの16bit出力をそのまま使用)。false: 下の従来の後処理を適用
  hardwareAccurate: false,
  // ボイス補間: ウィンドウドsincのタップ数 (最大16)。多いほど折り返し/ジャリ感が減る
  interpTaps: 16,
  // 補間のカットオフ (1.0 = 16kHz)。下げるほど滑らか／こもる
  interpCutoff: 0.92,
  // 出力ローパス (4次バターワース = 2段Biquad)
  lowpassHz: 12500,
  // 出力ゲイン (旧: tanh飽和 x4 → 歪みの主因。リミッタ併用なので 3 前後が目安)
  outputGain: 3.0,
  // リミッタ天井 / リリース係数 (32kHzで毎サンプル適用)
  limiterCeil: 0.98,
  limiterRelease: 0.9998,
  // 既存の「臨場感」エフェクト (コムフィルタ的な金属感が気になる場合は false)
  earlyReflections: true,
  stereoWidth: 1.0,
  // 出力側 32kHz→AudioContext レート変換のsincタップ数
  resampleTaps: 8
};

function _besselI0(x) {
  let sum = 1, term = 1;
  for (let k = 1; k < 40; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

// Kaiser窓付きsincの分数遅延テーブルを作る。tap k は位置 (1 - half + k) - t に対応
function buildKaiserSincTable(taps, phases, cutoff, beta) {
  const half = taps / 2;
  const table = new Float32Array(phases * taps);
  const i0b = _besselI0(beta);
  for (let p = 0; p < phases; p++) {
    const t = p / phases;
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      const x = (1 - half + k) - t;
      const fx = x * cutoff;
      const sinc = Math.abs(fx) < 1e-9 ? 1 : Math.sin(Math.PI * fx) / (Math.PI * fx);
      const r = x / half;
      const win = Math.abs(r) >= 1 ? 0 : _besselI0(beta * Math.sqrt(1 - r * r)) / i0b;
      const w = sinc * win;
      table[p * taps + k] = w;
      sum += w;
    }
    for (let k = 0; k < taps; k++) table[p * taps + k] /= sum; // 直流ゲイン=1
  }
  return table;
}

/**
 * SPC700 CPU Emulator
 */
// ============================================================================
// リアル音響エフェクト（臨場感向上処理）
// ============================================================================

// アナログ真空管・テープ風の温かみと滑らかなダイナミクスを与えるサチュレーション
function analogSaturation(x) {
  return Math.tanh(x * 1.15) * 0.9;
}

// 空間の奥行きと広がりを生み出すアーリーリフレクション（初期反射音）
class EarlyReflections {
  constructor(sampleRate = 32000) {
    this.bufferL = new Float32Array(2048);
    this.bufferR = new Float32Array(2048);
    this.pos = 0;
    
    // 反射音のディレイタイム（ミリ秒）と減衰量
    this.tapsL = [
      { delay: Math.floor(sampleRate * 0.011), gain: 0.22 },
      { delay: Math.floor(sampleRate * 0.024), gain: 0.15 },
      { delay: Math.floor(sampleRate * 0.038), gain: 0.10 }
    ];
    this.tapsR = [
      { delay: Math.floor(sampleRate * 0.014), gain: 0.20 },
      { delay: Math.floor(sampleRate * 0.029), gain: 0.13 },
      { delay: Math.floor(sampleRate * 0.042), gain: 0.08 }
    ];
  }

  reset() {
    this.bufferL.fill(0);
    this.bufferR.fill(0);
    this.pos = 0;
  }

  process(inL, inR) {
    const mask = 2047;
    this.bufferL[this.pos] = inL;
    this.bufferR[this.pos] = inR;

    let refL = 0, refR = 0;
    for (let i = 0; i < this.tapsL.length; i++) {
      const t = this.tapsL[i];
      refL += this.bufferL[(this.pos - t.delay) & mask] * t.gain;
    }
    for (let i = 0; i < this.tapsR.length; i++) {
      const t = this.tapsR[i];
      refR += this.bufferR[(this.pos - t.delay) & mask] * t.gain;
    }

    this.pos = (this.pos + 1) & mask;
    return [inL + refL, inR + refR];
  }
}

// ステレオ感を自然に広げる Mid-Side エンハンサー
function applyStereoEnhancer(inL, inR, width = SMOOTH_CONFIG.stereoWidth) {
  const mid = (inL + inR) * 0.5;
  const side = (inL - inR) * 0.5 * width;
  return [mid + side, mid - side];
}
class SPC700 {
  constructor(dsp) {
    this.dsp = dsp;
    this.ram = new Uint8Array(0x10000);

    this.A = 0;
    this.X = 0;
    this.Y = 0;
    this.SP = 0;
    this.PC = 0;

    this.flagN = 0;
    this.flagV = 0;
    this.flagP = 0;
    this.flagB = 0;
    this.flagH = 0;
    this.flagI = 0;
    this.flagZ = 0;
    this.flagC = 0;

    this.ioIn = new Uint8Array(4);
    this.ioOut = new Uint8Array(4);
    this.timerEnable = [0, 0, 0];
    this.timerTarget = [0, 0, 0];
    this.timerCounter = [0, 0, 0];
    this.timerOut = [0, 0, 0];
    this._tAccum = [0, 0, 0];
    this.romEnable = true;
    this.cycles = 0;
    this.halted = false;

    this.bootRom = new Uint8Array([
      0xcd, 0xef, 0xbd, 0xe8, 0x00, 0xc6, 0x1d, 0xd0, 0xfc, 0x8f, 0xaa, 0xf4, 0x8f, 0xbb, 0xf5, 0x78,
      0xcc, 0xf4, 0xd0, 0xfb, 0x2f, 0x19, 0xeb, 0xf4, 0xd0, 0xfc, 0x7e, 0xf4, 0xd0, 0x0b, 0xe4, 0xf5,
      0xcb, 0xf4, 0xd7, 0x00, 0xfc, 0xd0, 0xf3, 0xab, 0x01, 0x10, 0xef, 0x7e, 0xf4, 0x10, 0xeb, 0xba,
      0xf6, 0xda, 0x00, 0xba, 0xf4, 0xc4, 0xf4, 0xdd, 0x5d, 0xd0, 0xdb, 0x1f, 0x00, 0x00, 0xc0, 0xff
    ]);
    
    this._buildOpTable();
  }

  read(addr) {
    addr &= 0xffff;
    if (addr >= 0xf0 && addr <= 0xff) {
      switch (addr) {
        case 0xf2: return this.dsp.regAddr;
        case 0xf3: return this.dsp.read(this.dsp.regAddr & 0x7f);
        case 0xf4: case 0xf5: case 0xf6: case 0xf7:
          return this.ioIn[addr - 0xf4];
        case 0xf8: case 0xf9:
          return this.ram[addr];
        case 0xfd: return this.readTimerOut(0);
        case 0xfe: return this.readTimerOut(1);
        case 0xff: return this.readTimerOut(2);
        default:
          return 0;
      }
    }
    if (addr >= 0xffc0 && this.romEnable) {
      return this.bootRom[addr & 0x3f];
    }
    return this.ram[addr];
  }

  write(addr, val) {
    addr &= 0xffff;
    val &= 0xff;
    switch (addr) {
      case 0xf0:
        break;
      case 0xf1: {
        for (let t = 0; t < 3; t++) {
          const en = (val >> t) & 1;
          if (en && !this.timerEnable[t]) {
            this.timerCounter[t] = 0;
            this.timerOut[t] = 0;
          }
          this.timerEnable[t] = en;
        }
        if (val & 0x10) { this.ioIn[0] = 0; this.ioIn[1] = 0; }
        if (val & 0x20) { this.ioIn[2] = 0; this.ioIn[3] = 0; }
        this.romEnable = (val & 0x80) !== 0;
        break;
      }
      case 0xf2:
        this.dsp.regAddr = val;
        break;
      case 0xf3:
        if (!(this.dsp.regAddr & 0x80)) this.dsp.write(this.dsp.regAddr & 0x7f, val);
        break;
      case 0xf4: case 0xf5: case 0xf6: case 0xf7:
        this.ioOut[addr - 0xf4] = val;
        break;
      case 0xfa: this.timerTarget[0] = val; break;
      case 0xfb: this.timerTarget[1] = val; break;
      case 0xfc: this.timerTarget[2] = val; break;
    }
    this.ram[addr] = val;
  }

  readTimerOut(t) {
    const v = this.timerOut[t] & 0x0f;
    this.timerOut[t] = 0;
    return v;
  }

  tickTimers(cyc) {
    const periods = [128, 128, 16];
    for (let t = 0; t < 3; t++) {
      // 第1段(分周器)は有効/無効に関係なく常に動いている
      this._tAccum[t] += cyc;
      while (this._tAccum[t] >= periods[t]) {
        this._tAccum[t] -= periods[t];
        if (!this.timerEnable[t]) continue;
        this.timerCounter[t] = (this.timerCounter[t] + 1) & 0xff;
        if (this.timerCounter[t] === this.timerTarget[t]) {
          this.timerCounter[t] = 0;
          this.timerOut[t] = (this.timerOut[t] + 1) & 0x0f;
        }
      }
    }
  }

  getPSW() {
    return (this.flagN << 7) | (this.flagV << 6) | (this.flagP << 5) |
           (this.flagB << 4) | (this.flagH << 3) | (this.flagI << 2) |
           (this.flagZ << 1) | (this.flagC);
  }

  setPSW(v) {
    this.flagN = (v >> 7) & 1;
    this.flagV = (v >> 6) & 1;
    this.flagP = (v >> 5) & 1;
    this.flagB = (v >> 4) & 1;
    this.flagH = (v >> 3) & 1;
    this.flagI = (v >> 2) & 1;
    this.flagZ = (v >> 1) & 1;
    this.flagC = v & 1;
  }

  dpBase() { return this.flagP ? 0x100 : 0x000; }

  setNZ8(v) {
    v &= 0xff;
    this.flagZ = v === 0 ? 1 : 0;
    this.flagN = (v & 0x80) ? 1 : 0;
    return v;
  }

  push8(v) { this.ram[0x100 + this.SP] = v & 0xff; this.SP = (this.SP - 1) & 0xff; }
  pop8() { this.SP = (this.SP + 1) & 0xff; return this.ram[0x100 + this.SP]; }
  push16(v) { this.push8((v >> 8) & 0xff); this.push8(v & 0xff); }
  pop16() { const lo = this.pop8(); const hi = this.pop8(); return (hi << 8) | lo; }

  fetch8() { const v = this.read(this.PC); this.PC = (this.PC + 1) & 0xffff; return v; }
  fetch16() { const lo = this.fetch8(); const hi = this.fetch8(); return (hi << 8) | lo; }

  dp(off) { return (this.dpBase() | (off & 0xff)); }
  dpNext(a) { return (a & 0x100) | ((a + 1) & 0xff); }
  rd16dp(a) { return this.read(a) | (this.read(this.dpNext(a)) << 8); }
  wr16dp(a, w) { this.write(a, w & 0xff); this.write(this.dpNext(a), (w >> 8) & 0xff); }

  adc(a, b, carryIn) {
    const result = a + b + carryIn;
    this.flagH = ((a & 0xf) + (b & 0xf) + carryIn) > 0xf ? 1 : 0;
    this.flagC = result > 0xff ? 1 : 0;
    const r8 = result & 0xff;
    this.flagV = (~(a ^ b) & (a ^ r8) & 0x80) ? 1 : 0;
    this.setNZ8(r8);
    return r8;
  }

  sbc(a, b, carryIn) {
    return this.adc(a, (~b) & 0xff, carryIn);
  }

  step() {
    // SLEEP/STOP後はCPUだけ止まり、タイマーとDSPは動き続ける
    const op = this.halted ? 0x00 : this.fetch8();
    const cyc = this.halted ? 2 : this._exec(op);
    this.cycles += cyc;
    this.tickTimers(cyc);
    return cyc;
  }

  _exec(op) {
    const fn = this.opTable[op];
    if (!fn) return 2;
    return fn.call(this);
  }

  _branch(cond, disp) {
    if (cond) {
      const s = disp & 0x80 ? disp - 256 : disp;
      this.PC = (this.PC + s) & 0xffff;
      return 2;
    }
    return 0;
  }

  _buildOpTable() {
    const T = new Array(256).fill(null);
    const rd = (addr) => this.read(addr);
    const wr = (addr, v) => this.write(addr, v);

    T[0x00] = function () { return 2; };
    T[0xE8] = function () { const v = this.fetch8(); this.A = this.setNZ8(v); return 2; };
    T[0xCD] = function () { const v = this.fetch8(); this.X = this.setNZ8(v); return 2; };
    T[0x8D] = function () { const v = this.fetch8(); this.Y = this.setNZ8(v); return 2; };

    T[0x7D] = function () { this.A = this.setNZ8(this.X); return 2; };
    T[0xDD] = function () { this.A = this.setNZ8(this.Y); return 2; };
    T[0x5D] = function () { this.X = this.setNZ8(this.A); return 2; };
    T[0xFD] = function () { this.Y = this.setNZ8(this.A); return 2; };
    T[0x9D] = function () { this.X = this.setNZ8(this.SP); return 2; };
    T[0xBD] = function () { this.SP = this.X; return 2; };

    T[0xC4] = function () { const a = this.dp(this.fetch8()); wr(a, this.A); return 4; };
    T[0xE4] = function () { const a = this.dp(this.fetch8()); this.A = this.setNZ8(rd(a)); return 3; };
    T[0xD8] = function () { const a = this.dp(this.fetch8()); wr(a, this.X); return 4; };
    T[0xF8] = function () { const a = this.dp(this.fetch8()); this.X = this.setNZ8(rd(a)); return 3; };
    T[0xCB] = function () { const a = this.dp(this.fetch8()); wr(a, this.Y); return 4; };
    T[0xEB] = function () { const a = this.dp(this.fetch8()); this.Y = this.setNZ8(rd(a)); return 3; };

    T[0xD4] = function () { const a = this.dp((this.fetch8() + this.X) & 0xff); wr(a, this.A); return 5; };
    T[0xF4] = function () { const a = this.dp((this.fetch8() + this.X) & 0xff); this.A = this.setNZ8(rd(a)); return 4; };
    T[0xD9] = function () { const a = this.dp((this.fetch8() + this.Y) & 0xff); wr(a, this.X); return 5; };
    T[0xF9] = function () { const a = this.dp((this.fetch8() + this.Y) & 0xff); this.X = this.setNZ8(rd(a)); return 4; };
    T[0xDB] = function () { const a = this.dp((this.fetch8() + this.X) & 0xff); wr(a, this.Y); return 5; };
    T[0xFB] = function () { const a = this.dp((this.fetch8() + this.X) & 0xff); this.Y = this.setNZ8(rd(a)); return 4; };

    T[0xC5] = function () { const a = this.fetch16(); wr(a, this.A); return 5; };
    T[0xE5] = function () { const a = this.fetch16(); this.A = this.setNZ8(rd(a)); return 4; };
    T[0xC9] = function () { const a = this.fetch16(); wr(a, this.X); return 5; };
    T[0xE9] = function () { const a = this.fetch16(); this.X = this.setNZ8(rd(a)); return 4; };
    T[0xCC] = function () { const a = this.fetch16(); wr(a, this.Y); return 5; };
    T[0xEC] = function () { const a = this.fetch16(); this.Y = this.setNZ8(rd(a)); return 4; };

    T[0xD5] = function () { const a = (this.fetch16() + this.X) & 0xffff; wr(a, this.A); return 6; };
    T[0xD6] = function () { const a = (this.fetch16() + this.Y) & 0xffff; wr(a, this.A); return 6; };
    T[0xF5] = function () { const a = (this.fetch16() + this.X) & 0xffff; this.A = this.setNZ8(rd(a)); return 5; };
    T[0xF6] = function () { const a = (this.fetch16() + this.Y) & 0xffff; this.A = this.setNZ8(rd(a)); return 5; };

    T[0xC6] = function () { wr(this.dp(this.X), this.A); return 4; };
    T[0xE6] = function () { this.A = this.setNZ8(rd(this.dp(this.X))); return 3; };
    T[0xAF] = function () { wr(this.dp(this.X), this.A); this.X = (this.X + 1) & 0xff; return 4; };
    T[0xBF] = function () { this.A = this.setNZ8(rd(this.dp(this.X))); this.X = (this.X + 1) & 0xff; return 4; };

    T[0xC7] = function () {
      const ptr = this.dp((this.fetch8() + this.X) & 0xff);
      const a = this.rd16dp(ptr);
      wr(a, this.A); return 7;
    };
    T[0xE7] = function () {
      const ptr = this.dp((this.fetch8() + this.X) & 0xff);
      const a = this.rd16dp(ptr);
      this.A = this.setNZ8(rd(a)); return 6;
    };
    T[0xD7] = function () {
      const ptr = this.dp(this.fetch8());
      const base = this.rd16dp(ptr);
      const a = (base + this.Y) & 0xffff;
      wr(a, this.A); return 7;
    };
    T[0xF7] = function () {
      const ptr = this.dp(this.fetch8());
      const base = this.rd16dp(ptr);
      const a = (base + this.Y) & 0xffff;
      this.A = this.setNZ8(rd(a)); return 6;
    };

    T[0xFA] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, rd(src)); return 5; };
    T[0x8F] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, v); return 5; };

    T[0xBA] = function () {
      const a = this.dp(this.fetch8());
      const lo = rd(a); const hi = rd(this.dpNext(a));
      this.A = lo; this.Y = hi;
      this.flagZ = (lo | hi) === 0 ? 1 : 0;
      this.flagN = (hi & 0x80) ? 1 : 0;
      return 5;
    };
    T[0xDA] = function () {
      const a = this.dp(this.fetch8());
      rd(a);
      wr(a, this.A); wr(this.dpNext(a), this.Y);
      return 5;
    };
    T[0x3A] = function () {
      const a = this.dp(this.fetch8());
      const w = (this.rd16dp(a) + 1) & 0xffff;
      this.wr16dp(a, w);
      this.flagZ = w === 0 ? 1 : 0; this.flagN = (w & 0x8000) ? 1 : 0;
      return 6;
    };
    T[0x1A] = function () {
      const a = this.dp(this.fetch8());
      const w = (this.rd16dp(a) - 1) & 0xffff;
      this.wr16dp(a, w);
      this.flagZ = w === 0 ? 1 : 0; this.flagN = (w & 0x8000) ? 1 : 0;
      return 6;
    };
    T[0x7A] = function () {
      const a = this.dp(this.fetch8());
      const ya = (this.Y << 8) | this.A;
      const m = this.rd16dp(a);
      const result = ya + m;
      const r16 = result & 0xffff;
      this.flagC = result > 0xffff ? 1 : 0;
      this.flagV = (~(ya ^ m) & (ya ^ r16) & 0x8000) ? 1 : 0;
      this.flagH = (((ya & 0xfff) + (m & 0xfff)) > 0xfff) ? 1 : 0;
      this.Y = (r16 >> 8) & 0xff; this.A = r16 & 0xff;
      this.flagZ = r16 === 0 ? 1 : 0; this.flagN = (r16 & 0x8000) ? 1 : 0;
      return 5;
    };
    T[0x9A] = function () {
      const a = this.dp(this.fetch8());
      const ya = (this.Y << 8) | this.A;
      const m = this.rd16dp(a);
      const mInv = (~m) & 0xffff;
      const result = ya + mInv + 1;
      const r16 = result & 0xffff;
      this.flagC = result > 0xffff ? 1 : 0;
      this.flagV = (~(ya ^ mInv) & (ya ^ r16) & 0x8000) ? 1 : 0;
      this.flagH = (((ya & 0xfff) + (mInv & 0xfff) + 1) > 0xfff) ? 1 : 0;
      this.Y = (r16 >> 8) & 0xff; this.A = r16 & 0xff;
      this.flagZ = r16 === 0 ? 1 : 0; this.flagN = (r16 & 0x8000) ? 1 : 0;
      return 5;
    };
    T[0x5A] = function () {
      const a = this.dp(this.fetch8());
      const ya = (this.Y << 8) | this.A;
      const m = this.rd16dp(a);
      const result = (ya - m) & 0xffff;
      this.flagC = ya >= m ? 1 : 0;
      this.flagZ = result === 0 ? 1 : 0;
      this.flagN = (result & 0x8000) ? 1 : 0;
      return 4;
    };

    T[0x08] = function () { const v = this.fetch8(); this.A = this.setNZ8(this.A | v); return 2; };
    T[0x28] = function () { const v = this.fetch8(); this.A = this.setNZ8(this.A & v); return 2; };
    T[0x48] = function () { const v = this.fetch8(); this.A = this.setNZ8(this.A ^ v); return 2; };
    T[0x68] = function () { const v = this.fetch8(); const r = (this.A - v) & 0x1ff; this.flagC = this.A >= v ? 1 : 0; this.setNZ8(r); return 2; };
    T[0x88] = function () { const v = this.fetch8(); this.A = this.adc(this.A, v, this.flagC); return 2; };
    T[0xA8] = function () { const v = this.fetch8(); this.A = this.sbc(this.A, v, this.flagC); return 2; };

    T[0x04] = function () { const v = rd(this.dp(this.fetch8())); this.A = this.setNZ8(this.A | v); return 3; };
    T[0x24] = function () { const v = rd(this.dp(this.fetch8())); this.A = this.setNZ8(this.A & v); return 3; };
    T[0x44] = function () { const v = rd(this.dp(this.fetch8())); this.A = this.setNZ8(this.A ^ v); return 3; };
    T[0x64] = function () { const v = rd(this.dp(this.fetch8())); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 3; };
    T[0x84] = function () { const v = rd(this.dp(this.fetch8())); this.A = this.adc(this.A, v, this.flagC); return 3; };
    T[0xA4] = function () { const v = rd(this.dp(this.fetch8())); this.A = this.sbc(this.A, v, this.flagC); return 3; };

    T[0x14] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.A = this.setNZ8(this.A | v); return 4; };
    T[0x34] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.A = this.setNZ8(this.A & v); return 4; };
    T[0x54] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.A = this.setNZ8(this.A ^ v); return 4; };
    T[0x74] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 4; };
    T[0x94] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.A = this.adc(this.A, v, this.flagC); return 4; };
    T[0xB4] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.A = this.sbc(this.A, v, this.flagC); return 4; };

    T[0x05] = function () { const v = rd(this.fetch16()); this.A = this.setNZ8(this.A | v); return 4; };
    T[0x25] = function () { const v = rd(this.fetch16()); this.A = this.setNZ8(this.A & v); return 4; };
    T[0x45] = function () { const v = rd(this.fetch16()); this.A = this.setNZ8(this.A ^ v); return 4; };
    T[0x65] = function () { const v = rd(this.fetch16()); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 4; };
    T[0x85] = function () { const v = rd(this.fetch16()); this.A = this.adc(this.A, v, this.flagC); return 4; };
    T[0xA5] = function () { const v = rd(this.fetch16()); this.A = this.sbc(this.A, v, this.flagC); return 4; };

    T[0x15] = function () { const v = rd((this.fetch16() + this.X) & 0xffff); this.A = this.setNZ8(this.A | v); return 5; };
    T[0x16] = function () { const v = rd((this.fetch16() + this.Y) & 0xffff); this.A = this.setNZ8(this.A | v); return 5; };
    T[0x35] = function () { const v = rd((this.fetch16() + this.X) & 0xffff); this.A = this.setNZ8(this.A & v); return 5; };
    T[0x36] = function () { const v = rd((this.fetch16() + this.Y) & 0xffff); this.A = this.setNZ8(this.A & v); return 5; };
    T[0x55] = function () { const v = rd((this.fetch16() + this.X) & 0xffff); this.A = this.setNZ8(this.A ^ v); return 5; };
    T[0x56] = function () { const v = rd((this.fetch16() + this.Y) & 0xffff); this.A = this.setNZ8(this.A ^ v); return 5; };
    T[0x75] = function () { const v = rd((this.fetch16() + this.X) & 0xffff); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 5; };
    T[0x76] = function () { const v = rd((this.fetch16() + this.Y) & 0xffff); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 5; };
    T[0x95] = function () { const v = rd((this.fetch16() + this.X) & 0xffff); this.A = this.adc(this.A, v, this.flagC); return 5; };
    T[0x96] = function () { const v = rd((this.fetch16() + this.Y) & 0xffff); this.A = this.adc(this.A, v, this.flagC); return 5; };
    T[0xB5] = function () { const v = rd((this.fetch16() + this.X) & 0xffff); this.A = this.sbc(this.A, v, this.flagC); return 5; };
    T[0xB6] = function () { const v = rd((this.fetch16() + this.Y) & 0xffff); this.A = this.sbc(this.A, v, this.flagC); return 5; };

    T[0x06] = function () { const v = rd(this.dp(this.X)); this.A = this.setNZ8(this.A | v); return 3; };
    T[0x26] = function () { const v = rd(this.dp(this.X)); this.A = this.setNZ8(this.A & v); return 3; };
    T[0x46] = function () { const v = rd(this.dp(this.X)); this.A = this.setNZ8(this.A ^ v); return 3; };
    T[0x66] = function () { const v = rd(this.dp(this.X)); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 3; };
    T[0x86] = function () { const v = rd(this.dp(this.X)); this.A = this.adc(this.A, v, this.flagC); return 3; };
    T[0xA6] = function () { const v = rd(this.dp(this.X)); this.A = this.sbc(this.A, v, this.flagC); return 3; };

    T[0x07] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = this.rd16dp(ptr); const v = rd(a); this.A = this.setNZ8(this.A | v); return 6; };
    T[0x27] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = this.rd16dp(ptr); const v = rd(a); this.A = this.setNZ8(this.A & v); return 6; };
    T[0x47] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = this.rd16dp(ptr); const v = rd(a); this.A = this.setNZ8(this.A ^ v); return 6; };
    T[0x67] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = this.rd16dp(ptr); const v = rd(a); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 6; };
    T[0x87] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = this.rd16dp(ptr); const v = rd(a); this.A = this.adc(this.A, v, this.flagC); return 6; };
    T[0xA7] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = this.rd16dp(ptr); const v = rd(a); this.A = this.sbc(this.A, v, this.flagC); return 6; };

    T[0x17] = function () { const ptr = this.dp(this.fetch8()); const base = this.rd16dp(ptr); const v = rd((base+this.Y)&0xffff); this.A = this.setNZ8(this.A | v); return 6; };
    T[0x37] = function () { const ptr = this.dp(this.fetch8()); const base = this.rd16dp(ptr); const v = rd((base+this.Y)&0xffff); this.A = this.setNZ8(this.A & v); return 6; };
    T[0x57] = function () { const ptr = this.dp(this.fetch8()); const base = this.rd16dp(ptr); const v = rd((base+this.Y)&0xffff); this.A = this.setNZ8(this.A ^ v); return 6; };
    T[0x77] = function () { const ptr = this.dp(this.fetch8()); const base = this.rd16dp(ptr); const v = rd((base+this.Y)&0xffff); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 6; };
    T[0x97] = function () { const ptr = this.dp(this.fetch8()); const base = this.rd16dp(ptr); const v = rd((base+this.Y)&0xffff); this.A = this.adc(this.A, v, this.flagC); return 6; };
    T[0xB7] = function () { const ptr = this.dp(this.fetch8()); const base = this.rd16dp(ptr); const v = rd((base+this.Y)&0xffff); this.A = this.sbc(this.A, v, this.flagC); return 6; };

    T[0x09] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.setNZ8(rd(dst) | rd(src))); return 6; };
    T[0x29] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.setNZ8(rd(dst) & rd(src))); return 6; };
    T[0x49] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.setNZ8(rd(dst) ^ rd(src))); return 6; };
    T[0x69] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); const a=rd(dst), b=rd(src); this.flagC = a>=b?1:0; this.setNZ8((a-b)&0x1ff); return 6; };
    T[0x89] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.adc(rd(dst), rd(src), this.flagC)); return 6; };
    T[0xA9] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.sbc(rd(dst), rd(src), this.flagC)); return 6; };

    T[0x18] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) | v)); return 5; };
    T[0x38] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) & v)); return 5; };
    T[0x58] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) ^ v)); return 5; };
    T[0x78] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); const m = rd(a); this.flagC = m>=v?1:0; this.setNZ8((m-v)&0x1ff); return 5; };
    T[0x98] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.adc(rd(a), v, this.flagC)); return 5; };
    T[0xB8] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.sbc(rd(a), v, this.flagC)); return 5; };

    T[0x19] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.setNZ8(rd(dstA) | rd(srcA))); return 5; };
    T[0x39] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.setNZ8(rd(dstA) & rd(srcA))); return 5; };
    T[0x59] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.setNZ8(rd(dstA) ^ rd(srcA))); return 5; };
    T[0x79] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); const a=rd(dstA), b=rd(srcA); this.flagC=a>=b?1:0; this.setNZ8((a-b)&0x1ff); return 5; };
    T[0x99] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.adc(rd(dstA), rd(srcA), this.flagC)); return 5; };
    T[0xB9] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.sbc(rd(dstA), rd(srcA), this.flagC)); return 5; };

    T[0xC8] = function () { const v = this.fetch8(); this.flagC = this.X>=v?1:0; this.setNZ8((this.X-v)&0x1ff); return 2; };
    T[0xAD] = function () { const v = this.fetch8(); this.flagC = this.Y>=v?1:0; this.setNZ8((this.Y-v)&0x1ff); return 2; };
    T[0x3E] = function () { const v = rd(this.dp(this.fetch8())); this.flagC = this.X>=v?1:0; this.setNZ8((this.X-v)&0x1ff); return 3; };
    T[0x7E] = function () { const v = rd(this.dp(this.fetch8())); this.flagC = this.Y>=v?1:0; this.setNZ8((this.Y-v)&0x1ff); return 3; };
    T[0x1E] = function () { const v = rd(this.fetch16()); this.flagC = this.X>=v?1:0; this.setNZ8((this.X-v)&0x1ff); return 4; };
    T[0x5E] = function () { const v = rd(this.fetch16()); this.flagC = this.Y>=v?1:0; this.setNZ8((this.Y-v)&0x1ff); return 4; };

    T[0xBC] = function () { this.A = this.setNZ8(this.A + 1); return 2; };
    T[0x9C] = function () { this.A = this.setNZ8(this.A - 1); return 2; };
    T[0x3D] = function () { this.X = this.setNZ8(this.X + 1); return 2; };
    T[0x1D] = function () { this.X = this.setNZ8(this.X - 1); return 2; };
    T[0xFC] = function () { this.Y = this.setNZ8(this.Y + 1); return 2; };
    T[0xDC] = function () { this.Y = this.setNZ8(this.Y - 1); return 2; };

    T[0xAB] = function () { const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) + 1)); return 4; };
    T[0x8B] = function () { const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) - 1)); return 4; };
    T[0xBB] = function () { const a = this.dp((this.fetch8()+this.X)&0xff); wr(a, this.setNZ8(rd(a) + 1)); return 5; };
    T[0x9B] = function () { const a = this.dp((this.fetch8()+this.X)&0xff); wr(a, this.setNZ8(rd(a) - 1)); return 5; };
    T[0xAC] = function () { const a = this.fetch16(); wr(a, this.setNZ8(rd(a) + 1)); return 5; };
    T[0x8C] = function () { const a = this.fetch16(); wr(a, this.setNZ8(rd(a) - 1)); return 5; };

    const asl = (v) => { const c = (v & 0x80) ? 1 : 0; const r = (v << 1) & 0xff; this.flagC = c; return this.setNZ8(r); };
    const lsr = (v) => { const c = v & 1; const r = (v >> 1) & 0xff; this.flagC = c; return this.setNZ8(r); };
    const rol = (v) => { const c = (v & 0x80) ? 1 : 0; const r = ((v << 1) | this.flagC) & 0xff; this.flagC = c; return this.setNZ8(r); };
    const ror = (v) => { const c = v & 1; const r = ((v >> 1) | (this.flagC << 7)) & 0xff; this.flagC = c; return this.setNZ8(r); };

    T[0x1C] = function () { this.A = asl(this.A); return 2; };
    T[0x0B] = function () { const a=this.dp(this.fetch8()); wr(a, asl(rd(a))); return 4; };
    T[0x1B] = function () { const a=this.dp((this.fetch8()+this.X)&0xff); wr(a, asl(rd(a))); return 5; };
    T[0x0C] = function () { const a=this.fetch16(); wr(a, asl(rd(a))); return 5; };

    T[0x5C] = function () { this.A = lsr(this.A); return 2; };
    T[0x4B] = function () { const a=this.dp(this.fetch8()); wr(a, lsr(rd(a))); return 4; };
    T[0x5B] = function () { const a=this.dp((this.fetch8()+this.X)&0xff); wr(a, lsr(rd(a))); return 5; };
    T[0x4C] = function () { const a=this.fetch16(); wr(a, lsr(rd(a))); return 5; };

    T[0x3C] = function () { this.A = rol(this.A); return 2; };
    T[0x2B] = function () { const a=this.dp(this.fetch8()); wr(a, rol(rd(a))); return 4; };
    T[0x3B] = function () { const a=this.dp((this.fetch8()+this.X)&0xff); wr(a, rol(rd(a))); return 5; };
    T[0x2C] = function () { const a=this.fetch16(); wr(a, rol(rd(a))); return 5; };

    T[0x7C] = function () { this.A = ror(this.A); return 2; };
    T[0x6B] = function () { const a=this.dp(this.fetch8()); wr(a, ror(rd(a))); return 4; };
    T[0x7B] = function () { const a=this.dp((this.fetch8()+this.X)&0xff); wr(a, ror(rd(a))); return 5; };
    T[0x6C] = function () { const a=this.fetch16(); wr(a, ror(rd(a))); return 5; };

    T[0x9F] = function () { this.A = this.setNZ8(((this.A << 4) | (this.A >> 4)) & 0xff); return 5; };

    T[0xCF] = function () {
      const r = (this.Y & 0xff) * (this.A & 0xff);
      this.A = r & 0xff; this.Y = (r >> 8) & 0xff;
      this.setNZ8(this.Y);
      return 9;
    };

    T[0x9E] = function () {
      const ya = (this.Y << 8) | this.A;
      const x = this.X;
      this.flagH = ((this.Y & 0xf) >= (x & 0xf)) ? 1 : 0;
      this.flagV = (this.Y >= x) ? 1 : 0;
      if (this.Y < (x << 1)) {
        this.A = Math.floor(ya / x) & 0xff;
        this.Y = (ya % x) & 0xff;
      } else {
        const d = 256 - x;
        this.A = (255 - Math.floor((ya - (x << 9)) / d)) & 0xff;
        this.Y = (x + ((ya - (x << 9)) % d)) & 0xff;
      }
      this.setNZ8(this.A);
      return 12;
    };

    T[0xDF] = function () {
      let a = this.A;
      if (this.flagC || a > 0x99) { a = (a + 0x60) & 0xff; this.flagC = 1; }
      if (this.flagH || (a & 0x0f) > 9) { a = (a + 0x06) & 0xff; }
      this.A = this.setNZ8(a);
      return 3;
    };
    T[0xBE] = function () {
      let a = this.A;
      if (!this.flagC || a > 0x99) { a = (a - 0x60) & 0xff; this.flagC = 0; }
      if (!this.flagH || (a & 0x0f) > 9) { a = (a - 0x06) & 0xff; }
      this.A = this.setNZ8(a);
      return 3;
    };

    T[0x60] = function () { this.flagC = 0; return 2; };
    T[0x80] = function () { this.flagC = 1; return 2; };
    T[0xED] = function () { this.flagC = this.flagC ^ 1; return 3; };
    T[0x20] = function () { this.flagP = 0; return 2; };
    T[0x40] = function () { this.flagP = 1; return 2; };
    T[0xE0] = function () { this.flagV = 0; this.flagH = 0; return 2; };
    T[0xA0] = function () { this.flagI = 1; return 3; };
    T[0xC0] = function () { this.flagI = 0; return 3; };

    T[0x2D] = function () { this.push8(this.A); return 4; };
    T[0x4D] = function () { this.push8(this.X); return 4; };
    T[0x6D] = function () { this.push8(this.Y); return 4; };
    T[0x0D] = function () { this.push8(this.getPSW()); return 4; };
    T[0xAE] = function () { this.A = this.pop8(); return 4; };
    T[0xCE] = function () { this.X = this.pop8(); return 4; };
    T[0xEE] = function () { this.Y = this.pop8(); return 4; };
    T[0x8E] = function () { this.setPSW(this.pop8()); return 4; };

    T[0x2F] = function () { const d = this.fetch8(); const s=d&0x80?d-256:d; this.PC=(this.PC+s)&0xffff; return 4; };
    T[0xF0] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagZ===1, d); };
    T[0xD0] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagZ===0, d); };
    T[0xB0] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagC===1, d); };
    T[0x90] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagC===0, d); };
    T[0x70] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagV===1, d); };
    T[0x50] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagV===0, d); };
    T[0x30] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagN===1, d); };
    T[0x10] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagN===0, d); };

    for (let bit = 0; bit < 8; bit++) {
      const opSet = 0x03 | (bit << 5);
      const opClr = 0x13 | (bit << 5);
      T[opSet] = function () {
        const a = this.dp(this.fetch8()); const d = this.fetch8();
        const v = rd(a);
        return 5 + this._branch(((v >> bit) & 1) === 1, d);
      };
      T[opClr] = function () {
        const a = this.dp(this.fetch8()); const d = this.fetch8();
        const v = rd(a);
        return 5 + this._branch(((v >> bit) & 1) === 0, d);
      };
    }

    T[0x2E] = function () { const a=this.dp(this.fetch8()); const d=this.fetch8(); const v=rd(a); return 5 + this._branch(this.A!==v, d); };
    T[0xDE] = function () { const a=this.dp((this.fetch8()+this.X)&0xff); const d=this.fetch8(); const v=rd(a); return 6 + this._branch(this.A!==v, d); };

    T[0xFE] = function () { const d=this.fetch8(); this.Y=(this.Y-1)&0xff; return 4 + this._branch(this.Y!==0, d); };
    T[0x6E] = function () { const a=this.dp(this.fetch8()); const d=this.fetch8(); let v=rd(a); v=(v-1)&0xff; wr(a,v); return 5 + this._branch(v!==0, d); };

    T[0x5F] = function () { this.PC = this.fetch16(); return 3; };
    T[0x1F] = function () { const base = this.fetch16(); const ptr=(base+this.X)&0xffff; this.PC = rd(ptr) | (rd((ptr+1)&0xffff)<<8); return 6; };

    T[0x3F] = function () { const a = this.fetch16(); this.push16(this.PC); this.PC = a; return 8; };
    T[0x4F] = function () { const a = 0xFF00 | this.fetch8(); this.push16(this.PC); this.PC = a; return 6; };
    for (let n = 0; n < 16; n++) {
      const op = 0x01 | (n << 4);
      T[op] = function () {
        const vecAddr = 0xFFDE - n * 2;
        const target = rd(vecAddr) | (rd((vecAddr + 1) & 0xffff) << 8);
        this.push16(this.PC);
        this.PC = target;
        return 8;
      };
    }

    T[0x6F] = function () { this.PC = this.pop16(); return 5; };
    T[0x7F] = function () { this.setPSW(this.pop8()); this.PC = this.pop16(); return 6; };

    T[0x0F] = function () {
      this.push16(this.PC);
      this.push8(this.getPSW());
      this.flagB = 1; this.flagI = 0;
      this.PC = rd(0xFFDE) | (rd(0xFFDF) << 8);
      return 8;
    };

    T[0xEF] = function () { this.halted = true; return 7; }; // SLEEP: 割り込みが無いので実質停止
    T[0xFF] = function () { this.halted = true; return 7; }; // STOP

    T[0xAA] = function () {
      const w = this.fetch16(); const addr = w & 0x1fff; const bit = (w >> 13) & 7;
      const v = rd(addr);
      this.flagC = (v >> bit) & 1;
      return 4;
    };
    T[0xCA] = function () {
      const w = this.fetch16(); const addr = w & 0x1fff; const bit = (w >> 13) & 7;
      let v = rd(addr);
      if (this.flagC) v |= (1 << bit); else v &= ~(1 << bit);
      wr(addr, v & 0xff);
      return 6;
    };

    T[0x4A] = function () { const w=this.fetch16(); const addr=w&0x1fff; const bit=(w>>13)&7; const v=(rd(addr)>>bit)&1; this.flagC = this.flagC & v; return 4; };
    T[0x6A] = function () { const w=this.fetch16(); const addr=w&0x1fff; const bit=(w>>13)&7; const v=(rd(addr)>>bit)&1; this.flagC = this.flagC & (v^1); return 4; };
    T[0x0A] = function () { const w=this.fetch16(); const addr=w&0x1fff; const bit=(w>>13)&7; const v=(rd(addr)>>bit)&1; this.flagC = this.flagC | v; return 5; };
    T[0x2A] = function () { const w=this.fetch16(); const addr=w&0x1fff; const bit=(w>>13)&7; const v=(rd(addr)>>bit)&1; this.flagC = this.flagC | (v^1); return 5; };
    T[0x8A] = function () { const w=this.fetch16(); const addr=w&0x1fff; const bit=(w>>13)&7; const v=(rd(addr)>>bit)&1; this.flagC = this.flagC ^ v; return 5; };

    T[0xEA] = function () { const w=this.fetch16(); const addr=w&0x1fff; const bit=(w>>13)&7; let v=rd(addr); v ^= (1<<bit); wr(addr, v&0xff); return 5; };

    for (let bit = 0; bit < 8; bit++) {
      const opSet = 0x02 | (bit << 5);
      const opClr = 0x12 | (bit << 5);
      T[opSet] = function () { const a=this.dp(this.fetch8()); let v=rd(a); v |= (1<<bit); wr(a, v&0xff); return 4; };
      T[opClr] = function () { const a=this.dp(this.fetch8()); let v=rd(a); v &= ~(1<<bit); wr(a, v&0xff); return 4; };
    }

    T[0x0E] = function () { const a=this.fetch16(); const v=rd(a); this.setNZ8((this.A - v) & 0x1ff); wr(a, v | this.A); return 6; };
    T[0x4E] = function () { const a=this.fetch16(); const v=rd(a); this.setNZ8((this.A - v) & 0x1ff); wr(a, v & (~this.A & 0xff)); return 6; };

    this.opTable = T;
  }
}
// --- 定数変更 (7kHzから12kHzへ引き上げて音抜けを改善) ---
const LP_CUTOFF_HZ = SMOOTH_CONFIG.lowpassHz;

// 2次Biquadローパスフィルタークラス
class BiquadLPF {
  constructor(cutoff, sampleRate, Q = 0.7071) {
    const w0 = 2 * Math.PI * cutoff / sampleRate;
    const alpha = Math.sin(w0) / (2 * Q);
    const cosw0 = Math.cos(w0);

    const b0 = (1 - cosw0) / 2;
    const b1 = 1 - cosw0;
    const b2 = (1 - cosw0) / 2;
    const a0 = 1 + alpha;
    const a1 = -2 * cosw0;
    const a2 = 1 - alpha;

    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;

    this.x1 = 0; this.x2 = 0;
    this.y1 = 0; this.y2 = 0;
  }

  reset() {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }

  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}
// 4次バターワース (Q = 0.5412 / 1.3066 の2段直列): 通過域は平坦、高域ノイズだけ急峻に落とす
class LPF4 {
  constructor(cutoff, sampleRate) {
    this.a = new BiquadLPF(cutoff, sampleRate, 0.5412);
    this.b = new BiquadLPF(cutoff, sampleRate, 1.3066);
  }
  reset() { this.a.reset(); this.b.reset(); }
  process(x) { return this.b.process(this.a.process(x)); }
}

function finalSoftClip(x) {
  const t = 0.92, ax = Math.abs(x);
  if (ax <= t) return x;
  const y = t + (1 - t) * Math.tanh((ax - t) / (1 - t));
  return x < 0 ? -y : y;
}
const SDSP_RATE = 32000;

// ==== S-DSP CORE BEGIN ====================================================
// SNES S-DSP (Sony CXD1222Q-1) 実機準拠エミュレーション
//  - 32クロック(=1サンプル)パイプラインを実機と同じ順序で実行する
//  - 補間は実機ROMと同じ512エントリのGaussテーブル(4タップ)
//  - BRRデコード / エンベロープ / カウンタ / ノイズ / エコー(FIR) / KON遅延 を整数演算で再現
//  - 出力は実機DACと同じ符号付き16bit (L/R)
// ボイス/マスターの音量計算・クランプ・切り捨ての位置まで実機に合わせてある。

const DSP_COUNTER_RATE = [
  0, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192,
  160, 128, 96, 80, 64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1
];
const DSP_COUNTER_OFFSET = [
  0, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536,
  0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 0, 0
];
const DSP_COUNTER_PERIOD = 0x7800; // 2048 * 5 * 3

// 実機の512エントリGaussテーブル
const DSP_GAUSS = new Int16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6, 7, 7, 7, 8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15, 15, 16, 16, 17, 17, 18, 19, 19, 20, 20, 21, 21, 22, 23, 23, 24, 24, 25, 26, 27, 27, 28, 29, 29, 30, 31, 32, 32, 33, 34, 35, 36, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 58, 59, 60, 61, 62, 64, 65, 66, 67, 69, 70, 71, 73, 74, 76, 77, 78, 80, 81, 83, 84, 86, 87, 89, 90, 92, 94, 95, 97, 99, 100, 102, 104, 106, 107, 109, 111, 113, 115, 117, 118, 120, 122, 124, 126, 128, 130, 132, 134, 137, 139, 141, 143, 145, 147, 150, 152, 154, 156, 159, 161, 163, 166, 168, 171, 173, 175, 178, 180, 183, 186, 188, 191, 193, 196, 199, 201, 204, 207, 210, 212, 215, 218, 221, 224, 227, 230, 233, 236, 239, 242, 245, 248, 251, 254, 257, 260, 263, 267, 270, 273, 276, 280, 283, 286, 290, 293, 297, 300, 304, 307, 311, 314, 318, 321, 325, 328, 332, 336, 339, 343, 347, 351, 354, 358, 362, 366, 370, 374, 378, 381, 385, 389, 393, 397, 401, 405, 410, 414, 418, 422, 426, 430, 434, 439, 443, 447, 451, 456, 460, 464, 469, 473, 477, 482, 486, 491, 495, 499, 504, 508, 513, 517, 522, 527, 531, 536, 540, 545, 550, 554, 559, 563, 568, 573, 577, 582, 587, 592, 596, 601, 606, 611, 615, 620, 625, 630, 635, 640, 644, 649, 654, 659, 664, 669, 674, 678, 683, 688, 693, 698, 703, 708, 713, 718, 723, 728, 732, 737, 742, 747, 752, 757, 762, 767, 772, 777, 782, 787, 792, 797, 802, 806, 811, 816, 821, 826, 831, 836, 841, 846, 851, 855, 860, 865, 870, 875, 880, 884, 889, 894, 899, 904, 908, 913, 918, 923, 927, 932, 937, 941, 946, 951, 955, 960, 965, 969, 974, 978, 983, 988, 992, 997, 1001, 1005, 1010, 1014, 1019, 1023, 1027, 1032, 1036, 1040, 1045, 1049, 1053, 1057, 1061, 1066, 1070, 1074, 1078, 1082, 1086, 1090, 1094, 1098, 1102, 1106, 1109, 1113, 1117, 1121, 1125, 1128, 1132, 1136, 1139, 1143, 1146, 1150, 1153, 1157, 1160, 1164, 1167, 1170, 1174, 1177, 1180, 1183, 1186, 1190, 1193, 1196, 1199, 1202, 1205, 1207, 1210, 1213, 1216, 1219, 1221, 1224, 1227, 1229, 1232, 1234, 1237, 1239, 1241, 1244, 1246, 1248, 1251, 1253, 1255, 1257, 1259, 1261, 1263, 1265, 1267, 1269, 1270, 1272, 1274, 1275, 1277, 1279, 1280, 1282, 1283, 1284, 1286, 1287, 1288, 1290, 1291, 1292, 1293, 1294, 1295, 1296, 1297, 1297, 1298, 1299, 1300, 1300, 1301, 1302, 1302, 1303, 1303, 1303, 1304, 1304, 1304, 1304, 1304, 1305, 1305]);

const ENV_RELEASE = 0, ENV_ATTACK = 1, ENV_DECAY = 2, ENV_SUSTAIN = 3;
const ENV_NAMES = ['release', 'attack', 'decay', 'sustain'];

class DSPVoice {
  constructor(index) {
    this.index = index << 4;
    this.id = index;
    this.volume = new Int32Array(2);
    this.pitch = 0;
    this.source = 0;
    this.adsr0 = 0;
    this.adsr1 = 0;
    this.gain = 0;
    this.envx = 0;
    this.keyon = 0; this.keyoff = 0;
    this.modulate = 0; this.noise = 0; this.echo = 0;
    this.end = 0;
    this.buffer = new Int32Array(12);
    this.bufferOffset = 0;
    this.gaussianOffset = 0;
    this.brrAddress = 0;
    this.brrOffset = 1;
    this.keyonDelay = 0;
    this.envelopeMode = ENV_RELEASE;
    this.envelope = 0;
    this._envelope = 0;
    this._keylatch = 0; this._keyon = 0; this._keyoff = 0;
    this._modulate = 0; this._noise = 0; this._echo = 0;
    this._end = 0; this._looped = 0;
    // UI用 (15bitスケールの直近出力)
    this.outSample = 0;
  }
  get envLevel() { return this.envelope; }
  get envMode() {
    if (this.keyonDelay > 0) return 'kon-delay';
    if (this.envelopeMode === ENV_RELEASE && this.envelope === 0) return 'off';
    return ENV_NAMES[this.envelopeMode];
  }
}

class DSP {
  constructor(ram) {
    this.ram = ram;
    this.regs = new Uint8Array(128);
    this.regAddr = 0;
    this.voices = [];
    for (let i = 0; i < 8; i++) this.voices.push(new DSPVoice(i));

    // 出力キュー (パイプラインが1サンプル完成するたびに積む)
    this.qL = new Int32Array(16);
    this.qR = new Int32Array(16);
    this.qHead = 0; this.qTail = 0; this.outCount = 0;

    this.mvVol = new Int32Array(2);   // メイン音量 (符号付き8bit)
    this.mvOut = new Int32Array(2);   // メイン積算
    this.evVol = new Int32Array(2);   // エコー音量
    this.echoOut = new Int32Array(2); // エコー書き込み値
    this.echoIn = new Int32Array(2);  // FIR出力
    this.fir = new Int32Array(8);
    this.hist = [new Int32Array(8), new Int32Array(8)];
    this.reset();
  }

  // 電源投入相当の初期化 (レジスタ/内部状態を全て既定値へ)
  reset() {
    this.regs.fill(0);
    this.regAddr = 0;
    this.phase = 0;
    this.counter = 0;
    this.sampleToggle = 1;
    this.mvVol.fill(0); this.mvOut.fill(0);
    this.mute = 1; this.softReset = 1;
    this.evVol.fill(0); this.echoOut.fill(0); this.echoIn.fill(0);
    this.fir.fill(0); this.hist[0].fill(0); this.hist[1].fill(0);
    this.echoFeedback = 0;
    this.echoPage = 0; this.echoDelay = 0; this.echoReadonly = 1;
    this._echoPage = 0; this._echoReadonly = 0; this._echoAddress = 0;
    this._echoOffset = 0; this._echoLength = 0; this._historyOffset = 0;
    this.noiseFrequency = 0; this.lfsr = 0x4000;
    this.brrBank = 0; this._brrBank = 0; this._brrSource = 0;
    this._brrAddress = 0; this._brrNextAddress = 0; this._brrHeader = 0; this._brrByte = 0;
    this.latchAdsr0 = 0; this.latchEnvx = 0; this.latchOutx = 0; this.latchPitch = 0; this.latchOutput = 0;
    for (const v of this.voices) {
      v.volume.fill(0); v.pitch = 0; v.source = 0; v.adsr0 = 0; v.adsr1 = 0; v.gain = 0; v.envx = 0;
      v.keyon = v.keyoff = v.modulate = v.noise = v.echo = v.end = 0;
      v.buffer.fill(0); v.bufferOffset = 0; v.gaussianOffset = 0; v.brrAddress = 0; v.brrOffset = 1;
      v.keyonDelay = 0; v.envelopeMode = ENV_RELEASE; v.envelope = 0; v._envelope = 0;
      v._keylatch = v._keyon = v._keyoff = v._modulate = v._noise = v._echo = v._end = v._looped = 0;
      v.outSample = 0;
    }
    this.qHead = this.qTail = this.outCount = 0;
  }

  // ---- レジスタアクセス (CPU側 $F3) -------------------------------------
  read(addr) { return this.regs[addr & 0x7f]; }

  write(addr, data) {
    addr &= 0x7f; data &= 0xff;
    this.regs[addr] = data;
    const V = this.voices;
    switch (addr) {
      case 0x0c: this.mvVol[0] = (data << 24) >> 24; break;
      case 0x1c: this.mvVol[1] = (data << 24) >> 24; break;
      case 0x2c: this.evVol[0] = (data << 24) >> 24; break;
      case 0x3c: this.evVol[1] = (data << 24) >> 24; break;
      case 0x4c:
        for (let n = 0; n < 8; n++) { const b = (data >> n) & 1; V[n].keyon = b; V[n]._keylatch = b; }
        break;
      case 0x5c:
        for (let n = 0; n < 8; n++) V[n].keyoff = (data >> n) & 1;
        break;
      case 0x6c:
        this.noiseFrequency = data & 0x1f;
        this.echoReadonly = (data >> 5) & 1;
        this.mute = (data >> 6) & 1;
        this.softReset = (data >> 7) & 1;
        break;
      case 0x7c:
        for (let n = 0; n < 8; n++) V[n]._end = 0;
        this.regs[0x7c] = 0; // 書き込み値に関わらずクリア
        break;
      case 0x0d: this.echoFeedback = (data << 24) >> 24; break;
      case 0x2d:
        for (let n = 0; n < 8; n++) V[n].modulate = (data >> n) & 1;
        V[0].modulate = 0; // ボイス0はピッチモジュレーション不可
        break;
      case 0x3d:
        for (let n = 0; n < 8; n++) V[n].noise = (data >> n) & 1;
        break;
      case 0x4d:
        for (let n = 0; n < 8; n++) V[n].echo = (data >> n) & 1;
        break;
      case 0x5d: this.brrBank = data; break;
      case 0x6d: this.echoPage = data; break;
      case 0x7d: this.echoDelay = data & 0x0f; break;
    }
    const n = (addr >> 4) & 7;
    switch (addr & 0x0f) {
      case 0x00: V[n].volume[0] = (data << 24) >> 24; break;
      case 0x01: V[n].volume[1] = (data << 24) >> 24; break;
      case 0x02: V[n].pitch = (V[n].pitch & 0x3f00) | data; break;
      case 0x03: V[n].pitch = (V[n].pitch & 0x00ff) | ((data & 0x3f) << 8); break;
      case 0x04: V[n].source = data; break;
      case 0x05: V[n].adsr0 = data; break;
      case 0x06: V[n].adsr1 = data; break;
      case 0x07: V[n].gain = data; break;
      case 0x08: this.latchEnvx = data; break;
      case 0x09: this.latchOutx = data; break;
      case 0x0f: this.fir[n] = (data << 24) >> 24; break;
    }
  }

  // ---- カウンタ / エンベロープ ------------------------------------------
  counterTick() {
    if (this.counter === 0) this.counter = DSP_COUNTER_PERIOD;
    this.counter--;
  }
  counterPoll(rate) {
    if (rate === 0) return false;
    return ((this.counter + DSP_COUNTER_OFFSET[rate]) % DSP_COUNTER_RATE[rate]) === 0;
  }

  envelopeRun(v) {
    let envelope = v.envelope;
    if (v.envelopeMode === ENV_RELEASE) {
      envelope -= 8;
      if (envelope < 0) envelope = 0;
      v.envelope = envelope;
      return;
    }
    let rate;
    let envelopeData = v.adsr1;
    const adsr0 = this.latchAdsr0;
    if (adsr0 & 0x80) { // ADSR
      if (v.envelopeMode >= ENV_DECAY) {
        envelope--;
        envelope -= envelope >> 8;
        rate = envelopeData & 0x1f;
        if (v.envelopeMode === ENV_DECAY) rate = ((adsr0 >> 4) & 7) * 2 + 16;
      } else { // attack
        rate = (adsr0 & 0x0f) * 2 + 1;
        envelope += rate < 31 ? 0x20 : 0x400;
      }
    } else { // GAIN
      envelopeData = v.gain;
      const mode = envelopeData >> 5;
      if (mode < 4) { // direct
        envelope = envelopeData << 4;
        rate = 31;
      } else {
        rate = envelopeData & 0x1f;
        if (mode === 4) {          // linear decrease
          envelope -= 0x20;
        } else if (mode < 6) {     // exponential decrease
          envelope--;
          envelope -= envelope >> 8;
        } else {                   // linear increase (7: 2-slope)
          envelope += 0x20;
          if (mode > 6 && (v._envelope >>> 0) >= 0x600) envelope += 0x8 - 0x20;
        }
      }
    }
    // サステインレベル到達
    if ((envelope >> 8) === (envelopeData >> 5) && v.envelopeMode === ENV_DECAY) v.envelopeMode = ENV_SUSTAIN;
    v._envelope = envelope;
    // 符号なし比較: 線形減少でのアンダーフローもここに入る
    if ((envelope >>> 0) > 0x7ff) {
      envelope = envelope < 0 ? 0 : 0x7ff;
      if (v.envelopeMode === ENV_ATTACK) v.envelopeMode = ENV_DECAY;
    }
    if (this.counterPoll(rate)) v.envelope = envelope;
  }

  // ---- Gauss補間 / BRR ---------------------------------------------------
  gaussianInterpolate(v) {
    let offset = (v.gaussianOffset >> 4) & 0xff;
    const fwd = 255 - offset;
    const rev = offset;
    const buf = v.buffer;
    offset = (v.bufferOffset + (v.gaussianOffset >> 12)) % 12;
    let output;
    output = (DSP_GAUSS[fwd] * buf[offset]) >> 11; if (++offset >= 12) offset = 0;
    output += (DSP_GAUSS[fwd + 256] * buf[offset]) >> 11; if (++offset >= 12) offset = 0;
    output += (DSP_GAUSS[rev + 256] * buf[offset]) >> 11; if (++offset >= 12) offset = 0;
    output = (output << 16) >> 16;
    output += (DSP_GAUSS[rev] * buf[offset]) >> 11;
    if (output > 32767) output = 32767; else if (output < -32768) output = -32768;
    return output & ~1;
  }

  brrDecode(v) {
    const ram = this.ram;
    let nybbles = (this._brrByte << 8) | ram[(v.brrAddress + v.brrOffset + 1) & 0xffff];
    const header = this._brrHeader;
    const filter = (header >> 2) & 3;
    const scale = (header >> 4) & 15;
    const buf = v.buffer;
    for (let n = 0; n < 4; n++) {
      let s = ((nybbles << 16) >> 16) >> 12;
      nybbles <<= 4;
      if (scale <= 12) { s <<= scale; s >>= 1; } else { s &= ~0x7ff; }
      let o = v.bufferOffset;
      if (--o < 0) o = 11; const p1 = buf[o];
      if (--o < 0) o = 11; const p2 = buf[o] >> 1;
      switch (filter) {
        case 1:
          s += p1 >> 1;
          s += (-p1) >> 5;
          break;
        case 2:
          s += p1;
          s -= p2;
          s += p2 >> 4;
          s += (p1 * -3) >> 6;
          break;
        case 3:
          s += p1;
          s -= p2;
          s += (p1 * -13) >> 7;
          s += (p2 * 3) >> 4;
          break;
      }
      if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
      s = ((s << 1) << 16) >> 16;
      buf[v.bufferOffset] = s;
      if (++v.bufferOffset >= 12) v.bufferOffset = 0;
    }
  }

  // ---- ボイスパイプライン ------------------------------------------------
  voiceOutput(v, ch) {
    const amp = (this.latchOutput * v.volume[ch]) >> 7;
    let t = this.mvOut[ch] + amp;
    if (t > 32767) t = 32767; else if (t < -32768) t = -32768;
    this.mvOut[ch] = t;
    if (v._echo) {
      t = this.echoOut[ch] + amp;
      if (t > 32767) t = 32767; else if (t < -32768) t = -32768;
      this.echoOut[ch] = t;
    }
  }

  voice1(v) {
    this._brrAddress = ((this._brrBank << 8) + (this._brrSource << 2)) & 0xffff;
    this._brrSource = v.source;
  }

  voice2(v) {
    const ram = this.ram;
    let address = this._brrAddress;
    if (!v.keyonDelay) address += 2;
    this._brrNextAddress = ram[address & 0xffff] | (ram[(address + 1) & 0xffff] << 8);
    this.latchAdsr0 = v.adsr0;
    this.latchPitch = v.pitch & 0xff;
  }

  voice3(v) { this.voice3a(v); this.voice3b(v); this.voice3c(v); }

  voice3a(v) { this.latchPitch |= v.pitch & ~0xff; }

  voice3b(v) {
    const ram = this.ram;
    this._brrByte = ram[(v.brrAddress + v.brrOffset) & 0xffff];
    this._brrHeader = ram[v.brrAddress & 0xffff];
  }

  voice3c(v) {
    // 直前のボイス出力によるピッチモジュレーション
    if (v._modulate) {
      this.latchPitch = (this.latchPitch + (((this.latchOutput >> 5) * this.latchPitch) >> 10)) & 0x7fff;
    }
    if (v.keyonDelay) {
      // 次サンプルからBRRデコードを開始する準備
      if (v.keyonDelay === 5) {
        v.brrAddress = this._brrNextAddress;
        v.brrOffset = 1;
        v.bufferOffset = 0;
        this._brrHeader = 0; // このサンプルではヘッダ無視
      }
      // KON中はエンベロープを動かさない
      v.envelope = 0;
      v._envelope = 0;
      // 最後の3サンプルまでBRRデコードを止める
      v.gaussianOffset = 0;
      v.keyonDelay--;
      if (v.keyonDelay & 3) v.gaussianOffset = 0x4000;
      // KON中はピッチを加算しない
      this.latchPitch = 0;
    }
    // Gauss補間
    let output = this.gaussianInterpolate(v);
    // ノイズ
    if (v._noise) output = ((this.lfsr << 1) << 16) >> 16;
    // エンベロープ適用
    this.latchOutput = (output * v.envelope >> 11) & ~1;
    v.envx = v.envelope >> 4;
    v.outSample = this.latchOutput >> 1;

    // サンプル終端 / ソフトリセットで即無音
    if (this.softReset || (this._brrHeader & 3) === 1) {
      v.envelopeMode = ENV_RELEASE;
      v.envelope = 0;
    }
    if (this.sampleToggle) {
      if (v._keyoff) v.envelopeMode = ENV_RELEASE;
      if (v._keyon) {
        v.keyonDelay = 5;
        v.envelopeMode = ENV_ATTACK;
      }
    }
    // 次サンプル用にエンベロープを進める
    if (!v.keyonDelay) this.envelopeRun(v);
  }

  voice4(v) {
    v._looped = 0;
    if (v.gaussianOffset >= 0x4000) {
      this.brrDecode(v);
      v.brrOffset += 2;
      if (v.brrOffset >= 9) {
        v.brrAddress = (v.brrAddress + 9) & 0xffff;
        if (this._brrHeader & 1) {
          v.brrAddress = this._brrNextAddress;
          v._looped = 1;
        }
        v.brrOffset = 1;
      }
    }
    v.gaussianOffset = (v.gaussianOffset & 0x3fff) + this.latchPitch;
    if (v.gaussianOffset > 0x7fff) v.gaussianOffset = 0x7fff;
    this.voiceOutput(v, 0);
  }

  voice5(v) {
    this.voiceOutput(v, 1);
    v._end |= v._looped;
    if (v.keyonDelay === 5) v._end = 0;
  }

  voice6(v) { this.latchOutx = (this.latchOutput >> 8) & 0xff; }

  voice7(v) {
    const V = this.voices;
    let e = 0;
    for (let n = 0; n < 8; n++) e |= V[n]._end << n;
    this.regs[0x7c] = e;
    this.latchEnvx = v.envx;
  }

  voice8(v) { this.regs[v.index | 0x09] = this.latchOutx; }
  voice9(v) { this.regs[v.index | 0x08] = this.latchEnvx; }

  // ---- エコー -----------------------------------------------------------
  calculateFIR(ch, index) {
    const sample = this.hist[ch][(this._historyOffset + index + 1) & 7];
    return (sample * this.fir[index]) >> 6;
  }

  echoOutput(ch) {
    const m = (((this.mvOut[ch] * this.mvVol[ch]) >> 7) << 16) >> 16;
    const e = (((this.echoIn[ch] * this.evVol[ch]) >> 7) << 16) >> 16;
    let t = m + e;
    if (t > 32767) t = 32767; else if (t < -32768) t = -32768;
    return t;
  }

  echoRead(ch) {
    const ram = this.ram;
    const a = (this._echoAddress + ch * 2) & 0xffff;
    const s = (((ram[(a + 1) & 0xffff] << 8) | ram[a]) << 16) >> 16;
    this.hist[ch][this._historyOffset] = s >> 1;
  }

  echoWrite(ch) {
    if (!this._echoReadonly) {
      const ram = this.ram;
      const a = (this._echoAddress + ch * 2) & 0xffff;
      const s = this.echoOut[ch];
      ram[a] = s & 0xff;
      ram[(a + 1) & 0xffff] = (s >> 8) & 0xff;
    }
    this.echoOut[ch] = 0;
  }

  echo22() {
    this._historyOffset = (this._historyOffset + 1) & 7;
    this._echoAddress = ((this._echoPage << 8) + this._echoOffset) & 0xffff;
    this.echoRead(0);
    this.echoIn[0] = this.calculateFIR(0, 0);
    this.echoIn[1] = this.calculateFIR(1, 0);
  }

  echo23() {
    this.echoIn[0] += this.calculateFIR(0, 1) + this.calculateFIR(0, 2);
    this.echoIn[1] += this.calculateFIR(1, 1) + this.calculateFIR(1, 2);
    this.echoRead(1);
  }

  echo24() {
    this.echoIn[0] += this.calculateFIR(0, 3) + this.calculateFIR(0, 4) + this.calculateFIR(0, 5);
    this.echoIn[1] += this.calculateFIR(1, 3) + this.calculateFIR(1, 4) + this.calculateFIR(1, 5);
  }

  echo25() {
    let l = this.echoIn[0] + this.calculateFIR(0, 6);
    let r = this.echoIn[1] + this.calculateFIR(1, 6);
    l = (l << 16) >> 16;
    r = (r << 16) >> 16;
    l += (this.calculateFIR(0, 7) << 16) >> 16;
    r += (this.calculateFIR(1, 7) << 16) >> 16;
    if (l > 32767) l = 32767; else if (l < -32768) l = -32768;
    if (r > 32767) r = 32767; else if (r < -32768) r = -32768;
    this.echoIn[0] = l & ~1;
    this.echoIn[1] = r & ~1;
  }

  echo26() {
    this.mvOut[0] = this.echoOutput(0); // 左出力 (次クロックで右と一緒に出す)
    let l = this.echoOut[0] + ((((this.echoIn[0] * this.echoFeedback) >> 7) << 16) >> 16);
    let r = this.echoOut[1] + ((((this.echoIn[1] * this.echoFeedback) >> 7) << 16) >> 16);
    if (l > 32767) l = 32767; else if (l < -32768) l = -32768;
    if (r > 32767) r = 32767; else if (r < -32768) r = -32768;
    this.echoOut[0] = l & ~1;
    this.echoOut[1] = r & ~1;
  }

  echo27() {
    let outl = this.mvOut[0];
    let outr = this.echoOutput(1);
    this.mvOut[0] = 0;
    this.mvOut[1] = 0;
    if (this.mute) { outl = 0; outr = 0; }
    const t = this.qTail;
    this.qL[t] = outl; this.qR[t] = outr;
    this.qTail = (t + 1) & 15;
    if (this.outCount < 16) this.outCount++; else this.qHead = (this.qHead + 1) & 15;
  }

  echo28() { this._echoReadonly = this.echoReadonly; }

  echo29() {
    this._echoPage = this.echoPage;
    if (!this._echoOffset) this._echoLength = this.echoDelay << 11;
    this._echoOffset = (this._echoOffset + 4) & 0xffff;
    if (this._echoOffset >= this._echoLength) this._echoOffset = 0;
    this.echoWrite(0);
    this._echoReadonly = this.echoReadonly;
  }

  echo30() { this.echoWrite(1); }

  // ---- その他 -----------------------------------------------------------
  misc27() { for (const v of this.voices) v._modulate = v.modulate; }

  misc28() {
    for (const v of this.voices) { v._noise = v.noise; v._echo = v.echo; }
    this._brrBank = this.brrBank;
  }

  misc29() {
    this.sampleToggle ^= 1;
    if (this.sampleToggle) { // KONを最後に読んだ63クロック後にクリア
      for (const v of this.voices) v._keylatch &= v._keyon ? 0 : 1;
    }
  }

  misc30() {
    if (this.sampleToggle) {
      for (const v of this.voices) { v._keyon = v._keylatch; v._keyoff = v.keyoff; }
    }
    this.counterTick();
    if (this.counterPoll(this.noiseFrequency)) {
      const fb = (this.lfsr << 13) ^ (this.lfsr << 14);
      this.lfsr = (fb & 0x4000) | (this.lfsr >> 1);
    }
  }

  // ---- 1クロック進める (1サンプル = 32クロック) --------------------------
  tick() {
    const V = this.voices;
    switch (this.phase) {
      case 0: this.voice5(V[0]); this.voice2(V[1]); break;
      case 1: this.voice6(V[0]); this.voice3(V[1]); break;
      case 2: this.voice7(V[0]); this.voice4(V[1]); this.voice1(V[3]); break;
      case 3: this.voice8(V[0]); this.voice5(V[1]); this.voice2(V[2]); break;
      case 4: this.voice9(V[0]); this.voice6(V[1]); this.voice3(V[2]); break;
      case 5: this.voice7(V[1]); this.voice4(V[2]); this.voice1(V[4]); break;
      case 6: this.voice8(V[1]); this.voice5(V[2]); this.voice2(V[3]); break;
      case 7: this.voice9(V[1]); this.voice6(V[2]); this.voice3(V[3]); break;
      case 8: this.voice7(V[2]); this.voice4(V[3]); this.voice1(V[5]); break;
      case 9: this.voice8(V[2]); this.voice5(V[3]); this.voice2(V[4]); break;
      case 10: this.voice9(V[2]); this.voice6(V[3]); this.voice3(V[4]); break;
      case 11: this.voice7(V[3]); this.voice4(V[4]); this.voice1(V[6]); break;
      case 12: this.voice8(V[3]); this.voice5(V[4]); this.voice2(V[5]); break;
      case 13: this.voice9(V[3]); this.voice6(V[4]); this.voice3(V[5]); break;
      case 14: this.voice7(V[4]); this.voice4(V[5]); this.voice1(V[7]); break;
      case 15: this.voice8(V[4]); this.voice5(V[5]); this.voice2(V[6]); break;
      case 16: this.voice9(V[4]); this.voice6(V[5]); this.voice3(V[6]); break;
      case 17: this.voice1(V[0]); this.voice7(V[5]); this.voice4(V[6]); break;
      case 18: this.voice8(V[5]); this.voice5(V[6]); this.voice2(V[7]); break;
      case 19: this.voice9(V[5]); this.voice6(V[6]); this.voice3(V[7]); break;
      case 20: this.voice1(V[1]); this.voice7(V[6]); this.voice4(V[7]); break;
      case 21: this.voice8(V[6]); this.voice5(V[7]); this.voice2(V[0]); break;
      case 22: this.voice3a(V[0]); this.voice9(V[6]); this.voice6(V[7]); this.echo22(); break;
      case 23: this.voice7(V[7]); this.echo23(); break;
      case 24: this.voice8(V[7]); this.echo24(); break;
      case 25: this.voice3b(V[0]); this.voice9(V[7]); this.echo25(); break;
      case 26: this.echo26(); break;
      case 27: this.misc27(); this.echo27(); break;
      case 28: this.misc28(); this.echo28(); break;
      case 29: this.misc29(); this.echo29(); break;
      case 30: this.misc30(); this.voice3c(V[0]); this.echo30(); break;
      case 31: this.voice4(V[0]); this.voice1(V[2]); break;
    }
    this.phase = (this.phase + 1) & 31;
  }

  // nクロック分進める (SPC700の消費サイクル数と同数)
  run(n) { while (n-- > 0) this.tick(); }

  // 完成済みサンプルを1つ取り出す (整数 L/R)。無ければ false
  popRaw() {
    if (this.outCount === 0) return false;
    const h = this.qHead;
    this.rawL = this.qL[h]; this.rawR = this.qR[h];
    this.qHead = (h + 1) & 15;
    this.outCount--;
    return true;
  }

  // ---- 参照用ヘルパ (UI) --------------------------------------------------
  _s8(v) { return v >= 128 ? v - 256 : v; }
  volL(v) { return this.voices[v].volume[0]; }
  volR(v) { return this.voices[v].volume[1]; }
  pitch(v) { return this.voices[v].pitch; }
  srcn(v) { return this.regs[v * 0x10 + 0x04]; }
  adsr1(v) { return this.regs[v * 0x10 + 0x05]; }
  adsr2(v) { return this.regs[v * 0x10 + 0x06]; }
  gain(v) { return this.regs[v * 0x10 + 0x07]; }
  get kon() { return this.regs[0x4c]; }
  get koff() { return this.regs[0x5c]; }
  get flg() { return this.regs[0x6c]; }
  get pmon() { return this.regs[0x2d]; }
  get non() { return this.regs[0x3d]; }
  get eon() { return this.regs[0x4d]; }
  get dir() { return this.regs[0x5d]; }
  get mvolL() { return this.mvVol[0]; }
  get mvolR() { return this.mvVol[1]; }
  get evolL() { return this.evVol[0]; }
  get evolR() { return this.evVol[1]; }
  get efb() { return this.echoFeedback; }
  get esa() { return this.regs[0x6d]; }
  get edl() { return this.regs[0x7d] & 0x0f; }

  getSampleDirEntry(srcn) {
    const base = ((this.dir << 8) + srcn * 4) & 0xffff;
    const start = this.ram[base] | (this.ram[(base + 1) & 0xffff] << 8);
    const loop = this.ram[(base + 2) & 0xffff] | (this.ram[(base + 3) & 0xffff] << 8);
    return { start, loop };
  }

  getDSPRegisters() { return new Uint8Array(this.regs); }

  getAllVoiceStates() {
    return this.voices.map((v, i) => {
      const regs = this.getVoiceRegisters(i);
      return {
        id: i,
        outSample: v.outSample,   // 15bitスケールの直近出力
        envLevel: v.envelope,     // 0 ~ 2047
        envMode: v.envMode,       // 'off', 'attack', 'decay', 'sustain', 'release', 'kon-delay'
        volL: regs.volL, volR: regs.volR, pitch: regs.pitch, srcn: regs.srcn
      };
    });
  }

  getVoiceRegisters(v) {
    if (v < 0 || v > 7) return null;
    const base = v * 0x10;
    return {
      volL: this._s8(this.regs[base + 0x00]),
      volR: this._s8(this.regs[base + 0x01]),
      pitch: this.regs[base + 0x02] | ((this.regs[base + 0x03] & 0x3f) << 8),
      srcn: this.regs[base + 0x04],
      adsr1: this.regs[base + 0x05],
      adsr2: this.regs[base + 0x06],
      gain: this.regs[base + 0x07],
      env: this.regs[base + 0x08],
      out: this.regs[base + 0x09]
    };
  }

  // SPCファイルのDSPレジスタ128バイトを読み込む (KONが立っているボイスは頭から鳴り直す)
  loadRegisters(dspRegs) {
    this.reset();
    for (let i = 0; i < 128; i++) this.write(i, dspRegs[i]);
    // ENDX は退避値をそのまま復元
    const endx = dspRegs[0x7c];
    for (let n = 0; n < 8; n++) this.voices[n]._end = (endx >> n) & 1;
    this.regs[0x7c] = endx;

    // ★バグ修正: reset() で内部ラッチが0のままだと、最初の1サンプルでエコー出力が
    //   RAM $0000-$0003 (ゼロページ) に書き込まれ、ドライバの変数を壊して曲が止まる。
    //   ダンプ復元時は、レジスタ値から各ラッチを先に確定させておく。
    this._echoPage = this.echoPage;
    this._echoReadonly = this.echoReadonly;
    this._echoOffset = 0;
    this._echoLength = this.echoDelay << 11;
    this._echoAddress = (this.echoPage << 8) & 0xffff;
    this._brrBank = this.brrBank;
    for (const v of this.voices) { v._modulate = v.modulate; v._noise = v.noise; v._echo = v.echo; }
  }
}
// ==== S-DSP CORE END ======================================================

// ----------------------------------------------------------------------------
// 出力段: hardwareAccurate=true なら DSP の16bit出力をそのまま ±1.0 に正規化するだけ。
// false のときだけ従来の後処理(ゲイン/DC除去/LPF/リミッタ等)を通す。
// ----------------------------------------------------------------------------
class OutputChain {
  constructor() {
    this.er = new EarlyReflections(SDSP_RATE);
    this.lpfL = new LPF4(LP_CUTOFF_HZ, SDSP_RATE);
    this.lpfR = new LPF4(LP_CUTOFF_HZ, SDSP_RATE);
    this.reset();
  }
  reset() {
    this.er.reset(); this.lpfL.reset(); this.lpfR.reset();
    this.dcPrevInL = this.dcPrevOutL = this.dcPrevInR = this.dcPrevOutR = 0;
    this.limEnv = 0; this.limGain = 1;
  }
  process(rawL, rawR) {
    let outL = rawL / 32768.0, outR = rawR / 32768.0;
    if (SMOOTH_CONFIG.hardwareAccurate) return [outL, outR];
    if (SMOOTH_CONFIG.earlyReflections) [outL, outR] = this.er.process(outL, outR);
    [outL, outR] = applyStereoEnhancer(outL, outR, SMOOTH_CONFIG.stereoWidth);
    outL *= SMOOTH_CONFIG.outputGain; outR *= SMOOTH_CONFIG.outputGain;
    const R_DC = 0.99843;
    const yl = outL - this.dcPrevInL + R_DC * this.dcPrevOutL;
    this.dcPrevInL = outL; this.dcPrevOutL = yl; outL = yl;
    const yr = outR - this.dcPrevInR + R_DC * this.dcPrevOutR;
    this.dcPrevInR = outR; this.dcPrevOutR = yr; outR = yr;
    outL = this.lpfL.process(outL); outR = this.lpfR.process(outR);
    const pk = Math.max(Math.abs(outL), Math.abs(outR));
    this.limEnv = pk > this.limEnv ? pk : this.limEnv * SMOOTH_CONFIG.limiterRelease;
    const target = this.limEnv > SMOOTH_CONFIG.limiterCeil ? SMOOTH_CONFIG.limiterCeil / this.limEnv : 1;
    this.limGain += (target - this.limGain) * (target < this.limGain ? 0.5 : 0.0005);
    return [finalSoftClip(outL * this.limGain), finalSoftClip(outR * this.limGain)];
  }
}

/**
 * SPC File Binary Parser
 */
function parseSPC(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 0x10180) {
    throw new Error('Invalid SPC file size.');
  }

  const headerStr = String.fromCharCode.apply(null, bytes.subarray(0, 27));
  if (!headerStr.startsWith('SNES-SPC700 Sound File')) {
    throw new Error('Invalid SPC header format.');
  }

  const pc = bytes[0x25] | (bytes[0x26] << 8);
  const a = bytes[0x27];
  const x = bytes[0x28];
  const y = bytes[0x29];
  const psw = bytes[0x2a];
  const sp = bytes[0x2b];

  const readString = (offset, length) => {
    let s = '';
    for (let i = 0; i < length; i++) {
      const c = bytes[offset + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  };

  const title = readString(0x2e, 32);
  const game = readString(0x4e, 32);
  const dumper = readString(0x6e, 16);
  const comment = readString(0x7e, 32);

  const ram = bytes.subarray(0x100, 0x10100);
  const dspRegs = bytes.subarray(0x10100, 0x10180);

  return {
    pc, a, x, y, psw, sp,
    ram, dspRegs,
    meta: { title, game, dumper, comment }
  };
}

/**
 * SPCEngine Core
 * SPC700 の消費サイクル数と同じだけ S-DSP のクロックを進める(1サイクル = 1DSPクロック、32クロック = 1サンプル)。
 */
class SPCEngine {
  constructor() {
    this.cpu = new SPC700(null);
    this.dsp = new DSP(this.cpu.ram);
    this.cpu.dsp = this.dsp;
    this.out = new OutputChain();
    this.loaded = false;
  }

  loadSPC(parsed) {
    const cpu = this.cpu, dsp = this.dsp;

    cpu.ram.set(parsed.ram);
    cpu.A = parsed.a & 0xff;
    cpu.X = parsed.x & 0xff;
    cpu.Y = parsed.y & 0xff;
    cpu.SP = parsed.sp & 0xff;
    cpu.PC = parsed.pc & 0xffff;
    cpu.setPSW(parsed.psw & 0xff);
    cpu.cycles = 0;
    cpu.halted = false;

    const f1 = parsed.ram[0xf1];
    cpu.romEnable = (f1 & 0x80) !== 0;
    for (let t = 0; t < 3; t++) {
      cpu.timerEnable[t] = (f1 >> t) & 1;
      cpu.timerTarget[t] = parsed.ram[0xfa + t];
      cpu.timerCounter[t] = 0;
      cpu.timerOut[t] = parsed.ram[0xfd + t] & 0x0f;
      cpu._tAccum[t] = 0;
    }
    for (let i = 0; i < 4; i++) {
      cpu.ioIn[i] = parsed.ram[0xf4 + i];
      cpu.ioOut[i] = parsed.ram[0xf4 + i];
    }
    dsp.regAddr = parsed.ram[0xf2];

    dsp.loadRegisters(parsed.dspRegs);
    this.out.reset();
    this.loaded = true;
  }

  renderSample() {
    if (!this.loaded) return [0, 0];
    const cpu = this.cpu, dsp = this.dsp;
    let guard = 0;
    while (dsp.outCount === 0 && guard++ < 64) {
      dsp.run(cpu.step());
    }
    if (!dsp.popRaw()) return [0, 0];
    return this.out.process(dsp.rawL, dsp.rawR);
  }
}

/**
 * Main Audio Player & Public API
 */
/**
 * Main Audio Player & Public API
 */
const SDSP_SAMPLE_RATE = 32000;

// オシロスコープ用リングバッファ (32kHz DSPサンプル単位 / 2のべき乗)
const SCOPE_RB = 65536;

// 出力側リサンプラ: Catmull-Rom 3次補間 → Kaiser窓sinc (旧: 高域イメージが残りジャリつく)
const RS_TAPS = Math.max(4, Math.min(32, SMOOTH_CONFIG.resampleTaps | 0));
const RS_PHASES = 1024;
const RS_TABLE = buildKaiserSincTable(RS_TAPS, RS_PHASES, 1.0, 7.0);

class SPCPlayer {
  constructor(audioCtx, destination) {
    this.audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    this.destination = destination || this.audioCtx.destination;
    this.engine = new SPCEngine();
    this.playing = false;

    this.resampleRatio = SDSP_SAMPLE_RATE / this.audioCtx.sampleRate;
    this.srcPos = 0;

    this.hL = new Float64Array(RS_TAPS);
    this.hR = new Float64Array(RS_TAPS);
    this.haveSample = false;

    this.fade = 0;
    this.fadeTarget = 0;
    this.fadeStep = 1 / (this.audioCtx.sampleRate * 0.05);

    this.scriptNode = this.audioCtx.createScriptProcessor(8192, 0, 2);
    this.scriptNode.onaudioprocess = (e) => this._process(e);
    this._connected = false;
    this.currentMeta = null;

    // --- シーク・時間管理用プロパティ ---
    this.rawBuffer = null;      // 高速再構築用のArrayBufferキャッシュ
    this.playedSamples = 0;     // 内部生成したDSPサンプル数(32kHz基準)
    this.isSeeking = false;     // シーク処理中フラグ

    // --- オシロスコープ用 (index.html の drawScope が参照) ---
    // scopeBuf[0..7] = 各ボイス出力 / scopeBuf[8] = マスター(L+R)/2
    this.scopeRB = SCOPE_RB;
    this.scopeMask = SCOPE_RB - 1;
    this.scopeBuf = Array.from({ length: 9 }, () => new Float32Array(SCOPE_RB));
    this.scopeW = 0;            // 書き込み済みDSPサンプル総数 (単調増加)
    this._scopeMarks = [];      // 再生時刻と scopeW の対応表
  }

  /**
   * 現在の再生位置（秒）を取得
   */
  get currentTime() {
    return this.playedSamples / SDSP_SAMPLE_RATE;
  }

  /**
   * SPCファイルをArrayBufferまたはUint8Arrayからロード
   */
  
  load(buffer) {
    // 再生成用にBufferを複製して保存
    if (buffer instanceof ArrayBuffer) {
      this.rawBuffer = buffer.slice(0);
    } else if (ArrayBuffer.isView(buffer)) {
      this.rawBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }

    const parsed = parseSPC(this.rawBuffer);
    this.engine.loadSPC(parsed);
    this.currentMeta = parsed.meta;
    this.srcPos = 0;
    this.haveSample = false;
    this.hL.fill(0); this.hR.fill(0);
    this.fade = 0;
    this.playedSamples = 0;
    this._resetScope();
    return parsed.meta;
  }

  /**
   * 指定した位置（秒）へシーク（好きな場所から再生）
   * @param {number} seconds - 再生したい位置（秒）
   */
  seek(seconds) {
    if (!this.rawBuffer || !this.engine.loaded) return;

    const targetSeconds = Math.max(0, seconds);
    const targetSamples = Math.floor(targetSeconds * SDSP_SAMPLE_RATE);

    const wasPlaying = this.playing;
    this.isSeeking = true;

    // 1. 初期状態にリセット
    const parsed = parseSPC(this.rawBuffer);
    this.engine.loadSPC(parsed);
    this.srcPos = 0;
    this.haveSample = false;
    this.hL.fill(0); this.hR.fill(0);

    // 2. 指定位置まで高速レンダリング（音声出力なしでCPU/DSPを進める）
    for (let i = 0; i < targetSamples; i++) {
      this.engine.renderSample();
    }

    this._resetScope();
    this.playedSamples = targetSamples;
    this.isSeeking = false;

    // 再生中だった場合は再生状態を復元
    if (wasPlaying) {
      this.play();
    }
  }

  getVoiceStates() {
    return this.engine.dsp.getAllVoiceStates();
  }

  _resetScope() {
    for (let k = 0; k < 9; k++) this.scopeBuf[k].fill(0);
    this.scopeW = 0;
    this._scopeMarks.length = 0;
  }

  // _process の各ブロック先頭で呼ぶ: 「この時刻に再生されるDSP位置」を記録
  _scopeMark(e) {
    const t = (e && typeof e.playbackTime === 'number' && e.playbackTime > 0)
      ? e.playbackTime : this.audioCtx.currentTime;
    const a = this._scopeMarks;
    a.push({ t, w: this.scopeW });
    if (a.length > 16) a.shift();
  }

  // 現在「聞こえている」位置に相当するDSPサンプル位置 (≤ scopeW)
  getScopePos() {
    const a = this._scopeMarks;
    if (!a.length) return this.scopeW;
    const now = this.audioCtx.currentTime - (this.audioCtx.outputLatency || 0);
    let m = a[0];
    for (let i = a.length - 1; i >= 0; i--) {
      if (a[i].t <= now) { m = a[i]; break; }
    }
    const p = m.w + Math.max(0, now - m.t) * SDSP_SAMPLE_RATE;
    return Math.min(p, this.scopeW);
  }

  /**
   * URLからSPCファイルをダウンロードしてロード＆再生
   */
  async loadUrl(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch SPC file: ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    const meta = this.load(buffer);
    this.play();
    return meta;
  }

  /**
   * 再生開始
   */
  play() {
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    if (!this._connected) {
      this.scriptNode.connect(this.destination);
      this._connected = true;
    }
    this.playing = true;
    this.fadeTarget = 1;
  }

  /**
   * 停止 (フェードアウト付き)
   */
  stop() {
    this.fadeTarget = 0;
    setTimeout(() => {
      if (this.fadeTarget === 0) {
        this.playing = false;
        if (this._connected) {
          try { this.scriptNode.disconnect(); } catch (e) {}
          this._connected = false;
        }
      }
    }, 80);
  }

  _advanceDspSample() {
    const hL = this.hL, hR = this.hR;
    for (let k = 0; k < RS_TAPS - 1; k++) { hL[k] = hL[k + 1]; hR[k] = hR[k + 1]; }
    const [l, r] = this.engine.renderSample();
    hL[RS_TAPS - 1] = l; hR[RS_TAPS - 1] = r;
    this.playedSamples++; // 再生サンプル数をカウント

    // オシロスコープ用に波形を記録 (ボイスはボリューム適用後のL/R平均、満振幅=1.0)
    {
      const dsp = this.engine.dsp, vs = dsp.voices, sb = this.scopeBuf;
      const w = this.scopeW & this.scopeMask;
      for (let i = 0; i < 8; i++) {
        sb[i][w] = ((vs[i].outSample || 0) * (dsp.volL(i) + dsp.volR(i)) / 256) / 16384;
      }
      sb[8][w] = (l + r) * 0.5;
      this.scopeW++;
    }
  }

  static _cubic(y0, y1, y2, y3, t) {
    const a = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
    const b =        y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    const c = -0.5 * y0            + 0.5 * y2;
    return ((a * t + b) * t + c) * t + y1;
  }
  _startVoiceTimer() {
    if (this._voiceTimer) return;
    this._voiceTimer = setInterval(() => {
      if (typeof this.onVoiceInfo === 'function' && this.engine.loaded) {
        this.onVoiceInfo(this._getVoiceInfo());
      }
    }, 2);
  }
  _stopVoiceTimer() {
    if (this._voiceTimer) { clearInterval(this._voiceTimer); this._voiceTimer = null; }
  }

  _getVoiceInfo() {
    const dsp = this.engine.dsp;
    const voices = [];
    for (let i = 0; i < 8; i++) {
      const voice = dsp.voices[i];
      voices.push({
        voice: i + 1,
        volumeL: dsp.volL(i),
        volumeR: dsp.volR(i),
        pitch: dsp.pitch(i),
        envelope: voice.envLevel,
        active: voice.envMode !== "off"
      });
    }
    return voices;
  }
  _process(e) {
    const output = e.outputBuffer;
    const left = output.getChannelData(0);
    const right = output.getChannelData(1);
    const n = left.length;

    // シーク中や停止中・未読み込み時は無音を出力
    if (!this.playing || !this.engine.loaded || this.isSeeking) {
      left.fill(0);
      right.fill(0);
      return;
    }

    if (!this.haveSample) {
      for (let k = 0; k < RS_TAPS; k++) this._advanceDspSample();
      this.haveSample = true;
    }

    this._scopeMark(e);

    const hL = this.hL, hR = this.hR;
    const ratio = this.resampleRatio;
    let fade = this.fade;
    const fadeTarget = this.fadeTarget, fadeStep = this.fadeStep;

    for (let i = 0; i < n; i++) {
      while (this.srcPos >= 1.0) {
        this._advanceDspSample();
        this.srcPos -= 1.0;
      }

      const base = ((this.srcPos * RS_PHASES) | 0) * RS_TAPS;
      let l = 0, r = 0;
      for (let k = 0; k < RS_TAPS; k++) {
        const w = RS_TABLE[base + k];
        l += hL[k] * w;
        r += hR[k] * w;
      }

      if (fade !== fadeTarget) {
        if (fade < fadeTarget) fade = Math.min(fadeTarget, fade + fadeStep);
        else fade = Math.max(fadeTarget, fade - fadeStep);
      }

      left[i] = l * fade;
      right[i] = r * fade;

      this.srcPos += ratio;
    }

    this.fade = fade;
  }
}

// グローバルオブジェクトへの登録（ブラウザ / モジュール環境対応）
if (typeof window !== 'undefined') {
  window.SPCPlayer = SPCPlayer;
  window.parseSPC = parseSPC;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SPCPlayer, parseSPC, SPC700, DSP, SPCEngine };
}
// ============================================================================
// WAV Export Extension
// ============================================================================

/**
 * PCMデータ(Float32Array)から16bit StereoのWAV Blobを生成
 */
function createWavBlob(leftChannel, rightChannel, sampleRate = SDSP_SAMPLE_RATE) {
  const numChannels = 2;
  const numSamples = leftChannel.length;
  const bytesPerSample = 2; // 16-bit PCM
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (v, offset, str) => {
    for (let i = 0; i < str.length; i++) {
      v.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  /* RIFF header */
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  /* fmt chunk */
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);          // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true);           // AudioFormat (1 = PCM)
  view.setUint16(22, numChannels, true); // NumChannels
  view.setUint32(24, sampleRate, true);  // SampleRate
  view.setUint32(28, byteRate, true);    // ByteRate
  view.setUint16(32, blockAlign, true);  // BlockAlign
  view.setUint16(34, 16, true);          // BitsPerSample

  /* data chunk */
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  /* Write Interleaved PCM samples */
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    let l = Math.max(-1, Math.min(1, leftChannel[i]));
    let r = Math.max(-1, Math.min(1, rightChannel[i]));

    let sL = l < 0 ? l * 0x8000 : l * 0x7FFF;
    let sR = r < 0 ? r * 0x8000 : r * 0x7FFF;

    view.setInt16(offset, sL, true);
    view.setInt16(offset + 2, sR, true);
    offset += 4;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * SPCデータ(ArrayBuffer)を直接WAV Blobにレンダリングする独立関数
 * @param {ArrayBuffer|Uint8Array} spcBuffer - SPCバイナリデータ
 * @param {number} durationSec - 出力する長さ（秒数）
 * @returns {Blob} WAVファイルのBlob
 */
function renderSPCToWav(spcBuffer, durationSec = 180) {
  const parsed = parseSPC(spcBuffer);
  const engine = new SPCEngine();
  engine.loadSPC(parsed);

  const sampleRate = SDSP_SAMPLE_RATE; // 32000Hz
  const totalSamples = Math.floor(sampleRate * Math.max(0, durationSec));

  const leftChannel = new Float32Array(totalSamples);
  const rightChannel = new Float32Array(totalSamples);

  for (let i = 0; i < totalSamples; i++) {
    const [l, r] = engine.renderSample();
    leftChannel[i] = l;
    rightChannel[i] = r;
  }

  return createWavBlob(leftChannel, rightChannel, sampleRate);
}

// SPCPlayerクラスにWAVエクスポート機能を追加
SPCPlayer.prototype.exportWav = function (durationSec = 180, buffer = null) {
  const targetBuffer = buffer || this.rawBuffer;
  if (!targetBuffer) {
    throw new Error('No SPC buffer available for WAV export.');
  }
  return renderSPCToWav(targetBuffer, durationSec);
};
function pitchToNote(pitch) {
    if (!pitch) return "-";
    const freq = 32000 * pitch / 4096;
    if (!isFinite(freq) || freq <= 0) return "-";

    const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const midi = Math.round(69 + 12 * Math.log2(freq / 440));
    const octave = Math.floor(midi / 12) - 1;
    const name = noteNames[((midi % 12) + 12) % 12];

    return `${name}${octave}`;
}