/* spcgen.js : AI→MIDI→MML→(音源AI)→BRR→SPC パイプライン (mmlc.js 必須) */
(function (root) {
'use strict';
const MMLC = root.MMLC || (typeof require !== 'undefined' ? require('./mmlc.js') : null);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const TPQ = 48, SMP_BASE = 0x4000, SMP_END = 0xF000, DIR = 0x1F00, ECHO_PAGE = 0xF0, ECHO_EDL = 2; // 0xF000-0xFFFFはDSPエコーバッファ(4KB)

// ---------- AI 呼び出し (anthropic / openai互換 / gemini) ----------
const DEFAULTS = {
  anthropic: { endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-5-5' },
  openai: { endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o' },
  gemini: { endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent', model: 'gemini-2.5-flash' }
};
function extractJSON(t) {
  t = String(t).replace(/```(?:json)?/gi, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('AIの応答にJSONがありません');
  const j = t.slice(a, b + 1);
  try { return JSON.parse(j); } catch (e) { return JSON.parse(j.replace(/,\s*([}\]])/g, '$1')); }
}
async function post(url, headers, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const txt = await r.text();
  if (!r.ok) { const e = new Error('AI API ' + r.status + ': ' + txt.slice(0, 300)); e.status = r.status; throw e; }
  try { return JSON.parse(txt); } catch (e) { throw new Error('AI応答がJSONではありません: ' + txt.slice(0, 200)); }
}
async function callOnce(o, system, user, max) {
  const p = o.provider || 'anthropic', d = DEFAULTS[p] || DEFAULTS.openai, model = o.model || d.model;
  const url = (o.endpoint || d.endpoint).replace('{model}', encodeURIComponent(model));
  if (p === 'anthropic') {
    const j = await post(url, { 'x-api-key': o.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      { model, max_tokens: max, system, messages: [{ role: 'user', content: user }] });
    return (j.content || []).map(c => c.text || '').join('');
  }
  if (p === 'gemini') {
    const j = await post(url, { 'x-goog-api-key': o.key }, { systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { maxOutputTokens: max, responseMimeType: 'application/json' } });
    return ((j.candidates || [])[0]?.content?.parts || []).map(x => x.text || '').join('');
  }
  // OpenAI互換: サーバーごとに受け付ける引数が違うので、弾かれたら次の形式で順に再試行
  const base = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  const hdr = o.key ? { authorization: 'Bearer ' + o.key } : {};
  const variants = [{ max_tokens: max, response_format: { type: 'json_object' } }, { max_completion_tokens: max, response_format: { type: 'json_object' } },
    { max_tokens: max }, { max_completion_tokens: max }, {}];
  let last;
  for (const v of variants) {
    try {
      const j = await post(url, hdr, { ...base, ...v });
      const c = j.choices?.[0]?.message?.content;
      return Array.isArray(c) ? c.map(x => x.text || '').join('') : (c || '');
    } catch (e) { last = e; if (e.status !== 400 && e.status !== 422) throw e; }
  }
  throw last;
}
async function callAI(o, system, user, max) {
  let err;
  for (let k = 0; k < 2; k++) {
    try { return extractJSON(await callOnce(o, system, user + (k ? '\n\n(前回はJSONとして解析できませんでした。JSONのみを出力してください)' : ''), max || 8000)); }
    catch (e) { err = e; if (e.status) throw e; }
  }
  throw err;
}

const COMPOSE_SYS = `あなたはSNES(SPC700)向けの作曲家です。曲の長さ・パート構成・曲の進み方・コード進行・拍子感・音色の選び方はすべて自由です。思い描いた曲を最大限に表現してください。JSONのみを出力します。必ず "plan" を最初に書き、設計してから notes を書くこと。
{"title":"ASCII英数字のみ","bpm":40-220,
 "plan":{"concept":"曲の雰囲気・情景・物語","key":"調や音階(自由)","form":"パート構成と各部の小節数(自由)","chords":"和声の考え方","motif":"主題の考え方"},
 "loop_start":0,
 "instruments":[{"id":0,"name":"lead","kind":"tone|perc","desc":"音色の説明(英語・具体的に: 波形/倍音/明るさ/アタック/減衰/揺れ)"}],
 "patterns":{"名前":[[start,len,midi,vel],[start,len,midi,vel,instId,pan]]},
 "tracks":[{"inst":0,"pan":64,"notes":[[start,len,midi,vel],[start,len,midi,vel,instId,pan]],"seq":[["名前",at,transpose,velDelta]]}]}
【ハードウェア上の制約】tracksは最大8本(8ボイス)。各trackは単音(和音禁止・重なり禁止)。start/lenは16分音符単位(1小節=16の目安。小数可)。midiは12-83、velは1-127。panは0-127。instrumentsは最大16個。bpmは曲全体で固定(途中変更不可)。メロディ・和音・ベース・打楽器・効果音的な音など、使い方は自由(和音はアルペジオや複数trackで)。ノート5番目のinstIdと6番目のpanで途中切替可。
【データ量】曲データは展開後の全ノート数が合計およそ6000個までなら収まります。長い曲に挑戦してよい。繰り返す部分はpatterns(start=パターン内の相対位置)を定義し、trackのseqで ["名前", 配置位置(16分単位), 移調(半音), 強弱加算] として参照すると出力が短く済みます(打楽器のpatternは移調0)。patternsとnotesは併用できます。
【最低限のルール】
1) ループ再生される: 曲の最後はloop_start(16分音符単位。0=曲頭。イントロを1回だけ流してから本編頭へ戻したいときはその位置)へ自然につながること。
2) 曲として形を持つ: 始まり・展開・山場・結びがあり、部分ごとの役割と対比、主題の再現や変奏がある。
それ以外(長さ・構成・進行・テンポ・音色・音数・パートの数や役割)はすべて自由。型にはまった定番に寄せず、plan.conceptに沿って独自に設計してください。`;

const SOUND_SYS = `あなたはSNES用の音源デザイナーAIです。音声を直接生成できないので、各instrumentを数式で合成するレシピをJSONのみで返します。
{"samples":[...]} の各要素は id と type を持ち、typeは次のいずれか(基準音はC4):
- "sub"(減算合成): {"osc":[{"wave":"saw|square|tri|sine","level":0-1,"mult":1,"pw":0.5}(最大4,multは倍率1/2/0.5/1.5等)],"noise":0-1,"ndecay":秒,
  "filter":{"type":"lp|hp|bp","cutoff":Hz,"cutoff_end":Hz,"fenv":秒,"res":0.5-10},"env":{"a":秒,"d":秒,"s":0-1},"loop":true(持続音) または false+"dur":秒}
- "string"(弦の物理モデル): {"brightness":0-1,"t60":秒(0.1-3),"pluck":"noise|saw","dur":0.2-1.2}  撥弦・ベル系の低音/ギター/ハープ向け
- "modal"(共振モード物理モデル): {"modes":[[周波数比,振幅,減衰秒],...最大16],"strike":0-1,"dur":0.1-1.2} 鐘・木琴・太鼓・金属音向け
- "tone": {"harmonics":[最大24個の倍音振幅],"gain":0-1} / "perc": {"wave":"sine|square|saw|tri|noise","f0":Hz,"f1":Hz,"noise":0-1,"dur":秒,"decay":1-12}
kindがtoneの音色は持続音(sub loop:true か tone)にするとよく、percはperc/modal/sub(loop:false)にする。descの楽器の実際の倍音構造・フィルタ・減衰を考えて決めること。
設計は自由です。各instrumentのdescに忠実に、波形・倍音・フィルタ・エンベロープ・物理モデル・モードを自分で選び、数値も制限内で自由に決めてください(定番の値に寄せる必要はなく、音色ごとに個性を出すこと)。技術的な注意: ノイズ主体のsubはosc levelを0にする/高いcutoffに強いres(>4)はジャリつく/波形はバンドリミット済み/サンプル領域は合計およそ16〜40KB(ループ音色は0.5〜3KB、0.2秒の単発は約3.5KB)なので、長い単発音を多用しない。`;

// ---------- SMF 書き出し / 読み込み ----------
const vlq = n => { const b = [n & 127]; while ((n >>= 7)) b.unshift((n & 127) | 128); return b; };
const u32 = n => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
function writeSMF(lanes, bpm) {
  const trk = ev => {
    ev.sort((a, b) => a.t - b.t || a.o - b.o);
    const out = []; let last = 0;
    for (const e of ev) { out.push(...vlq(e.t - last), ...e.b); last = e.t; }
    out.push(0, 0xFF, 0x2F, 0);
    return [0x4D, 0x54, 0x72, 0x6B, ...u32(out.length), ...out];
  };
  const us = Math.round(60000000 / bpm);
  const all = [trk([{ t: 0, o: 0, b: [0xFF, 0x51, 3, us >> 16, (us >> 8) & 255, us & 255] }])];
  lanes.forEach((l, ch) => {
    const ev = []; let pg = -1, pn = -1;
    for (const n of l) {
      if (n.prog !== pg) { pg = n.prog; ev.push({ t: n.s, o: -1, b: [0xC0 | ch, pg & 127] }); }
      const pa = clamp(n.pan ?? 64, 0, 127); if (pa !== pn) { pn = pa; ev.push({ t: n.s, o: -1, b: [0xB0 | ch, 10, pa] }); }
      ev.push({ t: n.s, o: 1, b: [0x90 | ch, n.p, n.v] }, { t: n.s + n.d, o: 0, b: [0x80 | ch, n.p, 0] });
    }
    all.push(trk(ev));
  });
  return new Uint8Array([0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, all.length, 0, TPQ, ...all.flat()]);
}
function parseSMF(u8) {
  let p = 0;
  const tag = () => String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
  const r32 = () => { const v = ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0; p += 4; return v; };
  const r16 = () => { const v = (u8[p] << 8) | u8[p + 1]; p += 2; return v; };
  if (tag() !== 'MThd') throw new Error('MIDIファイルではありません');
  p += 4; r32(); r16(); const nt = r16(), ppq = r16();
  if (ppq & 0x8000) throw new Error('SMPTE時間形式は未対応です');
  const lanes = new Map(); let tempo = 500000, got = false;
  for (let t = 0; t < nt && p < u8.length; t++) {
    const isTrk = tag() === 'MTrk'; p += 4; const len = r32(), end = Math.min(p + len, u8.length);
    if (!isTrk) { p = end; t--; continue; }
    let time = 0, run = 0; const prog = new Array(16).fill(0), pan = new Array(16).fill(64), open = new Map();
    const vl = () => { let v = 0, b; do { b = u8[p++]; v = (v << 7) | (b & 127); } while ((b & 128) && p < end); return v; };
    const lane = ch => { const k = t + ':' + ch; if (!lanes.has(k)) lanes.set(k, []); return lanes.get(k); };
    while (p < end) {
      time += vl();
      let st = u8[p]; if (st & 128) { p++; if (st < 0xF0) run = st; } else st = run;
      if (st === 0xFF) { const ty = u8[p++], l = vl(); if (ty === 0x51 && !got && l === 3) { tempo = (u8[p] << 16) | (u8[p + 1] << 8) | u8[p + 2]; got = true; } p += l; continue; }
      if (st === 0xF0 || st === 0xF7) { const l = vl(); p += l; continue; }
      const k = st >> 4, ch = st & 15;
      if (k === 0xC) prog[ch] = u8[p++];
      else if (k === 0xD) p++;
      else if (k === 0xB) { const cc = u8[p++], val = u8[p++]; if (cc === 10) pan[ch] = val; }
      else {
        const a = u8[p++], b = u8[p++], key = ch * 128 + a;
        if (k === 9 && b > 0) open.set(key, { s: time, p: a, v: b, prog: ch === 9 ? 128 : prog[ch], pan: pan[ch], ln: lane(ch) });
        else if (k === 8 || k === 9) {
          const o = open.get(key);
          if (o) { open.delete(key); if (time > o.s) o.ln.push({ s: o.s, d: time - o.s, p: o.p, v: o.v, prog: o.prog, pan: o.pan }); }
        }
      }
    }
    p = end;
  }
  return { ppq, bpm: 60000000 / tempo, lanes: [...lanes.values()] };
}
// 最大8レーン・単音化・tick(48/四分)換算
function prepLanes(lanes, ppq) {
  return lanes.filter(a => a.length).sort((a, b) => b.length - a.length).slice(0, 8).map(a => {
    a = a.slice().sort((x, y) => x.s - y.s || y.p - x.p);
    const out = [];
    for (const n of a) {
      const s = Math.round(n.s * TPQ / ppq); let e = Math.round((n.s + n.d) * TPQ / ppq);
      if (e <= s) e = s + 1;
      const pv = out[out.length - 1];
      if (pv && s < pv.e) { if (s <= pv.s) continue; pv.e = s; }
      out.push({ s, e, p: n.p, v: n.v, prog: n.prog, pan: n.pan ?? 64 });
    }
    return out;
  });
}

// ---------- MIDI → MML ----------
function buildMml(lanes, slotOf, o) {
  const semis = ['c', 'c+', 'd', 'd+', 'e', 'f', 'f+', 'g', 'g+', 'a', 'a+', 'b'];
  let total = 0; for (const l of lanes) for (const n of l) total = Math.max(total, n.e);
  total = Math.max(192, Math.ceil(Math.min(total, o.maxTick) / 192) * 192);
  let out = '';
  lanes.forEach((l, i) => {
    const tk = []; const LT = o.loop && o.loopTick > 0 && o.loopTick < total ? o.loopTick : 0; let lset = false; if (o.loop && !LT) tk.push('L');
    tk.push('t' + o.bpm);
    let cur = 0, oct = -1, sl = -1, vq = -1, pn = -1;
    for (const n of l) {
      if (n.s >= total) break;
      let e = Math.min(n.e, total);
      if (LT && !lset && n.s < LT && e > LT) e = LT; // ループ境界をまたぐ音は境界で切る
      if (LT && !lset && n.s >= LT) { if (cur < LT) { tk.push('r%' + (LT - cur)); cur = LT; } tk.push('L'); lset = true; sl = vq = pn = oct = -1; }
      if (n.s > cur) tk.push('r%' + (n.s - cur));
      let m = n.p; while (m < 12) m += 12; while (m > 83) m -= 12;
      const s = slotOf.get(n.prog) ?? 0;
      if (s !== sl) { tk.push('@' + s); sl = s; }
      const q = Math.max(1, Math.round(n.v / 127 * 12));
      if (q !== vq) { tk.push('v' + Math.round(q / 12 * 127)); vq = q; }
      const pa = clamp(Math.round(n.pan ?? 64), 0, 127);
      if (pa !== pn) { tk.push('p' + pa); pn = pa; }
      const oc = Math.floor(m / 12) - 1;
      if (oc !== oct) { tk.push('o' + oc); oct = oc; }
      tk.push(semis[m % 12] + '%' + (e - n.s)); cur = e;
    }
    if (!l.length) return;
    if (LT && !lset) { if (cur < LT) { tk.push('r%' + (LT - cur)); cur = LT; } tk.push('L'); lset = true; }
    if (total > cur) tk.push('r%' + (total - cur));
    let line = '';
    for (const t of tk) { if (line.length > 60) { out += 'ABCDEFGH'[i] + ' ' + line + '\n'; line = ''; } line += t + ' '; }
    out += 'ABCDEFGH'[i] + ' ' + line + '\n';
  });
  return { mml: out, total };
}

// ---------- 音源レンダリング → BRR ----------
const lcg = seed => { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1; };
function renderTone(sp) {
  const P = 32000 / 261.6256; let bn = 1, bL = 128, be = 9;
  for (let n = 1; n <= 8; n++) { const L = Math.max(16, Math.round(n * P / 16) * 16), er = Math.abs(L / n / P - 1); if (er < be) { be = er; bn = n; bL = L; } }
  const h = (Array.isArray(sp.harmonics) && sp.harmonics.length ? sp.harmonics : [1]).slice(0, Math.min(24, hmaxOf(sp))).map(Number);
  const x = new Float64Array(bL); let pk = 1e-9;
  for (let i = 0; i < bL; i++) {
    let v = 0; const ph = 2 * Math.PI * i * bn / bL;
    h.forEach((a, k) => { v += (a || 0) * Math.sin(ph * (k + 1)); });
    x[i] = v; pk = Math.max(pk, Math.abs(v));
  }
  const g = clamp(+sp.gain || 0.8, 0.1, 1) * 0.85 * 32767 / pk;
  return Int16Array.from(x, v => Math.round(v * g));
}
function renderPerc(sp, scale) {
  const dur = clamp((+sp.dur || 0.2) * scale, 0.02, 0.8), N = Math.ceil(dur * 32000 / 16) * 16;
  const f0 = clamp(+sp.f0 || 200, 20, 8000), f1 = clamp(+sp.f1 || f0, 20, 8000);
  const nm = clamp(+sp.noise || 0, 0, 1), dec = clamp(+sp.decay || 6, 0.5, 20), rnd = lcg(12345);
  const x = new Float64Array(N); let ph = 0, pk = 1e-9;
  for (let i = 0; i < N; i++) {
    const t = i / N; ph += f0 * Math.pow(f1 / f0, t) / 32000;
    const q = ph % 1; let w;
    switch (sp.wave) { case 'square': w = q < .5 ? 1 : -1; break; case 'saw': w = 2 * q - 1; break; case 'tri': w = 4 * Math.abs(q - .5) - 1; break; case 'noise': w = rnd(); break; default: w = Math.sin(2 * Math.PI * q); }
    x[i] = (w * (1 - nm) + rnd() * nm) * Math.exp(-dec * t) * Math.min(1, i / 48, (N - i) / 48);
    pk = Math.max(pk, Math.abs(x[i]));
  }
  const g = clamp(+sp.gain || 0.9, 0.1, 1) * 0.9 * 32767 / pk;
  return Int16Array.from(x, v => Math.round(v * g));
}
function brrEncode(pcm, loop, lb) {
  const nb = Math.ceil(pcm.length / 16), out = new Uint8Array(nb * 9); let p1 = 0, p2 = 0;
  const wrap = s => ((s << 1) << 16 >> 16) >> 1;
  for (let b = 0; b < nb; b++) {
    let best = null;
    for (let f = 0; f < (b === 0 || (loop && b === lb) ? 1 : 4); f++) for (let r = 0; r <= 12; r++) {
      let s1 = p1, s2 = p2, err = 0; const nib = new Array(16);
      for (let i = 0; i < 16; i++) {
        const t = (pcm[b * 16 + i] || 0) >> 1;
        const pr = f === 0 ? 0 : f === 1 ? s1 + ((-s1) >> 4) : f === 2 ? (s1 << 1) + ((-s1 * 3) >> 5) - s2 + (s2 >> 4) : (s1 << 1) + ((-s1 * 13) >> 6) - s2 + ((s2 * 3) >> 4);
        const q = clamp(Math.round((t - pr) / (r === 0 ? 0.5 : Math.pow(2, r - 1))), -8, 7);
        let s = ((q << r) >> 1) + pr;
        if (s > 16383 || s < -16384) err += 1e12;
        s = wrap(clamp(s, -32768, 32767));
        err += (s - t) * (s - t); nib[i] = q & 15; s2 = s1; s1 = s;
      }
      if (!best || err < best.err) best = { err, f, r, nib, s1, s2 };
    }
    out[b * 9] = (best.r << 4) | (best.f << 2) | (b === nb - 1 ? (loop ? 3 : 1) : 0);
    for (let i = 0; i < 8; i++) out[b * 9 + 1 + i] = (best.nib[2 * i] << 4) | best.nib[2 * i + 1];
    p1 = best.s1; p2 = best.s2;
  }
  return out;
}
// ---- 共通 ----
const F = 32000, LF = F / 261.6256;
const hmaxOf = sp => clamp(Math.floor(56 / (sp._r || 1)), 4, 60); // 最高使用音の再生倍率から倍音数上限を決める
function blosc(w, ph, pw, H) { // バンドリミット発振器(加算合成)
  const x = 2 * Math.PI * (ph - Math.floor(ph)); let v = 0;
  if (w === 'saw') { for (let k = 1; k <= H; k++) v -= Math.sin(k * x) / k; return v * 2 / Math.PI; }
  if (w === 'square') { pw = pw || 0.5; v = 2 * pw - 1; for (let k = 1; k <= H; k++) { const a = 2 * Math.PI * k * pw; v += (2 * Math.sin(a) * Math.cos(k * x) + 2 * (1 - Math.cos(a)) * Math.sin(k * x)) / (Math.PI * k); } return v; }
  if (w === 'tri') { for (let k = 1; k <= H; k += 2) v += Math.cos(k * x) / (k * k); return v * 8 / (Math.PI * Math.PI); }
  return Math.sin(x);
}
const toI16 = (x, pk0) => { let pk = 1e-9; for (const v of x) pk = Math.max(pk, Math.abs(v)); const g = (pk0 || 0.9) * 32767 / pk; return Int16Array.from(x, v => Math.round(v * g)); };
function pickN(maxN) { let bn = 1, bL = 128, be = 9; for (let n = 1; n <= maxN; n++) { const L = Math.max(16, Math.round(n * LF / 16) * 16), er = Math.abs(L / n / LF - 1); if (er < be) { be = er; bn = n; bL = L; } } return [bn, bL]; }

// ---- 減算合成 (周期ループ対応: 発振器は全てループ長の整数サイクル) ----
const osc = (w, ph, pw) => { const q = ph - Math.floor(ph); switch (w) { case 'square': return q < (pw || .5) ? 1 : -1; case 'saw': return 2 * q - 1; case 'tri': return 4 * Math.abs(q - .5) - 1; default: return Math.sin(2 * Math.PI * q); } };
function renderSub(sp, scale) {
  const loop = sp.loop !== false, e = sp.env || {}, fl = sp.filter || {}, hm = hmaxOf(sp);
  const a = clamp(+e.a || 0.005, 0.001, 1), d = clamp(+e.d || 0.1, 0.005, 2), su = clamp(e.s ?? 0.7, 0, 1);
  const c0 = clamp(+fl.cutoff || 8000, 40, 14000), c1 = clamp(+fl.cutoff_end || c0, 40, 14000), fe = clamp(+fl.fenv || 0.2, 0.005, 2), k = 1 / clamp(+fl.res || 0.7, 0.5, 12), ft = fl.type || 'lp';
  const os = (Array.isArray(sp.osc) && sp.osc.length ? sp.osc : [{ wave: 'saw', level: 1 }]).slice(0, 4);
  const nz = clamp(+sp.noise || 0, 0, 1), nd = clamp(+sp.ndecay || 0.05, 0.005, 1), rnd = lcg(4242);
  let n = 1, L = 0, ls = 0, N, dur = 0;
  if (loop) { [n, L] = pickN(16); ls = 16 * Math.ceil(Math.min((a + d) * 1.3 + 0.03, 0.8 * scale) * F / 16); N = ls + 4 * L; } // 後ろ3周はフィルタを定常状態にするための助走
  else { dur = clamp((+sp.dur || 0.4) * scale, 0.05, 1.2); N = Math.ceil(dur * F / 16) * 16; }
  const x = new Float64Array(N); let ic1 = 0, ic2 = 0;
  for (let i = 0; i < N; i++) {
    const t = loop && i >= ls ? ls / F : i / F; let v = 0; // ループ部はエンベロープ/カットオフを固定
    for (const o of os) { const m = +o.mult || 1, H = Math.max(1, Math.floor(hm / m)), ph = loop ? Math.max(1, Math.round(n * m)) * i / L : 261.6256 * m * t; v += (+o.level || 0) * blosc(o.wave, ph, +o.pw, H); }
    if (nz && (!loop || i < ls)) v += nz * Math.exp(-t / nd) * rnd();
    const env = t < a ? t / a : su + (1 - su) * Math.exp(-5 * (t - a) / d);
    const fc = c1 + (c0 - c1) * Math.exp(-t / fe), g = Math.tan(Math.PI * Math.min(fc, 15000) / F);
    const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2, v3 = v - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    x[i] = (ft === 'hp' ? v - k * v1 - v2 : ft === 'bp' ? v1 : v2) * env * (loop ? 1 : Math.pow(1 - t / dur, 2));
  }
  if (!loop) return { pcm: toI16(x), loop, loopStart: 0 };
  const y = new Float64Array(ls + L); y.set(x.subarray(0, ls)); y.set(x.subarray(N - L), ls);
  return { pcm: toI16(y), loop, loopStart: ls };
}
// ---- 物理モデリング (Karplus-Strong弦 / モーダル共振) ----
function renderPhys(sp, scale) {
  const dur = clamp((+sp.dur || 0.8) * scale, 0.1, 1.2), N = Math.ceil(dur * F / 16) * 16, x = new Float64Array(N), rnd = lcg(777);
  if (sp.type === 'string') {
    const b = 0.5 + 0.5 * clamp(sp.brightness ?? 0.5, 0, 1), D = LF - (1 - b), g = Math.pow(0.001, LF / (clamp(+sp.t60 || 1, 0.05, 4) * F));
    const h = j => j < 0 ? 0 : x[j];
    for (let n = 0; n < N; n++) {
      const t = n - D, i0 = Math.floor(t), fr = t - i0;
      let v = g * (b * (h(i0) * (1 - fr) + h(i0 + 1) * fr) + (1 - b) * (h(i0 - 1) * (1 - fr) + h(i0) * fr));
      if (n < D) v += sp.pluck === 'saw' ? 2 * n / D - 1 : rnd();
      x[n] = v;
    }
  } else {
    const modes = (Array.isArray(sp.modes) && sp.modes.length ? sp.modes : [[1, 1, 0.5], [2.76, .5, .3], [5.4, .3, .2]]).slice(0, 16);
    for (const [r, am, t60] of modes) {
      const f = 261.6256 * (+r || 1); if (f * (sp._r || 1) > 15000) continue;
      const dk = 6.9 / clamp(+t60 || 0.3, 0.02, 3);
      for (let i = 0; i < N; i++) x[i] += (+am || 0) * Math.exp(-dk * i / F) * Math.sin(2 * Math.PI * f * i / F);
    }
    const st = clamp(+sp.strike || 0, 0, 1); for (let i = 0; i < N && st; i++) x[i] += st * rnd() * Math.exp(-i / F / 0.004);
  }
  for (let i = 0; i < 64; i++) x[N - 1 - i] *= i / 64;
  return { pcm: toI16(x), loop: false, loopStart: 0 };
}
const guessSpec = (d, id) => /drum|perc|kick|snare|hat|cymbal|noise|ドラム|打楽|キック|スネア|ハット/i.test(d)
  ? { id, type: 'perc', wave: /hat|cymbal|noise|ハット/i.test(d) ? 'noise' : 'sine', f0: /snare|スネア/i.test(d) ? 220 : 120, f1: 50, noise: /snare|hat|noise|スネア|ハット/i.test(d) ? 0.8 : 0.05, dur: 0.18, decay: 7 }
  : { id, type: 'tone', harmonics: [1, .5, .33, .25, .2, .16, .14, .12], gain: 0.8 };
function item(sp, scale) {
  switch (sp.type) {
    case 'sub': return renderSub(sp, scale);
    case 'string': case 'modal': return renderPhys(sp, scale);
    case 'perc': return { pcm: renderPerc(sp, scale), loop: false, loopStart: 0 };
    default: return { pcm: renderTone(sp), loop: true, loopStart: 0 };
  }
}
function buildSamples(specs, base = SMP_BASE) {
  const cap = SMP_END - base; let scale = 1;
  for (let k = 0; k < 10; k++) {
    const items = specs.map(sp => { const r = item(sp, scale); return { loop: r.loop, loopBlock: r.loopStart / 16, brr: brrEncode(r.pcm, r.loop, r.loopStart / 16) }; });
    const tot = items.reduce((a, s) => a + s.brr.length, 0);
    if (tot <= cap || k === 9) {
      if (tot > cap) throw new Error('サンプル容量超過: ' + tot + ' bytes');
      let addr = base; const dir = new Uint8Array(items.length * 4);
      items.forEach((s, i) => { const lp = addr + s.loopBlock * 9; s.addr = addr; dir.set([addr & 255, addr >> 8, lp & 255, lp >> 8], i * 4); addr += s.brr.length; });
      return { items, dir };
    }
    scale *= 0.75;
  }
}

// ---------- コンパイル ----------
function compileSong(mmlBody, smp, title, seconds, eon) {
  const files = { 'dir.bin': smp.dir };
  let pre = '#title ' + String(title || 'AI SPC').replace(/[^\x20-\x7e]|;/g, '').slice(0, 32) + '\n#length ' + clamp(Math.ceil(seconds), 10, 999) + '\n#sample "dir.bin" 0x' + DIR.toString(16) + '\n';
  if (eon) { // SNES DSPエコー(ローパスFIR)でリバーブ感を付与
    const dsp = (r, v) => '#dsp 0x' + r.toString(16) + ' 0x' + v.toString(16) + '\n';
    pre += dsp(0x6C, 0x00) + dsp(0x7D, ECHO_EDL) + dsp(0x6D, ECHO_PAGE) + dsp(0x0D, 0x48) + dsp(0x2C, 0x28) + dsp(0x3C, 0x28) + dsp(0x4D, eon);
    [0x0C, 0x21, 0x2B, 0x2B, 0x13, 0xFE, 0xF3, 0xF9].forEach((v, i) => { pre += dsp(i * 16 + 0x0F, v); });
  }
  smp.items.forEach((s, i) => { files['i' + i + '.brr'] = s.brr; pre += '#sample "i' + i + '.brr" 0x' + s.addr.toString(16) + '\n'; });
  return MMLC.compile(pre + mmlBody, { files });
}
function makeSong(lanes, slotOf, smp, o, log) {
  let maxTick = 1e9;
  for (let k = 0; k < 25; k++) {
    const b = buildMml(lanes, slotOf, { bpm: o.bpm, loop: o.loop, maxTick, loopTick: o.loopTick });
    try {
      const res = compileSong(b.mml, smp, o.title, b.total / TPQ * 60 / o.bpm * (o.loop ? 2 : 1) + 5, o.eon);
      return { res, mml: b.mml, seconds: b.total / TPQ * 60 / o.bpm };
    } catch (e) {
      if (!/exceeds limit|too large|overflows/.test(e.message)) throw e;
      maxTick = Math.floor(b.total * 0.9 / 192) * 192;
      log('曲データが8KBを超過 → ' + (maxTick / 192) + '小節に短縮して再試行');
      if (maxTick < 384) throw e;
    }
  }
  throw new Error('曲データを収められませんでした');
}

function expand(t, pats) { // patterns参照(seq)をノート列に展開
  const out = (t.notes || []).slice();
  for (const q of t.seq || []) {
    const pt = (pats || {})[q[0]]; if (!Array.isArray(pt)) continue;
    const at = +q[1] || 0, tr = +q[2] || 0, vd = +q[3] || 0;
    for (const n of pt) { const m = n.slice(); m[0] = +n[0] + at; m[2] = +n[2] + tr; m[3] = (+n[3] || 80) + vd; out.push(m); }
  }
  return out;
}
// ---------- 全体パイプライン ----------
async function generate(o, log) {
  let midi, descs = {}, kinds = {}, loopTick = 0, title = o.title || 'AI SPC';
  if (o.midiBytes) { midi = o.midiBytes; log('① MIDIファイルを使用'); }
  else {
    log('① 作曲AIにMIDI(8ch・単音)を生成させています…');
    const c = await callAI(o.ai, COMPOSE_SYS, 'リクエスト: ' + o.prompt, 32000);
    (c.instruments || []).forEach(i => { descs[i.id] = (i.name || '') + ': ' + (i.desc || ''); kinds[i.id] = i.kind; });
    const lanes = (c.tracks || []).slice(0, 8).map(t => {
      const out = []; const dflt = +t.inst || 0, tp = clamp(Math.round(t.pan ?? 64), 0, 127);
      for (const n of expand(t, c.patterns)) {
        const p = clamp(Math.round(+n[2]), 12, 83), v = clamp(Math.round(+n[3]) || 80, 1, 127);
        if (!(n[1] > 0) || !isFinite(n[0])) continue;
        out.push({ s: Math.round(n[0] * 12), d: Math.max(1, Math.round(n[1] * 12)), p, v, prog: n[4] != null ? +n[4] : dflt, pan: n[5] != null ? clamp(Math.round(+n[5]), 0, 127) : tp });
      }
      return out;
    }).filter(l => l.length);
    if (!lanes.length) throw new Error('AIが有効なノートを返しませんでした');
    midi = writeSMF(lanes.map(l => { l.sort((a, b) => a.s - b.s); return l; }), clamp(c.bpm || 120, 40, 255));
    title = c.title || title;
    loopTick = Math.max(0, Math.round((+c.loop_start || 0) * 12));
    if (c.plan) log('   構成: ' + [c.plan.key, c.plan.form].filter(Boolean).join(' / '));
    log('   → MIDI生成完了 (' + midi.length + ' bytes, ' + lanes.length + 'ch)');
  }
  const m = parseSMF(midi), lanes = prepLanes(m.lanes, m.ppq), bpm = Math.round(clamp(m.bpm, 40, 255));
  const slotOf = new Map(); lanes.forEach(l => l.forEach(n => { if (!slotOf.has(n.prog) && slotOf.size < 16) slotOf.set(n.prog, slotOf.size); }));
  const slots = [...slotOf.keys()].map((pg, i) => { const desc = descs[pg] || (pg === 128 ? 'drum kit (percussion)' : 'GM program ' + pg); return { slot: i, prog: pg, desc, kind: kinds[pg] === 'perc' || kinds[pg] === 'tone' ? kinds[pg] : (pg === 128 || guessSpec(desc, 0).type === 'perc' ? 'perc' : 'tone') }; });
  log('② MIDI→MML 変換: ' + lanes.length + 'ch / 音色' + slots.length + '種 / ' + bpm + ' BPM');

  const ratio = slots.map(s => { const ps = []; lanes.forEach(l => l.forEach(n => { if (n.prog === s.prog) { let m = n.p; while (m < 12) m += 12; while (m > 83) m -= 12; ps.push(m); } })); ps.sort((a, b) => a - b); const hi = s.kind === 'perc' ? 60 : (ps[Math.floor(ps.length * 0.8)] ?? 60); return Math.max(1, Math.pow(2, (hi - 60) / 12)); });
  let eon = 0; lanes.forEach((l, i) => { const ps = l.map(n => n.p).sort((a, b) => a - b), pc = l.filter(n => slots[slotOf.get(n.prog) ?? 0]?.kind === 'perc').length; if (pc * 2 < l.length && ps[ps.length >> 1] >= 55) eon |= 1 << i; }); // ドラム・低音以外にエコー
  const fin = new Array(slots.length).fill(null);
  const need = slots.filter(s => !fin[s.slot]);
  if (need.length) {
    log('③ AIがテキストで物理モデリング/減算合成のレシピを設計しています…');
    try {
      const r = await callAI(o.sound || o.ai, SOUND_SYS, JSON.stringify({ instruments: need.map(s => ({ id: s.slot, kind: s.kind, desc: s.desc })) }), 16000);
      (r.samples || []).forEach(x => { if (need.some(s => s.slot === x.id) && ['tone', 'perc', 'sub', 'string', 'modal'].includes(x.type)) { try { item(x, 1); fin[x.id] = x; } catch (e) { log('   @' + x.id + ' レシピ不正: ' + e.message); } } });
    } catch (e) { log('   テキストAI失敗(' + e.message + ')'); }
    slots.forEach(s => { if (!fin[s.slot]) { fin[s.slot] = guessSpec(s.kind === 'perc' ? 'drum ' + s.desc : s.desc, s.slot); log('   @' + s.slot + ' 既定の音色を使用'); } });
  }
  fin.forEach((sp, i) => { sp._r = ratio[i]; });
  let base = 0xB000;
  try { // 曲データのサイズを先に測り、その直後からサンプルを置く(曲に最大36KB)
    const dm = { dir: new Uint8Array(4), items: [{ addr: 0xB000, brr: new Uint8Array(9) }] };
    const b0 = buildMml(lanes, slotOf, { bpm, loop: o.loop, maxTick: 1e9, loopTick });
    const sz = compileSong(b0.mml, dm, title, 60, eon).song.length;
    base = clamp((0x2000 + sz + 0x1FF) & ~0xFF, 0x4000, 0xB000);
    log('   曲データ ' + sz + ' bytes / サンプル領域 ' + (SMP_END - base) + ' bytes');
  } catch (e) { log('   曲データが大きいため一部を短縮します'); }
  log('④ BRR化…');
  const smp = buildSamples(fin, base);
  log('   → ' + smp.items.map((s, i) => '@' + i + ':' + fin[i].type + ' ' + s.brr.length + 'B').join(' / '));
  log('⑤ SPCコンパイル…');
  const r = makeSong(lanes, slotOf, smp, { bpm, loop: o.loop, title, eon, loopTick }, log);
  return { eon, loopTick, spc: r.res.spc, mml: r.mml, midi, slots, fin, smp, title, bpm, lanes, slotOf, seconds: r.seconds, warnings: r.res.warnings };
}
// MML手編集後の再コンパイル(サンプルはそのまま)
function recompile(mml, st) { return compileSong(mml, st.smp, st.title, st.seconds * 2 + 5, st.eon); }

const API = { generate, recompile, callAI, DEFAULTS, item, writeSMF, parseSMF, prepLanes, buildMml, brrEncode, buildSamples, compileSong, renderTone, renderPerc };
if (typeof module === 'object' && module.exports) module.exports = API; else root.SPCGEN = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
