/**
 * mmlc.js - 汎用 SFC(SNES) SPC 用 MML コンパイラ (Browser / JS Port)
 *
 * mmldrv.drv および mmldrv.bin を内蔵しており、追加ファイルなしで
 * ブラウザ上から直接 .spc バイナリ (Uint8Array) を生成できます。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MMLC = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAXCH = 16;
  const RAMSZ = 0x10000;
  const SPCSZ = 0x10200;

  // ------------------------------------------------------------------
  // 埋め込みデフォルトドライバ (mmldrv.drv & mmldrv.bin)
  // ------------------------------------------------------------------
  const EMBEDDED_DRIVER_DRV = `; mmldrv.drv — mmldrv.asm 用ドライバ定義
[spc]
load = mmldrv.bin 0x0200
pc   = 0x0200
sp   = 0xEF
dsp  = 0x5D 0x1F          ; DIR = $1F00

dsp  = 0x05 0xFF          ; voice0 ADSR1 (AR=15 DR=7)
dsp  = 0x06 0xE0          ; voice0 ADSR2 (SL=7 SR=0)
dsp  = 0x15 0xFF          ; voice1 ADSR1 (AR=15 DR=7)
dsp  = 0x16 0xE0          ; voice1 ADSR2 (SL=7 SR=0)
dsp  = 0x25 0xFF          ; voice2 ADSR1 (AR=15 DR=7)
dsp  = 0x26 0xE0          ; voice2 ADSR2 (SL=7 SR=0)
dsp  = 0x35 0xFF          ; voice3 ADSR1 (AR=15 DR=7)
dsp  = 0x36 0xE0          ; voice3 ADSR2 (SL=7 SR=0)
dsp  = 0x45 0xFF          ; voice4 ADSR1 (AR=15 DR=7)
dsp  = 0x46 0xE0          ; voice4 ADSR2 (SL=7 SR=0)
dsp  = 0x55 0xFF          ; voice5 ADSR1 (AR=15 DR=7)
dsp  = 0x56 0xE0          ; voice5 ADSR2 (SL=7 SR=0)
dsp  = 0x65 0xFF          ; voice6 ADSR1 (AR=15 DR=7)
dsp  = 0x66 0xE0          ; voice6 ADSR2 (SL=7 SR=0)
dsp  = 0x75 0xFF          ; voice7 ADSR1 (AR=15 DR=7)
dsp  = 0x76 0xE0          ; voice7 ADSR2 (SL=7 SR=0)

[song]
base       = 0x2000
limit      = 0x3FFF
channels   = 8
unused_ptr = 0

[notes]
tpq            = 48
octave_base    = 0
octave_default = 4
pitch_min      = 0
pitch_max      = 71
len_min        = 1
len_max        = 255
loop_mode      = expand

[commands]
note         = $pitch $len
rest         = 0xC9 $len
tie          = 0xC8 $len
tempo        = 0x82 (10000/$1)
instrument   = 0x83 $1
volume       = 0x84 $1
pan          = 0x85 $1
gate         = 0x86 $1
loop_point   =
loop_forever = 0x81 @loop_point:w
track_end    = 0x80

[layout]
foreach_track data @track_$ch:w
tracks
`;

  // mmldrv.bin (493 bytes)
  const EMBEDDED_DRIVER_BIN_B64 =
    'IM3vvegAze7UAB3Q+8QAzQD1vwP99cADP5YCPT3IFtDwzQD1ACDUIPUBINQw6AHUQOhk1GDoQNRwPT3I' +
    'ENDkj1P6jwHx5P3w/MQHP1QCiwfQ+S/xjVzoAD+WAsQJxAqPAQjNAPQw8BebQNAFP6ICLw70UPAKdEDQ' +
    'BuQIBArECgsIPT3IENDdjVzkCj+WAo1M5Ak/lgJvy/LE82+NAPcAOgBv9CDEAPQwxAE/mwJogLADXzsD' +
    'aMjwK2jJ8C9ogPAYaIHwNWiC8EJog/BGaITwSmiF8E5ohvBS6ADUMOQIBArECm8/mwLUQF8yAz+bAtRA' +
    '5AgECsQKXzIDP5sCxAI/mwLEAeQCxABfqgI/mwLE+l+qAj+bAtSAX6oCP5sC1GBfqgI/mwLUcF+qAj+b' +
    'AtRQX6oC5ADUIOQB1DBvxAI/mwLUQH0cHBzEBuQCjQBNzQyezsQD3Rz99tUDxAT21gPEBegFgKQD8Aj9' +
    'SwVrBNzQ+eQGCAL95AQ/lgLkBggD/eQFP5YC5AYIBP30gD+WAuh/gLRw+2DPHN08xALkBv3kAj+WAvRw' +
    '+2DPHN08xALkBggB/eQCP5YC5AgECcQJXzIDDH8cfywAPAANAC0APQBNAFwATABsIAAg5yHrIw4mUSi3' +
    'KkEt8i/MMtE1BDloPA==';

  function decodeBase64(b64) {
    const binStr = atob(b64);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    return bytes;
  }

  const EMBEDDED_DRIVER_BIN = decodeBase64(EMBEDDED_DRIVER_BIN_B64);

  // ------------------------------------------------------------------
  // エラークラス & ユーティリティ
  // ------------------------------------------------------------------
  class MMLCompileError extends Error {
    constructor(message, where = '') {
      super(where ? `${where}: ${message}` : message);
      this.name = 'MMLCompileError';
      this.where = where;
      this.rawMessage = message;
    }
  }

  function unquote(s) {
    if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
      return s.slice(1, -1);
    }
    return s;
  }

  function parseNumber(s) {
    s = s.trim();
    let neg = false;
    if (s.startsWith('-')) {
      neg = true;
      s = s.slice(1);
    } else if (s.startsWith('+')) {
      s = s.slice(1);
    }
    let v = 0;
    if (/^0[xX][0-9a-fA-F]+/.test(s)) {
      v = parseInt(s.match(/^0[xX]([0-9a-fA-F]+)/)[1], 16);
    } else if (/^0[bB][01]+/.test(s)) {
      v = parseInt(s.match(/^0[bB]([01]+)/)[1], 2);
    } else {
      const m = s.match(/^[0-9]+/);
      v = m ? parseInt(m[0], 10) : 0;
    }
    return neg ? -v : v;
  }

  function floordiv(a, b) {
    return Math.floor(a / b);
  }

  function normalizeBinaryData(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (Array.isArray(data)) return new Uint8Array(data);
    if (typeof data === 'string') return decodeBase64(data);
    throw new TypeError('Unsupported binary file format');
  }

  // ------------------------------------------------------------------
  // コンパイラ本体クラス
  // ------------------------------------------------------------------
  const CMD_TEMPO = 0;
  const CMD_INSTR = 1;
  const CMD_VOL = 2;
  const CMD_PAN = 3;
  const CMD_GATE = 4;
  const CMD_VEL = 5;
  const NCMD = 6;
  const CMD_NAMES = ['tempo', 'instrument', 'volume', 'pan', 'gate', 'velocity'];

  const EV_NOTE = 0;
  const EV_REST = 1;
  const EV_CMD = 2;
  const EV_LBEGIN = 3;
  const EV_LEND = 4;
  const EV_LPOINT = 5;

  const SEMI_TBL = [9, 11, 0, 2, 4, 5, 7]; // a b c d e f g

  class MMLCompiler {
    constructor() {
      this._reset();
    }

    _reset() {
      this.where = '';
      this.warnings = [];
      this.labels = new Map();
      this.ents = [];
      this.D = {};
      this.song = [];
      this.fixups = [];
      this.tracks = [];
      this.binFiles = [];
      this.samples = [];
      this.dspSets = [];
      this.ram = new Uint8Array(RAMSZ);
      this.dsp = new Uint8Array(128);
      this.xram = new Uint8Array(64);
      this.hdr = new Uint8Array(0x100);
      this.virtualFiles = new Map();
      this.E = {};
    }

    _die(msg) {
      throw new MMLCompileError(msg, this.where);
    }

    _warn(msg) {
      this.warnings.push(this.where ? `${this.where}: ${msg}` : msg);
    }

    _setLabel(name, val) {
      this.labels.set(name, val);
    }

    _getLabel(name) {
      return this.labels.has(name) ? this.labels.get(name) : null;
    }

    _registerFile(name, data) {
      const bytes = normalizeBinaryData(data);
      const norm = name.replace(/\\/g, '/').replace(/^\.\//, '');
      const base = norm.split('/').pop();
      this.virtualFiles.set(name, bytes);
      this.virtualFiles.set(norm, bytes);
      if (!this.virtualFiles.has(base)) {
        this.virtualFiles.set(base, bytes);
      }
    }

    _readVirtualFile(path) {
      const norm = path.replace(/\\/g, '/').replace(/^\.\//, '');
      const base = norm.split('/').pop();
      if (this.virtualFiles.has(path)) return this.virtualFiles.get(path);
      if (this.virtualFiles.has(norm)) return this.virtualFiles.get(norm);
      if (this.virtualFiles.has(base)) return this.virtualFiles.get(base);
      this._die(`cannot open '${path}' (not found in virtual files)`);
    }

    // ----------------------------------------------------------------
    // 式評価器
    // ----------------------------------------------------------------
    _evalStr(s, vars) {
      let pos = 0;
      const len = s.length;

      const ws = () => {
        while (pos < len && /\s/.test(s[pos])) pos++;
      };

      const ident = () => {
        const start = pos;
        while (pos < len && /[a-zA-Z0-9_]/.test(s[pos])) pos++;
        return s.slice(start, pos);
      };

      const prim = () => {
        ws();
        if (s[pos] === '(') {
          pos++;
          const v = bor();
          ws();
          if (s[pos] !== ')') this._die("')' expected in expression");
          pos++;
          return v;
        }
        if (s[pos] === '$') {
          pos++;
          const id = ident();
          if (vars && Object.prototype.hasOwnProperty.call(vars, id)) {
            return vars[id];
          }
          this._die(`unknown variable '$${id}'`);
        }
        if (s[pos] === '@') {
          pos++;
          const id = ident();
          const v = this._getLabel(id);
          if (v === null) this._die(`undefined label '@${id}'`);
          return v;
        }
        if (pos < len && /[0-9]/.test(s[pos])) {
          const sub = s.slice(pos);
          let m;
          if ((m = sub.match(/^0[xX]([0-9a-fA-F]+)/))) {
            pos += m[0].length;
            return parseInt(m[1], 16);
          }
          if ((m = sub.match(/^0[bB]([01]+)/))) {
            pos += m[0].length;
            return parseInt(m[1], 2);
          }
          m = sub.match(/^[0-9]+/);
          pos += m[0].length;
          return parseInt(m[0], 10);
        }
        this._die(`bad expression near '${s.slice(pos)}'`);
      };

      const un = () => {
        ws();
        if (s[pos] === '-') { pos++; return -un(); }
        if (s[pos] === '+') { pos++; return un(); }
        if (s[pos] === '~') { pos++; return ~un(); }
        return prim();
      };

      const mul = () => {
        let a = un();
        for (;;) {
          ws();
          if (s[pos] === '*') {
            pos++;
            a = Math.trunc(a * un());
          } else if (s[pos] === '/') {
            pos++;
            const b = un();
            if (b === 0) this._die('division by zero');
            a = Math.trunc(a / b);
          } else if (s[pos] === '%') {
            pos++;
            const b = un();
            if (b === 0) this._die('division by zero');
            a = a % b;
          } else {
            return a;
          }
        }
      };

      const add = () => {
        let a = mul();
        for (;;) {
          ws();
          if (s[pos] === '+') { pos++; a += mul(); }
          else if (s[pos] === '-') { pos++; a -= mul(); }
          else return a;
        }
      };

      const shift = () => {
        let a = add();
        for (;;) {
          ws();
          if (s[pos] === '<' && s[pos + 1] === '<') { pos += 2; a <<= add(); }
          else if (s[pos] === '>' && s[pos + 1] === '>') { pos += 2; a >>= add(); }
          else return a;
        }
      };

      const band = () => {
        let a = shift();
        for (;;) {
          ws();
          if (s[pos] === '&') { pos++; a &= shift(); }
          else return a;
        }
      };

      const bxor = () => {
        let a = band();
        for (;;) {
          ws();
          if (s[pos] === '^') { pos++; a ^= band(); }
          else return a;
        }
      };

      const bor = () => {
        let a = bxor();
        for (;;) {
          ws();
          if (s[pos] === '|') { pos++; a |= bxor(); }
          else return a;
        }
      };

      const r = bor();
      ws();
      if (pos < len) {
        this._die(`unexpected '${s.slice(pos)}' in expression '${s}'`);
      }
      return r;
    }

    // ----------------------------------------------------------------
    // ドライバ定義 (INI-like) パース
    // ----------------------------------------------------------------
    _cfgAdd(sec, key, val) {
      this.ents.push({ sec, key, val });
    }

    _cfgGet(sec, key) {
      for (let i = 0; i < this.ents.length; i++) {
        if (this.ents[i].sec === sec && this.ents[i].key === key) {
          return this.ents[i].val;
        }
      }
      return null;
    }

    _cfgInt(sec, key, def) {
      const v = this._cfgGet(sec, key);
      return v !== null ? parseNumber(v) : def;
    }

    _loadDriverText(drvText, drvName = 'driver.drv') {
      const lines = drvText.split(/\r?\n/);
      let sec = '';
      for (let i = 0; i < lines.length; i++) {
        this.where = `${drvName}:${i + 1}`;
        let line = lines[i];
        const semi = line.indexOf(';');
        if (semi !== -1) line = line.slice(0, semi);
        const p = line.trim();
        if (!p) continue;

        if (p.startsWith('[')) {
          const q = p.indexOf(']');
          if (q === -1) this._die("']' expected");
          sec = p.slice(1, q).trim().toLowerCase();
          continue;
        }

        if (sec === 'layout') {
          const m = p.match(/^(\S+)(?:\s+(.*))?$/);
          this._cfgAdd(sec, m[1], (m[2] || '').trim());
        } else {
          const eq = p.indexOf('=');
          if (eq === -1) this._die("'key = value' expected");
          const k = p.slice(0, eq).trim().toLowerCase();
          const v = p.slice(eq + 1).trim();
          this._cfgAdd(sec, k, v);
        }
      }
      this.where = '';
    }

    _initDriver() {
      const D = this.D;
      D.tpq = this._cfgInt('notes', 'tpq', 48);
      D.oct_base = this._cfgInt('notes', 'octave_base', 0);
      D.oct_default = this._cfgInt('notes', 'octave_default', 4);
      D.oct_init = this._cfgInt('notes', 'octave_init', D.oct_default);
      D.len_max = this._cfgInt('notes', 'len_max', 255);
      D.len_min = this._cfgInt('notes', 'len_min', 1);
      D.def_gate = this._cfgInt('notes', 'default_gate', 0);
      D.def_vel = this._cfgInt('notes', 'default_velocity', 0);

      D.have_prange = false;
      if (this._cfgGet('notes', 'pitch_min') !== null || this._cfgGet('notes', 'pitch_max') !== null) {
        D.have_prange = true;
        D.pmin = this._cfgInt('notes', 'pitch_min', -9999);
        D.pmax = this._cfgInt('notes', 'pitch_max', 9999);
      }

      D.lt = [];
      const ltStr = this._cfgGet('notes', 'len_table');
      if (ltStr !== null) {
        const parts = ltStr.trim().split(/\s+/).filter(Boolean);
        if (parts.length > 64) this._die('len_table too long');
        D.lt = parts.map(parseNumber);
      }

      const loopMode = this._cfgGet('notes', 'loop_mode');
      D.loop_native = loopMode === 'native';

      D.channels = this._cfgInt('song', 'channels', 8);
      if (D.channels < 1 || D.channels > MAXCH) {
        this._die(`channels must be 1..${MAXCH}`);
      }
      D.unused_ptr = this._cfgInt('song', 'unused_ptr', 0);
      D.base = this._cfgInt('song', 'base', 0x2000);
      D.limit = this._cfgInt('song', 'limit', 0xffbf);

      D.t_state = this._cfgGet('commands', 'state');
      D.t_note = this._cfgGet('commands', 'note');
      D.t_rest = this._cfgGet('commands', 'rest');
      D.t_tie = this._cfgGet('commands', 'tie');
      D.t_oct = this._cfgGet('commands', 'octave');
      D.t_oct_up = this._cfgGet('commands', 'octave_up');
      D.t_oct_dn = this._cfgGet('commands', 'octave_down');
      D.oct_cmd = Boolean(D.t_oct || D.t_oct_up || D.t_oct_dn);

      D.t_lbegin = this._cfgGet('commands', 'loop_begin');
      D.t_lend = this._cfgGet('commands', 'loop_end');
      D.t_lpoint = this._cfgGet('commands', 'loop_point');
      D.t_lforever = this._cfgGet('commands', 'loop_forever');
      D.t_tstart = this._cfgGet('commands', 'track_start');
      D.t_tend = this._cfgGet('commands', 'track_end');
      D.t_cmd = CMD_NAMES.map((name) => this._cfgGet('commands', name));
    }

    // ----------------------------------------------------------------
    // トークンエンコーダ
    // ----------------------------------------------------------------
    _tokSplit(tok) {
      let size = 1;
      let be = false;
      const c = tok.lastIndexOf(':');
      if (c !== -1) {
        const suffix = tok.slice(c + 1);
        if (suffix.length !== 1) {
          this._die(`bad size suffix in '${tok}' (use :b :w :W :l :L)`);
        }
        switch (suffix) {
          case 'b': size = 1; break;
          case 'w': size = 2; break;
          case 'W': size = 2; be = true; break;
          case 'l': size = 3; break;
          case 'L': size = 3; be = true; break;
          default:
            this._die(`bad size suffix in '${tok}' (use :b :w :W :l :L)`);
        }
        tok = tok.slice(0, c);
      }
      return { expr: tok, size, be };
    }

    _tokensSize(tpl) {
      if (!tpl || !tpl.trim()) return 0;
      const toks = tpl.trim().split(/\s+/);
      let total = 0;
      for (const t of toks) {
        total += this._tokSplit(t).size;
      }
      return total;
    }

    _encodeTokens(tpl, vars, here) {
      if (!tpl || !tpl.trim()) return [];
      const toks = tpl.trim().split(/\s+/);
      const total = this._tokensSize(tpl);
      this._setLabel('here', here);
      this._setLabel('next', here + total);

      const out = [];
      for (const rawTok of toks) {
        const { expr, size, be } = this._tokSplit(rawTok);
        const val = this._evalStr(expr, vars);
        const lo = -(1 << (8 * size - 1));
        const hi = (1 << (8 * size)) - 1;
        if (val < lo || val > hi) {
          this._die(`value ${val} out of range for ${size}-byte field in '${tpl}'`);
        }
        for (let k = 0; k < size; k++) {
          const shift = 8 * (be ? size - 1 - k : k);
          out.push((val >>> shift) & 0xff);
        }
      }
      return out;
    }

    // ----------------------------------------------------------------
    // ソングバッファ & Fixups
    // ----------------------------------------------------------------
    _curAddr() {
      return this.D.base + this.song.length;
    }

    _putByte(b) {
      if (this.song.length >= 0x10000) this._die('song data too large');
      this.song.push(b & 0xff);
    }

    _emitNow(tpl, vars) {
      if (!tpl) return;
      const bytes = this._encodeTokens(tpl, vars, this._curAddr());
      for (let i = 0; i < bytes.length; i++) this._putByte(bytes[i]);
    }

    _fixAdd(tpl) {
      const n = this._tokensSize(tpl);
      this.fixups.push({
        off: this.song.length,
        tpl,
        here: this._curAddr(),
      });
      for (let i = 0; i < n; i++) this._putByte(0);
    }

    _fixResolve() {
      for (const fx of this.fixups) {
        const bytes = this._encodeTokens(fx.tpl, {}, fx.here);
        for (let i = 0; i < bytes.length; i++) {
          this.song[fx.off + i] = bytes[i];
        }
      }
    }

    // ----------------------------------------------------------------
    // MML パース
    // ----------------------------------------------------------------
    _stripComment(line) {
      let q = false;
      let out = '';
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') q = !q;
        if (!q && ch === ';') break;
        if (!q && ch === '/' && line[i + 1] === '/') break;
        out += ch === '\r' ? ' ' : ch;
      }
      return out;
    }

    _tagDirective(name, arg) {
      arg = unquote(arg);
      if (name === 'title') this._setText(0x2e, 32, arg);
      else if (name === 'game') this._setText(0x4e, 32, arg);
      else if (name === 'dumper') this._setText(0x6e, 16, arg);
      else if (name === 'comment') this._setText(0x7e, 32, arg);
      else if (name === 'artist') this._setText(0xb1, 32, arg);
      else if (name === 'length') this._setText(0xa9, 3, arg);
      else if (name === 'fade') this._setText(0xac, 5, arg);
      else if (name === 'bin') {
        if (this.binFiles.length >= 32) this._die('too many #bin');
        this.binFiles.push(arg);
      } else if (name === 'sample') {
        const m = arg.match(/^(.*?)[\s]+(\S+)$/);
        if (!m) this._die('#sample "file" <addr>');
        if (this.samples.length >= 64) this._die('too many #sample');
        const addr = parseNumber(m[2]);
        const file = unquote(m[1].trim());
        this.samples.push({ file, addr });
      } else if (name === 'dsp') {
        const m = arg.match(/^(\S+)\s+(.*)$/);
        if (!m) this._die('#dsp <reg> <val>');
        const r = parseNumber(m[1]);
        const v = parseNumber(m[2].trim());
        if (r < 0 || r > 127) this._die('DSP register out of range');
        if (this.dspSets.length >= 128) this._die('too many #dsp');
        this.dspSets.push({ reg: r, val: v });
      } else if (name === 'driver') {
        // プリスキャンで処理済み
      } else {
        this._die(`unknown directive '#${name}'`);
      }
    }

    _parseChunk(ch, s, line) {
      const t = this.tracks[ch];
      this.where = `line ${line} (track ${String.fromCharCode(65 + ch)})`;
      let pos = 0;
      const len = s.length;

      const parseIntAt = () => {
        let neg = false;
        if (s[pos] === '-') {
          neg = true;
          pos++;
        }
        if (pos >= len || !/[0-9]/.test(s[pos])) {
          this._die('number expected');
        }
        let v = 0;
        while (pos < len && /[0-9]/.test(s[pos])) {
          v = v * 10 + (s.charCodeAt(pos++) - 48);
        }
        return neg ? -v : v;
      };

      const parseLenAt = (dflt, need) => {
        let ticks;
        if (s[pos] === '%') {
          pos++;
          ticks = parseIntAt();
        } else if (pos < len && /[0-9]/.test(s[pos])) {
          const n = parseIntAt();
          if (n <= 0 || (this.D.tpq * 4) % n !== 0) {
            this._die(`length 1/${n} is not an integer number of ticks (tpq=${this.D.tpq})`);
          }
          ticks = (this.D.tpq * 4) / n;
        } else {
          if (need) this._die('length expected');
          ticks = dflt;
        }
        let add = ticks;
        while (s[pos] === '.') {
          if (add % 2 !== 0) {
            this._die('dotted length is not an integer number of ticks');
          }
          add = add / 2;
          ticks += add;
          pos++;
        }
        if (ticks <= 0) this._die('length must be positive');
        return ticks;
      };

      while (pos < len) {
        const c = s[pos++];
        if (/\s/.test(c)) continue;

        if (c >= 'a' && c <= 'g') {
          let semi = SEMI_TBL[c.charCodeAt(0) - 97];
          for (;;) {
            if (s[pos] === '+' || s[pos] === '#') { semi++; pos++; }
            else if (s[pos] === '-') { semi--; pos++; }
            else break;
          }
          const pitch = t.oct * 12 + semi;
          const noteLen = parseLenAt(t.deflen, false);
          t.ev.push({ type: EV_NOTE, pitch, len: noteLen, cmd: 0, arg: 0, match: 0, line });
        } else if (c === 'r') {
          const restLen = parseLenAt(t.deflen, false);
          t.ev.push({ type: EV_REST, pitch: 0, len: restLen, cmd: 0, arg: 0, match: 0, line });
        } else if (c === '^') {
          const tieLen = parseLenAt(t.deflen, false);
          if (
            t.ev.length === 0 ||
            (t.ev[t.ev.length - 1].type !== EV_NOTE && t.ev[t.ev.length - 1].type !== EV_REST)
          ) {
            this._die("'^' must follow a note or rest");
          }
          t.ev[t.ev.length - 1].len += tieLen;
        } else if (c === 'l') {
          t.deflen = parseLenAt(0, true);
        } else if (c === 'o') {
          t.oct = parseIntAt();
        } else if (c === '<') {
          t.oct--;
        } else if (c === '>') {
          t.oct++;
        } else if (c === '[') {
          if (t.stack.length >= 32) this._die('loops nested too deeply');
          t.stack.push(t.ev.length);
          t.ev.push({ type: EV_LBEGIN, pitch: 0, len: 0, cmd: 0, arg: 0, match: 0, line });
        } else if (c === ']') {
          if (t.stack.length === 0) this._die("']' without '['");
          let cnt = 2;
          if (pos < len && /[0-9]/.test(s[pos])) cnt = parseIntAt();
          if (cnt < 1) this._die('loop count must be >= 1');
          const b = t.stack.pop();
          t.ev[b].match = t.ev.length;
          t.ev.push({ type: EV_LEND, pitch: 0, len: 0, cmd: 0, arg: cnt, match: b, line });
        } else if (c === 'L') {
          if (t.stack.length > 0) this._die("'L' inside a loop");
          t.ev.push({ type: EV_LPOINT, pitch: 0, len: 0, cmd: 0, arg: 0, match: 0, line });
        } else if (c === 't' || c === '@' || c === 'v' || c === 'p' || c === 'q' || c === 'u') {
          const cmd =
            c === 't' ? CMD_TEMPO :
            c === '@' ? CMD_INSTR :
            c === 'v' ? CMD_VOL :
            c === 'p' ? CMD_PAN :
            c === 'q' ? CMD_GATE : CMD_VEL;
          const arg = parseIntAt();
          t.ev.push({ type: EV_CMD, pitch: 0, len: 0, cmd, arg, match: 0, line });
        } else {
          this._die(`unknown command '${c}'`);
        }
      }
      this.where = '';
    }

    _parseMml(lines) {
      this.tracks = Array.from({ length: MAXCH }, () => ({
        ev: [],
        used: false,
        oct: this.D.oct_default,
        deflen: this.D.tpq,
        stack: [],
      }));

      let cur = [];
      for (let i = 0; i < lines.length; i++) {
        const cleaned = this._stripComment(lines[i]);
        let p = cleaned.trim();
        if (!p) continue;
        this.where = `line ${i + 1}`;

        if (p.startsWith('#')) {
          const m = p.slice(1).match(/^(\S+)(?:\s+(.*))?$/);
          const name = m ? m[1] : '';
          const arg = m && m[2] ? m[2].trim() : '';
          this._tagDirective(name, arg);
          continue;
        }

        if (p[0] >= 'A' && p[0] <= 'H') {
          let q = 0;
          const nextCur = [];
          while (q < p.length && p[q] >= 'A' && p[q] <= 'H') {
            if (nextCur.length < MAXCH) nextCur.push(p.charCodeAt(q) - 65);
            q++;
          }
          if (q === p.length || /\s/.test(p[q])) {
            cur = nextCur;
            for (const ch of cur) {
              if (ch >= this.D.channels) {
                this._die(`channel ${String.fromCharCode(65 + ch)} exceeds driver channel count`);
              }
            }
            p = p.slice(q);
          }
        }

        if (cur.length === 0) {
          this._die('no channel selected (start the line with A-H)');
        }
        for (const ch of cur) {
          this._parseChunk(ch, p, i + 1);
        }
      }

      this.where = '';
      for (let k = 0; k < MAXCH; k++) {
        if (this.tracks[k].stack.length > 0) {
          this.where = `track ${String.fromCharCode(65 + k)}`;
          this._die("unterminated '['");
        }
        this.tracks[k].used = this.tracks[k].ev.length > 0;
      }
    }

    // ----------------------------------------------------------------
    // トラックエンコーダ
    // ----------------------------------------------------------------
    _invState() {
      this.E.len_last = -1;
      this.E.gate_last = -1;
      this.E.vel_last = -1;
      if (this.D.t_oct) this.E.oct_last = -1000;
    }

    _splitLen(len) {
      const out = [];
      let rem = len;
      if (this.D.lt.length > 0) {
        while (rem > 0) {
          let best = 0;
          for (const v of this.D.lt) {
            if (v <= rem && v > best) best = v;
          }
          if (!best) this._die(`length ${len} cannot be expressed with the driver's len_table`);
          if (out.length >= 64) this._die(`length ${len} needs too many ties`);
          out.push(best);
          rem -= best;
        }
      } else {
        while (rem > 0) {
          let c = rem > this.D.len_max ? this.D.len_max : rem;
          if (rem - c > 0 && rem - c < this.D.len_min) c = rem - this.D.len_min;
          if (c < this.D.len_min) {
            this._die(`length ${len} is shorter than the driver minimum (${this.D.len_min})`);
          }
          if (out.length >= 64) this._die(`length ${len} needs too many ties`);
          out.push(c);
          rem -= c;
        }
      }
      return out;
    }

    _lenIndex(c) {
      if (this.D.lt.length === 0) return c;
      const idx = this.D.lt.indexOf(c);
      return idx !== -1 ? idx : 0;
    }

    _ensureOctave(pitch) {
      if (!this.D.oct_cmd) return;
      const target = floordiv(pitch, 12);
      if (target === this.E.oct_last) return;

      if (this.D.t_oct) {
        this._emitNow(this.D.t_oct, { 1: target - this.D.oct_base });
        this.E.oct_last = target;
      } else {
        while (this.E.oct_last < target) {
          if (!this.D.t_oct_up) this._die("driver has no 'octave_up' command");
          this._emitNow(this.D.t_oct_up, {});
          this.E.oct_last++;
        }
        while (this.E.oct_last > target) {
          if (!this.D.t_oct_dn) this._die("driver has no 'octave_down' command");
          this._emitNow(this.D.t_oct_dn, {});
          this.E.oct_last--;
        }
      }
    }

    _emitUnit(kind, pitch, c) {
      const kn = ['note', 'rest', 'tie'];
      const tpl = kind === 0 ? this.D.t_note : kind === 1 ? this.D.t_rest : this.D.t_tie;
      const oct = floordiv(pitch, 12);
      const semi = pitch - oct * 12;

      const vars = {
        len: c,
        lenidx: this._lenIndex(c),
        gate: this.E.gate,
        vel: this.E.vel,
        pitch: this.D.oct_cmd ? semi : pitch - this.D.oct_base * 12,
        semi,
        oct: oct - this.D.oct_base,
      };

      if (
        this.D.t_state &&
        (c !== this.E.len_last || this.E.gate !== this.E.gate_last || this.E.vel !== this.E.vel_last)
      ) {
        this._emitNow(this.D.t_state, vars);
        this.E.len_last = c;
        this.E.gate_last = this.E.gate;
        this.E.vel_last = this.E.vel;
      }

      if (!tpl) this._die(`driver defines no '${kn[kind]}' template`);
      this._emitNow(tpl, vars);
    }

    _encodeRange(t, a, b) {
      for (let i = a; i < b; i++) {
        const e = t.ev[i];
        this.where = `line ${e.line} (track ${String.fromCharCode(65 + this.E.ch)})`;

        switch (e.type) {
          case EV_NOTE:
          case EV_REST: {
            const chunks = this._splitLen(e.len);
            if (e.type === EV_NOTE) {
              if (this.D.have_prange) {
                const p = e.pitch - this.D.oct_base * 12;
                if (p < this.D.pmin || p > this.D.pmax) {
                  this._die('note out of driver range');
                }
              }
              this._ensureOctave(e.pitch);
            }
            for (let k = 0; k < chunks.length; k++) {
              const kind = e.type === EV_NOTE ? (k > 0 ? 2 : 0) : 1;
              this._emitUnit(kind, e.pitch, chunks[k]);
            }
            break;
          }

          case EV_CMD: {
            const tpl = this.D.t_cmd[e.cmd];
            if (tpl) {
              this._emitNow(tpl, { 1: e.arg });
            } else if (e.cmd === CMD_GATE) {
              this.E.gate = e.arg;
            } else if (e.cmd === CMD_VEL) {
              this.E.vel = e.arg;
            } else if (!this.E.warned[e.cmd]) {
              this.E.warned[e.cmd] = true;
              this._warn(`driver has no '${CMD_NAMES[e.cmd]}' command; ignored`);
            }
            break;
          }

          case EV_LBEGIN: {
            const j = e.match;
            const cnt = t.ev[j].arg;
            if (!this.D.loop_native) {
              for (let k = 0; k < cnt; k++) {
                this._encodeRange(t, i + 1, j);
              }
            } else if (cnt === 1) {
              this._encodeRange(t, i + 1, j);
            } else {
              if (this.E.ld >= 32) this._die('loops nested too deeply');
              if (!this.D.t_lbegin || !this.D.t_lend) {
                this._die("loop_mode=native needs 'loop_begin' and 'loop_end'");
              }
              const ld = this.E.ld;
              this.E.lstart[ld] = this._curAddr();
              this._setLabel('loop', this.E.lstart[ld]);
              this._emitNow(this.D.t_lbegin, {});
              this.E.lbody[ld] = this._curAddr();
              this.E.ld++;
              this._invState();
              this._encodeRange(t, i + 1, j);
              this.E.ld--;
              this._setLabel('loop', this.E.lstart[ld]);
              this._setLabel('loop_body', this.E.lbody[ld]);
              this.where = `line ${t.ev[j].line} (track ${String.fromCharCode(65 + this.E.ch)})`;
              this._emitNow(this.D.t_lend, { 1: cnt, count: cnt });
            }
            i = j;
            break;
          }

          case EV_LEND:
            break;

          case EV_LPOINT: {
            this._setLabel(`track_${this.E.ch}_loop`, this._curAddr());
            this._setLabel('loop_point', this._curAddr());
            this._emitNow(this.D.t_lpoint, {});
            this._invState();
            break;
          }
        }
      }
    }

    _emitTrack(ch) {
      const t = this.tracks[ch];
      if (!t.used) return;
      const start = this._curAddr();
      this._setLabel(`track_${ch}`, start);
      this._setLabel(`track_${ch}_loop`, start);

      this.E = {
        len_last: -1,
        gate_last: -1,
        vel_last: -1,
        oct_last: this.D.t_oct ? -1000 : this.D.oct_init,
        gate: this.D.def_gate,
        vel: this.D.def_vel,
        lstart: new Array(32).fill(0),
        lbody: new Array(32).fill(0),
        ld: 0,
        ch,
        warned: new Array(NCMD).fill(false),
      };
      this._invState();

      this._emitNow(this.D.t_tstart, {});
      this._encodeRange(t, 0, t.ev.length);
      this.where = '';

      const hasLoop = t.ev.some((ev) => ev.type === EV_LPOINT);
      if (hasLoop) {
        if (!this.D.t_lforever) {
          this._die(
            `track ${String.fromCharCode(65 + ch)} uses 'L' but the driver defines no 'loop_forever'`
          );
        }
        this._emitNow(this.D.t_lforever, {});
      } else {
        this._emitNow(this.D.t_tend, {});
      }
      this._setLabel(`track_${ch}_end`, this._curAddr());
    }

    // ----------------------------------------------------------------
    // レイアウト構築
    // ----------------------------------------------------------------
    _layoutLine(item, args) {
      if (item === 'label') {
        this._setLabel(args, this._curAddr());
      } else if (item === 'data') {
        this._fixAdd(args);
      } else if (item === 'track') {
        const ch = this._evalStr(args, {});
        this._emitTrack(ch);
      } else if (item === 'tracks') {
        for (let i = 0; i < this.D.channels; i++) this._emitTrack(i);
      } else if (item === 'foreach_track') {
        for (let i = 0; i < this.D.channels; i++) {
          const sub = args.replace(/\$ch(?![a-zA-Z0-9_])/g, String(i)).trim();
          const m = sub.match(/^(\S+)(?:\s+(.*))?$/);
          if (m) this._layoutLine(m[1], (m[2] || '').trim());
        }
      } else if (item === 'incbin') {
        const path = unquote(args.trim());
        const d = this._readVirtualFile(path);
        for (let k = 0; k < d.length; k++) this._putByte(d[k]);
      } else if (item === 'bins') {
        for (let i = 0; i < this.binFiles.length; i++) {
          this._setLabel(`bin_${i}`, this._curAddr());
          const d = this._readVirtualFile(this.binFiles[i]);
          for (let k = 0; k < d.length; k++) this._putByte(d[k]);
        }
      } else if (item === 'align') {
        const n = this._evalStr(args, {});
        if (n < 1) this._die('align must be >= 1');
        while (this._curAddr() % n !== 0) this._putByte(0);
      } else {
        this._die(`unknown layout item '${item}'`);
      }
    }

    _buildSong() {
      let mask = 0;
      this._setLabel('base', this.D.base);
      for (let i = 0; i < MAXCH; i++) {
        const used = i < this.D.channels && this.tracks[i].used ? 1 : 0;
        if (used) mask |= 1 << i;
        this._setLabel(`used_${i}`, used);
        this._setLabel(`track_${i}`, this.D.unused_ptr);
        this._setLabel(`track_${i}_loop`, this.D.unused_ptr);
      }
      this._setLabel('used_mask', mask);

      for (const ent of this.ents) {
        if (ent.sec === 'layout') {
          this.where = `layout '${ent.key}'`;
          this._layoutLine(ent.key, ent.val);
        }
      }
      this.where = '';

      this._setLabel('end', this._curAddr());
      this._setLabel('size', this.song.length);
      this._fixResolve();

      if (this.D.base + this.song.length - 1 > this.D.limit) {
        this._die(
          `song data (${this.song.length} bytes at $${this.D.base
            .toString(16)
            .toUpperCase()
            .padStart(4, '0')}) exceeds limit $${this.D.limit
            .toString(16)
            .toUpperCase()
            .padStart(4, '0')}`
        );
      }
    }

    // ----------------------------------------------------------------
    // SPC イメージ構築
    // ----------------------------------------------------------------
    _setText(off, n, str) {
      const encoder = new TextEncoder();
      const encoded = encoder.encode(str);
      this.hdr.fill(0, off, off + n);
      this.hdr.set(encoded.subarray(0, n), off);
    }

    _initSpc(dateObj) {
      const magic = 'SNES-SPC700 Sound File Data v0.30';
      for (let i = 0; i < magic.length; i++) {
        this.hdr[i] = magic.charCodeAt(i);
      }
      this.hdr[0x21] = 26;
      this.hdr[0x22] = 26;
      this.hdr[0x23] = 26;
      this.hdr[0x24] = 30;

      const now = dateObj instanceof Date ? dateObj : new Date();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const yyyy = String(now.getFullYear()).padStart(4, '0');
      this._setText(0x9e, 11, `${mm}/${dd}/${yyyy}`);
      this._setText(0xa9, 3, '180');
      this._setText(0xac, 5, '10000');
      this.dsp[0x6c] = 0x20;

      for (const ent of this.ents) {
        if (ent.sec !== 'spc') continue;
        if (ent.key === 'load') {
          const m = ent.val.match(/^(.*?)[\s]+(\S+)$/);
          if (!m) this._die('load = <file> <addr>');
          const addr = parseNumber(m[2]);
          const path = unquote(m[1].trim());
          const d = this._readVirtualFile(path);
          if (addr < 0 || addr + d.length > RAMSZ) {
            this._die(`'${path}' does not fit in RAM at $${addr.toString(16).toUpperCase().padStart(4, '0')}`);
          }
          this.ram.set(d, addr);
        } else if (ent.key === 'dsp_file') {
          const path = unquote(ent.val.trim());
          const d = this._readVirtualFile(path);
          this.dsp.set(d.subarray(0, Math.min(128, d.length)), 0);
        }
      }

      for (const ent of this.ents) {
        if (ent.sec !== 'spc') continue;
        if (ent.key === 'dsp' || ent.key === 'poke') {
          const m = ent.val.match(/^(\S+)\s+(.*)$/);
          if (!m) this._die(`'${ent.key} = <addr> <value>' expected`);
          const a = parseNumber(m[1]);
          const v = parseNumber(m[2]);
          if (ent.key === 'dsp') {
            if (a < 0 || a > 127) this._die('DSP register out of range');
            this.dsp[a] = v & 0xff;
          } else {
            if (a < 0 || a > 0xffff) this._die('poke address out of range');
            this.ram[a] = v & 0xff;
          }
        }
      }

      const pc = this._cfgGet('spc', 'pc');
      if (pc !== null) {
        const v = parseNumber(pc);
        this.hdr[0x25] = v & 0xff;
        this.hdr[0x26] = (v >> 8) & 0xff;
      } else {
        this._die('[spc] pc is required');
      }

      const regs = [
        ['a', 0x27],
        ['x', 0x28],
        ['y', 0x29],
        ['psw', 0x2a],
        ['sp', 0x2b],
      ];
      for (const [k, off] of regs) {
        const v = this._cfgGet('spc', k);
        if (v !== null) this.hdr[off] = parseNumber(v) & 0xff;
      }
    }

    _applySongAndPatches() {
      for (const smp of this.samples) {
        this.where = `#sample '${smp.file}'`;
        const d = this._readVirtualFile(smp.file);
        if (smp.addr < 0 || smp.addr + d.length > RAMSZ) {
          this._die(
            `'${smp.file}' does not fit in RAM at $${smp.addr.toString(16).toUpperCase().padStart(4, '0')}`
          );
        }
        this.ram.set(d, smp.addr);
        this.where = '';
      }

      for (const ds of this.dspSets) {
        this.dsp[ds.reg] = ds.val & 0xff;
      }

      if (this.D.base + this.song.length > RAMSZ) {
        this._die('song overflows RAM');
      }
      this.ram.set(this.song, this.D.base);

      for (const ent of this.ents) {
        if (ent.sec === 'song' && ent.key === 'patch') {
          this.where = `patch '${ent.val}'`;
          const m = ent.val.match(/^(\S+)\s+(.*)$/);
          if (!m) this._die('patch = <addr> <tokens...>');
          const addr = this._evalStr(m[1], {});
          const bytes = this._encodeTokens(m[2], {}, addr);
          if (addr < 0 || addr + bytes.length > RAMSZ) {
            this._die('patch address out of range');
          }
          this.ram.set(bytes, addr);
          this.where = '';
        }
      }
    }

    _buildSpcImage() {
      const spc = new Uint8Array(SPCSZ);
      spc.set(this.hdr, 0x000);
      spc.set(this.ram, 0x100);
      spc.set(this.dsp, 0x10100);
      // 0x10180..0x101BF: 64 bytes padding (0)
      spc.set(this.xram, 0x101c0);
      return spc;
    }

    // ----------------------------------------------------------------
    // パブリックコンパイルメソッド
    // ----------------------------------------------------------------
    compile(mmlText, options = {}) {
      this._reset();

      // 埋め込みドライババイナリをデフォルト登録
      this._registerFile('mmldrv.bin', EMBEDDED_DRIVER_BIN);

      // ユーザー指定の仮想ファイル（BRRサンプルや追加バイナリ、カスタムドライバbin等）を登録
      if (options.files) {
        for (const [name, data] of Object.entries(options.files)) {
          this._registerFile(name, data);
        }
      }

      const lines = String(mmlText).split('\n');

      // #driver プリスキャン
      let drvText = options.driver || null;
      let drvName = options.driverName || 'mmldrv.drv';
      if (!drvText) {
        for (let i = 0; i < lines.length; i++) {
          const p = this._stripComment(lines[i]).trim();
          if (p.startsWith('#driver') && (p.length === 7 || /\s/.test(p[7]))) {
            const drvFile = unquote(p.slice(7).trim());
            if (this.virtualFiles.has(drvFile)) {
              const bytes = this._readVirtualFile(drvFile);
              drvText = new TextDecoder().decode(bytes);
              drvName = drvFile;
            } else if (drvFile !== 'mmldrv.drv') {
              this._die(`driver '${drvFile}' not found in options.files`);
            }
          }
        }
      }
      if (!drvText) {
        drvText = EMBEDDED_DRIVER_DRV;
      }

      this._loadDriverText(drvText, drvName);
      this._initDriver();
      this._initSpc(options.date);
      this._parseMml(lines);
      this._buildSong();
      this._applySongAndPatches();

      const spc = this._buildSpcImage();
      const songBytes = new Uint8Array(this.song);

      const trackInfo = [];
      for (let i = 0; i < this.D.channels; i++) {
        const used = this.tracks[i] ? this.tracks[i].used : false;
        const start = used ? this._getLabel(`track_${i}`) : 0;
        const end = used ? this._getLabel(`track_${i}_end`) : 0;
        trackInfo.push({
          channel: i,
          name: String.fromCharCode(65 + i),
          used,
          start,
          end,
          size: used ? end - start : 0,
        });
      }

      return {
        spc,
        song: songBytes,
        base: this.D.base,
        labels: Object.fromEntries(this.labels),
        tracks: trackInfo,
        warnings: [...this.warnings],
        toBlob() {
          return new Blob([spc], { type: 'application/octet-stream' });
        },
        toObjectURL() {
          return URL.createObjectURL(this.toBlob());
        },
      };
    }
  }

  // ------------------------------------------------------------------
  // 便利関数 & エクスポート
  // ------------------------------------------------------------------
  function compile(mmlText, options = {}) {
    const compiler = new MMLCompiler();
    return compiler.compile(mmlText, options);
  }

  function downloadSPC(mmlText, filename = 'song.spc', options = {}) {
    const result = compile(mmlText, options);
    const url = result.toObjectURL();
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return result;
  }

  return {
    compile,
    downloadSPC,
    MMLCompiler,
    MMLCompileError,
    EMBEDDED_DRIVER: {
      drv: EMBEDDED_DRIVER_DRV,
      bin: EMBEDDED_DRIVER_BIN,
    },
  };
});