/* agenttools.js : 作曲エージェント用ツール群 (spcgen.js / libspc.js 必須)
 * 各ツールは run(st, args, ctx) → JSON化できる結果 を返す。st は agent.js が持つセッション状態(JSON)。
 * 状態を変えるツールは ctx.touch() を呼び rev を進める。 */
(function (root) {
'use strict';
const isNode = typeof module === 'object' && module.exports;
const S = isNode ? require('./spcgen.js') : root.SPCGEN;
const LIB = isNode ? require('./libspc.js') : { SPCEngine: typeof SPCEngine !== 'undefined' ? SPCEngine : null, parseSPC: root.parseSPC };

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const r1 = x => Math.round(x * 10) / 10, r2 = x => Math.round(x * 100) / 100, r3 = x => Math.round(x * 1000) / 1000;
const NN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const nn = m => NN[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
const db = x => x > 1e-9 ? r1(20 * Math.log10(x)) : -99;
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) * (x - m)))); };
const yieldUI = () => new Promise(r => setTimeout(r, 0));

// ---------- 状態ヘルパ ----------
function ensure(st) {
  st.song = st.song || { title: 'untitled', bpm: 120, loop_start: 0, plan: {}, instruments: [], patterns: {}, tracks: [] };
  st.sounds = st.sounds || {}; st.snapshots = st.snapshots || {}; st.evals = st.evals || {}; st.evals = Array.isArray(st.evals) ? st.evals : [];
  st.notes = st.notes || []; st.todo = st.todo || []; st.rev = st.rev || 0;
  return st;
}
function trk(st, i) {
  i = Math.round(+i);
  if (!(i >= 0 && i < 8)) throw new Error('track は 0〜7 の整数');
  const T = st.song.tracks;
  while (T.length <= i) T.push({ inst: 0, pan: 64, notes: [], seq: [] });
  return T[i];
}
const expandedOf = (st, t) => S.expand(t, st.song.patterns).map(n => ({ s: +n[0], l: +n[1], p: Math.round(+n[2]), v: Math.round(+n[3]) || 80, inst: n[4] != null ? +n[4] : (+t.inst || 0) })).filter(n => n.l > 0 && isFinite(n.s)).sort((a, b) => a.s - b.s);
const kindOf = (st, id) => (st.song.instruments.find(i => i.id === id) || {}).kind || 'tone';
function cleanNotes(arr) {
  const out = []; let bad = 0, clamped = 0;
  for (const n of Array.isArray(arr) ? arr : []) {
    if (!Array.isArray(n) || n.length < 3) { bad++; continue; }
    const s = +n[0], l = +n[1], p = Math.round(+n[2]), v = n[3] == null ? 80 : Math.round(+n[3]);
    if (!isFinite(s) || !(l > 0) || !isFinite(p) || s < 0) { bad++; continue; }
    const cp = clamp(p, 12, 83); if (cp !== p) clamped++;
    const m = [r3(s), r3(l), cp, clamp(v, 1, 127)];
    if (n.length > 4 && (n[4] != null || n[5] != null)) { m.push(n[4] == null ? null : +n[4]); if (n[5] != null) m.push(clamp(Math.round(+n[5]), 0, 127)); }
    out.push(m);
  }
  return { out, bad, clamped };
}
function monoFix(notes) { // 重なりを自動解消(前の音を次の頭で切る/同時刻は先勝ち)
  notes.sort((a, b) => a[0] - b[0]); let fixed = 0;
  for (let i = 0; i < notes.length - 1; i++) {
    const c = notes[i], n = notes[i + 1];
    if (n[0] - c[0] < 1e-6) { notes.splice(i + 1, 1); i--; fixed++; }
    else if (c[0] + c[1] > n[0] + 1e-6) { c[1] = r3(n[0] - c[0]); fixed++; }
  }
  return fixed;
}
const totalSteps = st => {
  let m = 0; for (const t of st.song.tracks) for (const n of expandedOf(st, t)) m = Math.max(m, n.s + n.l);
  return Math.ceil(m);
};

// ---------- 音源/曲のビルド(キャッシュ付) ----------
async function build(st, ctx) {
  if (ctx.cache && ctx.cache.rev === st.rev && ctx.cache.res) return ctx.cache.res;
  const sg = st.song, raw = [], idx = [];
  sg.tracks.forEach((t, i) => { const l = S.songToLanes({ tracks: [t], patterns: sg.patterns })[0]; if (l && l.length) { raw.push(l); idx.push(i); } });
  if (!raw.length) throw new Error('ノートが1つもありません。write_track で書いてください');
  const lanes = S.songToLanes({ tracks: sg.tracks, patterns: sg.patterns });
  const descs = {}, kinds = {}; sg.instruments.forEach(i => { descs[i.id] = (i.name || '') + ': ' + (i.desc || ''); kinds[i.id] = i.kind; });
  const defaults = [];
  const res = await S.assemble({
    lanes, ppq: S.TPQ, bpm: sg.bpm, loopTick: Math.round((+sg.loop_start || 0) * 12), title: sg.title, descs, kinds, loop: true,
    getSpecs: async slots => slots.map(s => {
      const sp = st.sounds[s.prog];
      if (sp) return { ...sp, id: s.slot };
      defaults.push(s.prog); return S.guessSpec(s.kind === 'perc' ? 'drum ' + s.desc : s.desc, s.slot);
    })
  });
  res.midi = S.writeSMF(lanes.map(l => l.slice().sort((a, b) => a.s - b.s)), clamp(sg.bpm, 40, 255));
  res.defaultInsts = defaults;
  res.voiceTrack = idx.map((ti, k) => ({ ti, len: raw[k].length })).sort((a, b) => b.len - a.len).slice(0, 8).map(x => x.ti); // 音声ボイス番号→トラック番号
  ctx.cache = { rev: st.rev, res };
  return res;
}

// ---------- 小さなFFT ----------
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const u = i + k, v = i + k + len / 2, xr = re[v] * cr - im[v] * ci, xi = re[v] * ci + im[v] * cr;
        re[v] = re[u] - xr; im[v] = im[u] - xi; re[u] += xr; im[u] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
function spectrum(x, rate, win, hop, maxWin) { // 平均パワースペクトルと帯域配分
  const N = win, hann = new Float64Array(N); for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  const P = new Float64Array(N / 2); let cnt = 0;
  const step = Math.max(hop, Math.floor((x.length - N) / maxWin));
  for (let o = 0; o + N <= x.length && cnt < maxWin; o += step) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[o + i] * hann[i];
    fft(re, im); for (let k = 0; k < N / 2; k++) P[k] += re[k] * re[k] + im[k] * im[k]; cnt++;
  }
  const bw = rate / N, edges = [20, 150, 500, 2000, 6000, 12000, rate / 2], names = ['sub-low(<150)', 'low(150-500)', 'mid(0.5-2k)', 'hi-mid(2-6k)', 'high(6-12k)', 'air(>12k)'];
  const band = new Array(6).fill(0); let tot = 1e-12, cn = 0, cd = 1e-12;
  for (let k = 1; k < N / 2; k++) { const f = k * bw; tot += P[k]; cn += f * P[k]; cd += P[k]; for (let b = 0; b < 6; b++) if (f >= edges[b] && f < edges[b + 1]) { band[b] += P[k]; break; } }
  const o = {}; names.forEach((n, i) => o[n] = r1(100 * band[i] / tot));
  return { bands_pct: o, centroid_hz: Math.round(cn / cd), P, bw };
}

// ---------- 曲の記号解析 ----------
const KMAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], KMIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const SMAJ = [0, 2, 4, 5, 7, 9, 11], SMIN = [0, 2, 3, 5, 7, 8, 10, 11];
function corr(a, b) { const ma = mean(a), mb = mean(b); let n = 0, da = 0, db_ = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db_ += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db_ + 1e-12); }
function analyzeSong(st) {
  const sg = st.song, W = [], total = totalSteps(st), bars = Math.max(1, Math.ceil(total / 16));
  const tr = []; const pcs = new Array(12).fill(0); const grids = [];
  sg.tracks.forEach((t, i) => {
    const ns = expandedOf(st, t); if (!ns.length) return;
    const perc = ns.filter(n => kindOf(st, n.inst) === 'perc').length * 2 > ns.length;
    const ps = ns.map(n => n.p), vs = ns.map(n => n.v);
    let leaps = 0, reps = 0, over = 0, sil = 0, lastEnd = 0;
    for (let k = 1; k < ns.length; k++) { const d = Math.abs(ns[k].p - ns[k - 1].p); if (d > 7) leaps++; if (d === 0) reps++; if (ns[k - 1].s + ns[k - 1].l > ns[k].s + 0.01) over++; }
    for (const n of ns) { sil = Math.max(sil, n.s - lastEnd); lastEnd = Math.max(lastEnd, n.s + n.l); }
    const grid = new Array(total + 1).fill(-1); let act = 0;
    for (const n of ns) for (let k = Math.floor(n.s); k < n.s + n.l && k <= total; k++) { const ov = Math.min(n.s + n.l, k + 1) - Math.max(n.s, k); if (ov >= 0.5 && grid[k] < 0) { grid[k] = n.p; act++; } }
    if (!perc) for (const n of ns) pcs[((n.p % 12) + 12) % 12] += n.l;
    const off = ns.filter(n => Math.abs(n.s % 4) > 0.01 && Math.abs((n.s % 4) - 4) > 0.01).length;
    const mp = mean(ps);
    tr.push({ i, inst: +t.inst || 0, role: perc ? 'perc' : mp < 48 ? 'bass' : 'mel/harm', perc, notes: ns.length, active_pct: Math.round(100 * act / Math.max(1, total)),
      range: nn(Math.min(...ps)) + '-' + nn(Math.max(...ps)), mean_pitch: r1(mp), vel: [Math.min(...vs), Math.max(...vs), Math.round(mean(vs))],
      leap_pct: Math.round(100 * leaps / Math.max(1, ns.length - 1)), repeat_pct: Math.round(100 * reps / Math.max(1, ns.length - 1)),
      overlaps: over, offbeat_pct: Math.round(100 * off / ns.length), distinct_lengths: new Set(ns.map(n => r2(n.l))).size, longest_gap_bars: r1(sil / 16), _ns: ns });
    grids.push({ i, perc, grid });
  });
  const allN = tr.reduce((s, t) => s + t.notes, 0);
  if (allN > 6000) W.push('展開後ノート数 ' + allN + ' > 6000: 容量超過で曲末が切られる恐れ');
  // 調推定
  let key = null;
  if (pcs.some(x => x > 0)) {
    const c = [];
    for (let r = 0; r < 12; r++) {
      const rot = pcs.map((_, k) => pcs[(k + r) % 12]);
      c.push({ k: NN[r] + ' major', r: corr(rot, KMAJ), tonic: r, sc: SMAJ }, { k: NN[r] + ' minor', r: corr(rot, KMIN), tonic: r, sc: SMIN });
    }
    c.sort((a, b) => b.r - a.r);
    const b = c[0], tot = pcs.reduce((a, x) => a + x, 0), outside = pcs.reduce((s, x, pc) => s + (b.sc.includes(((pc - b.tonic) % 12 + 12) % 12) ? 0 : x), 0);
    key = { est: b.k, fit: r2(b.r), top3: c.slice(0, 3).map(x => x.k + '(' + r2(x.r) + ')'), outside_pct: r1(100 * outside / tot), declared: (sg.plan && sg.plan.key) || null };
    if (key.outside_pct > 14) W.push('推定調 ' + b.k + ' に対し調外音が ' + key.outside_pct + '% (意図的な転調/借用でなければ要確認)');
  }
  // トラック間の不協和・低域密集
  let multi = 0, clash = 0, trit = 0, lowc = 0;
  const harm = grids.filter(g => !g.perc);
  for (let k = 0; k <= total; k++) {
    const ps = harm.map(g => g.grid[k]).filter(p => p >= 0); if (ps.length < 2) continue; multi++;
    let c1 = false, c6 = false, lc = false;
    for (let a = 0; a < ps.length; a++) for (let b = a + 1; b < ps.length; b++) { const d = Math.abs(ps[a] - ps[b]), m = d % 12; if (d < 24 && (m === 1 || m === 11)) c1 = true; if (m === 6 && d < 12) c6 = true; if (ps[a] < 48 && ps[b] < 48 && d > 0 && d < 5) lc = true; }
    if (c1) clash++; if (c6) trit++; if (lc) lowc++;
  }
  const clashPct = multi ? r1(100 * clash / multi) : 0;
  if (clashPct > 8) W.push('同時発音の短2度/長7度の衝突が ' + clashPct + '% (和声の確認を)');
  if (multi && lowc / multi > 0.1) W.push('低域(C3未満)で近接音が重なり濁る箇所あり ' + lowc + ' ステップ');
  // 小節ごとの密度/強弱/稼働トラック
  const dens = new Array(bars).fill(0), vsum = new Array(bars).fill(0), actv = [];
  tr.forEach(t => t._ns.forEach(n => { const b = Math.min(bars - 1, Math.floor(n.s / 16)); dens[b]++; vsum[b] += n.v; }));
  const vb = dens.map((d, b) => d ? Math.round(vsum[b] / d) : 0);
  for (let b = 0; b < bars; b++) actv.push(tr.filter(t => t._ns.some(n => Math.floor(n.s / 16) === b)).length);
  const emptyBars = dens.map((d, b) => d ? -1 : b + 1).filter(x => x > 0);
  if (emptyBars.length) W.push('無音の小節: ' + emptyBars.slice(0, 12).join(','));
  if (bars > 8 && sd(dens) / (mean(dens) + 1e-9) < 0.15) W.push('密度の起伏がほぼ無い(展開/山場が弱い)');
  const allV = tr.flatMap(t => t._ns.map(n => n.v)); if (allV.length && sd(allV) < 7) W.push('ベロシティの幅が小さく強弱が平坦');
  // メロディ(非打楽器で最も音数が多い高音域トラック)の反復・跳躍
  const cand = tr.filter(t => !t.perc && t.role !== 'bass'); cand.sort((a, b) => b.mean_pitch - a.mean_pitch);
  const mel = cand.find(t => t.notes >= 8) || cand[0]; let rep = null, loopInfo = null;
  if (mel) {
    const sig = [], ctr = [];
    for (let b = 0; b < bars; b++) {
      const bn = mel._ns.filter(n => n.s >= b * 16 && n.s < (b + 1) * 16); if (!bn.length) { sig.push(''); ctr.push(''); continue; }
      sig.push(bn.map(n => r1(n.s - b * 16) + ':' + n.p).join(' '));
      ctr.push(bn.map((n, k) => r1(n.s - b * 16) + ':' + (k ? n.p - bn[k - 1].p : 0)).join(' '));
    }
    const ne = sig.filter(s => s), cn = ctr.filter(s => s);
    rep = { track: mel.i, bars_with_notes: ne.length, unique_bars: new Set(ne).size, unique_contours: new Set(cn).size, exact_repeat_pct: ne.length ? Math.round(100 * (1 - new Set(ne).size / ne.length)) : 0 };
    if (ne.length >= 8 && rep.exact_repeat_pct > 75) W.push('メロディの小節が ' + rep.exact_repeat_pct + '% 完全反復: 変奏/展開を');
    if (ne.length >= 8 && rep.exact_repeat_pct < 5 && rep.unique_contours > ne.length * 0.9) W.push('メロディに反復(主題の再現)が無く散漫になりうる');
    if (mel.leap_pct > 35) W.push('メロディ(track ' + mel.i + ')の跳躍(>5度)が ' + mel.leap_pct + '%: 歌いにくい');
    if (mel.repeat_pct > 40) W.push('メロディの同音連打が ' + mel.repeat_pct + '%');
    const ls = Math.round((+sg.loop_start || 0)), first = mel._ns.find(n => n.s >= ls), last = mel._ns[mel._ns.length - 1];
    if (first && last) {
      const iv = Math.abs(first.p - last.p); loopInfo = { end_note: nn(last.p), loop_start_note: nn(first.p), interval_semis: iv, end_gap_steps: r1(total - (last.s + last.l)) };
      if (iv > 9) W.push('ループの継ぎ目でメロディが ' + iv + ' 半音跳ぶ');
    }
  }
  tr.forEach(t => { if (t.overlaps) W.push('track ' + t.i + ' に重なり ' + t.overlaps + ' 件(単音のみ可)'); if (!t.perc && t.mean_pitch >= 48 && t.range && Math.max(...t._ns.map(n => n.p)) - Math.min(...t._ns.map(n => n.p)) > 30) W.push('track ' + t.i + ' の音域が広すぎる'); });
  if (!tr.some(t => t.role === 'bass')) W.push('低音パート(bass)が無い');
  if (!tr.some(t => t.perc)) W.push('打楽器パートが無い(意図的ならOK)');
  tr.forEach(t => delete t._ns);
  return { overview: { title: sg.title, bpm: sg.bpm, bars, seconds: r1(total / 4 * 60 / sg.bpm), loop_start_bar: r1((+sg.loop_start || 0) / 16 + 1), notes: allN, tracks: tr.length, instruments: sg.instruments.length },
    tracks: tr, harmony: { key, clash_pct: clashPct, tritone_pct: multi ? r1(100 * trit / multi) : 0, simultaneous_steps: multi },
    structure: { notes_per_bar: dens, avg_vel_per_bar: vb, active_tracks_per_bar: actv, melody_repetition: rep }, loop: loopInfo, warnings: W };
}

// ---------- 実音レンダリングと音響解析 ----------
async function renderAudio(st, ctx, args) {
  if (!LIB.SPCEngine) throw new Error('SPCEngine が利用できません(libspc.js を先に読み込んでください)');
  const res = await build(st, ctx), F = 32000;
  const from = clamp(+args.from_sec || 0, 0, 600), dur = clamp(+args.seconds || (res.seconds + 1.5), 2, 120);
  const eng = new LIB.SPCEngine(); eng.loadSPC(LIB.parseSPC(res.spc));
  const skip = Math.floor(from * F), N = Math.floor(dur * F), L = new Float32Array(N), R = new Float32Array(N);
  const vq = new Float64Array(8); let bad = 0;
  for (let i = 0; i < skip; i++) eng.renderSample();
  for (let i = 0; i < N; i++) {
    const [l, r] = eng.renderSample(); L[i] = l; R[i] = r; if (!isFinite(l) || !isFinite(r)) bad++;
    const vs = eng.dsp.voices; for (let v = 0; v < 8; v++) { const o = vs[v].outSample || 0, rg = eng.dsp.regs; const g = (Math.abs((rg[v * 16] << 24) >> 24) + Math.abs((rg[v * 16 + 1] << 24) >> 24)) || 1; vq[v] += o * o * g * g; }
    if ((i & 0xFFFF) === 0xFFFF) await yieldUI();
  }
  if (bad) throw new Error('音声に NaN/Inf が含まれます(フィルタ設定の破綻など)');
  let pk = 0, ss = 0, clip = 0, dc = 0, sm = 0, sd2 = 0, lr = 0, ll = 0, rr = 0; const mid = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const l = L[i], r = R[i], a = Math.max(Math.abs(l), Math.abs(r)); pk = Math.max(pk, a); if (a > 0.97) clip++;
    ss += (l * l + r * r) / 2; dc += (l + r) / 2; mid[i] = (l + r) / 2; sm += mid[i] * mid[i]; const sdv = (l - r) / 2; sd2 += sdv * sdv; lr += l * r; ll += l * l; rr += r * r;
  }
  const rms = Math.sqrt(ss / N), blk = Math.ceil(dur / 24), curve = [];
  for (let b = 0; b * blk * F < N; b++) { let s = 0, c = 0; for (let i = b * blk * F; i < Math.min(N, (b + 1) * blk * F); i++) { s += mid[i] * mid[i]; c++; } curve.push(db(Math.sqrt(s / c))); }
  let quiet = 0, nb = 0; for (let o = 0; o + 3200 <= N; o += 3200) { let s = 0; for (let i = o; i < o + 3200; i++) s += mid[i] * mid[i]; nb++; if (Math.sqrt(s / 3200) < 0.001) quiet++; }
  const sp = spectrum(mid, F, 2048, 4096, 60);
  const vsum = vq.reduce((a, b) => a + b, 0) || 1, per = [];
  res.voiceTrack.forEach((ti, v) => per.push({ track: ti, share_pct: r1(100 * vq[v] / vsum) }));
  const seg = (a, b) => { a = Math.max(0, Math.floor(a * F)); b = Math.min(N, Math.floor(b * F)); let s = 0; for (let i = a; i < b; i++) s += mid[i] * mid[i]; return b > a ? Math.sqrt(s / (b - a)) : 0; };
  let seam = null; const endT = res.seconds - from, lsT = (+st.song.loop_start || 0) / 4 * 60 / st.song.bpm - from;
  if (from === 0 && N / F > endT + 0.3) { const before = db(seg(endT - 0.4, endT)), after = db(seg(endT, endT + 0.4)), head = db(seg(lsT, lsT + 0.4)); seam = { level_before_db: before, level_after_db: after, level_at_loop_start_db: head, jump_db: r1(Math.abs(before - after)) }; }
  const W = [];
  if (clip / N > 0.002) W.push('クリップ/リミッタ飽和 ' + r2(100 * clip / N) + '% (音量過多: velocity/トラック数を下げる)');
  if (db(rms) < -26) W.push('全体が小さい(RMS ' + db(rms) + 'dB): vel を上げるか音源の gain を上げる');
  if (db(pk) < -6) W.push('ピークが低い');
  if (sp.bands_pct['air(>12k)'] + sp.bands_pct['high(6-12k)'] > 18) W.push('高域(6k+)が ' + r1(sp.bands_pct['air(>12k)'] + sp.bands_pct['high(6-12k)']) + '% でジャリつく可能性: cutoffを下げる/res を下げる');
  if (sp.bands_pct['sub-low(<150)'] > 55) W.push('低域過多でこもる');
  if (sp.bands_pct['hi-mid(2-6k)'] + sp.bands_pct['mid(0.5-2k)'] < 20) W.push('中域が薄く抜けが悪い');
  if (nb && quiet / nb > 0.25) W.push('ほぼ無音の区間が ' + Math.round(100 * quiet / nb) + '%');
  if (seam && seam.jump_db > 10) W.push('ループ継ぎ目で音量が ' + seam.jump_db + 'dB 変化');
  if (res.truncated) W.push('曲データが容量超過で曲末を切って収めた(ノート数/長さを減らすか patterns を活用)');
  if (res.defaultInsts.length) W.push('音色レシピ未設計の instrument: ' + res.defaultInsts.join(',') + ' (design_sound で設計を)');
  const dom = per.slice().sort((a, b) => b.share_pct - a.share_pct)[0];
  if (dom && per.length > 3 && dom.share_pct > 45) W.push('track ' + dom.track + ' が音量の ' + dom.share_pct + '% を占め他が埋もれる');
  per.filter(p => p.share_pct < 1.5).forEach(p => W.push('track ' + p.track + ' はほぼ聴こえない(' + p.share_pct + '%)'));
  const out = { rendered_sec: r1(dur), from_sec: from, song_sec: r1(res.seconds), spc_bytes: res.spc.length, sample_bytes: res.sampleBytes + '/' + res.sampleCap,
    peak_db: db(pk), rms_db: db(rms), crest_db: r1(db(pk) - db(rms)), clip_pct: r2(100 * clip / N), dc: r3(dc / N), loudness_curve_db: { block_sec: blk, values: curve },
    spectrum: { ...sp.bands_pct, centroid_hz: sp.centroid_hz }, stereo: { correlation: r2(lr / Math.sqrt(ll * rr + 1e-12)), side_to_mid_db: db(Math.sqrt(sd2 / (sm + 1e-12))) }, per_voice: per, loop_seam: seam, warnings: W };
  ctx.audio = { rev: st.rev, L, R, summary: out };
  return out;
}

// ---------- 音色解析 ----------
function analyzeSound(st, id) {
  const sp = st.sounds[id]; if (!sp) throw new Error('instrument ' + id + ' の recipe が未設計(design_sound)');
  const used = []; st.song.tracks.forEach(t => expandedOf(st, t).forEach(n => { if (n.inst === id) used.push(n.p); }));
  used.sort((a, b) => a - b); const hi = used.length ? used[Math.floor(used.length * 0.8)] : 60;
  const r = S.item({ ...sp, _r: Math.max(1, Math.pow(2, (hi - 60) / 12)) }, 1), pcm = r.pcm, F = 32000, n = pcm.length;
  const brr = S.brrEncode(pcm, r.loop, r.loopStart / 16).length;
  let pk = 0, ss = 0; for (const v of pcm) { pk = Math.max(pk, Math.abs(v)); ss += v * v; } const rms = Math.sqrt(ss / n) / 32768;
  const W = [], o = { id, type: sp.type, loop: r.loop, samples: n, ms: Math.round(1000 * n / F), brr_bytes: brr, peak: r2(pk / 32768), rms_db: db(rms), used_range: used.length ? nn(used[0]) + '-' + nn(used[used.length - 1]) : '未使用', pitch_80pct: nn(hi) };
  const a = r.loop ? r.loopStart : 0, seg = Array.from(pcm.slice(a, a + 4096), x => x / 32768); while (seg.length < 2048) seg.push(0);
  const sp2 = spectrum(Float64Array.from(seg.slice(0, 2048 * Math.floor(seg.length / 2048))), F, 2048, 2048, 2);
  o.centroid_hz = sp2.centroid_hz; o.bands_pct = sp2.bands_pct;
  let top = 0, tk = 1; for (let k = 2; k < sp2.P.length / 2; k++) if (sp2.P[k] > top) { top = sp2.P[k]; tk = k; } o.strongest_hz = Math.round(tk * sp2.bw);
  if (r.loop) {
    const L = n - r.loopStart, last = pcm[n - 1], first = pcm[r.loopStart], slope = Math.abs(pcm[n - 1] - pcm[n - 2]);
    o.loop_len = L; o.loop_seam_jump = r2(Math.abs(last - first) / Math.max(1, pk)); // 継ぎ目の段差(波形ピーク比)
    if (o.loop_seam_jump > 0.25 + slope / Math.max(1, pk)) W.push('ループ継ぎ目に段差(プチノイズの原因): ' + o.loop_seam_jump);
    o.loop_cycles_note = 'ループ長 ' + L + ' は C4 周期(' + r2(F / 261.6256) + ')の整数倍に丸め済み';
  } else {
    let t40 = n; for (let i = n - 1; i >= 0; i--) if (Math.abs(pcm[i]) / pk > 0.01) { t40 = i; break; } o.decay_to_40db_ms = Math.round(1000 * t40 / F);
    if (r.loop === false && Math.abs(pcm[n - 1]) / pk > 0.05) W.push('末尾が非ゼロで切れている(プチノイズ)');
  }
  if (brr > 9000) W.push('サイズが大きい(' + brr + 'B): 全体のサンプル領域を圧迫');
  if (rms < 0.03) W.push('音が小さい(rms ' + db(rms) + 'dB): level/gain を上げる');
  if (sp2.bands_pct['high(6-12k)'] + sp2.bands_pct['air(>12k)'] > 25) W.push('高域成分が多くジャリつきやすい');
  if (o.centroid_hz > 6000 && sp.type !== 'perc') W.push('明るすぎ(centroid ' + o.centroid_hz + 'Hz)');
  if (o.centroid_hz < 300 && sp.type !== 'perc' && hi >= 55) W.push('暗すぎる/こもる(centroid ' + o.centroid_hz + 'Hz)');
  o.warnings = W; return o;
}

// ---------- 譜面の可視化 ----------
function pianoRoll(st, a) {
  const tracks = a.track == null || a.track === 'all' ? st.song.tracks.map((_, i) => i) : [Math.round(+a.track)];
  const maxB = tracks.length > 1 ? 4 : 8, nb = clamp(Math.round(+a.bars || 2), 1, maxB), b0 = Math.max(1, Math.round(+a.from_bar || 1)), lines = [];
  const data = tracks.map(i => { const t = st.song.tracks[i]; return t ? { i, t, ns: expandedOf(st, t) } : null; }).filter(Boolean);
  for (let b = b0; b < b0 + nb; b++) {
    lines.push('== bar ' + b + ' (step ' + (b - 1) * 16 + '-' + (b * 16 - 1) + ') =='); lines.push('      ' + Array.from({ length: 16 }, (_, k) => String(k + 1).padEnd(3)).join(''));
    for (const d of data) {
      const cells = new Array(16).fill(' . '); let vs = [];
      for (const n of d.ns) {
        const s = Math.round(n.s) - (b - 1) * 16, e = Math.round(n.s + n.l) - (b - 1) * 16;
        if (e <= 0 || s >= 16) continue; vs.push(n.v);
        for (let k = Math.max(0, s); k < Math.min(16, Math.max(e, s + 1)); k++) cells[k] = k === s ? nn(n.p).padEnd(3) : ' ~ ';
      }
      lines.push(('T' + d.i + '@' + (+d.t.inst || 0)).padEnd(6) + cells.join('') + (vs.length ? ' v' + Math.round(mean(vs)) : ''));
    }
  }
  lines.push('(表示は16分に丸め / ~は持続 / .は休符 / v=平均ベロシティ / @=instrument)');
  return lines.join('\n');
}

// ---------- ツール定義 ----------
const TOOLS = {
  set_meta: { sig: '{title?, bpm?(40-220), loop_start?(16分単位), plan?:{concept,key,form,chords,motif}}', desc: '曲の基本情報と設計(plan)を設定/更新(部分更新可)。最初に必ず plan を書く',
    run(st, a, c) { const s = st.song; if (a.title) s.title = String(a.title).replace(/[^\w\- ]/g, '').trim().slice(0, 32) || s.title; if (a.bpm != null) s.bpm = clamp(Math.round(+a.bpm) || 120, 40, 220); if (a.loop_start != null) s.loop_start = Math.max(0, +a.loop_start || 0); if (a.plan && typeof a.plan === 'object') s.plan = { ...s.plan, ...a.plan }; c.touch(); return { title: s.title, bpm: s.bpm, loop_start: s.loop_start, plan: s.plan }; } },
  define_instrument: { sig: '{id(整数), name, kind:"tone"|"perc", desc(英語で具体的に)}', desc: '楽器を定義/更新(最大16種)。音は design_sound で別途設計する',
    run(st, a, c) { const id = Math.round(+a.id); if (!(id >= 0 && id < 128)) throw new Error('id は 0〜127'); const L = st.song.instruments, i = L.findIndex(x => x.id === id);
      if (i < 0 && L.length >= 16) throw new Error('instrument は最大16種'); const v = { id, name: String(a.name || 'inst' + id).slice(0, 24), kind: a.kind === 'perc' ? 'perc' : 'tone', desc: String(a.desc || '').slice(0, 300) }; if (i < 0) L.push(v); else L[i] = v; c.touch(); return { instruments: L.map(x => x.id + ':' + x.name + '/' + x.kind) }; } },
  design_sound: { sig: '{id, recipe:{type:"sub|string|modal|tone|perc", ...}}', desc: '楽器 id の音色を数式レシピ(減算合成/物理モデル等)で設計。形式は後述の【音色レシピ仕様】。登録時に試しレンダリングして容量を返す',
    run(st, a, c) { const id = Math.round(+a.id), rc = a.recipe; if (!rc || !['sub', 'string', 'modal', 'tone', 'perc'].includes(rc.type)) throw new Error('recipe.type が不正');
      let r; try { r = S.item({ ...rc, _r: 1 }, 1); } catch (e) { throw new Error('レシピ不正: ' + e.message); }
      if (!st.song.instruments.some(x => x.id === id)) st.song.instruments.push({ id, name: 'inst' + id, kind: rc.type === 'perc' || rc.type === 'modal' ? 'perc' : 'tone', desc: '' });
      st.sounds[id] = rc; c.touch(); const b = S.brrEncode(r.pcm, r.loop, r.loopStart / 16).length; return { id, type: rc.type, loop: r.loop, brr_bytes: b, hint: b > 9000 ? '大きい。dur を短く' : 'analyze_sound で確認可' }; } },
  write_pattern: { sig: '{name, notes:[[start,len,midi,vel],...]}', desc: '繰り返し用パターン(start はパターン内相対・16分単位)。track の seq から [name,at,transpose,velDelta] で参照',
    run(st, a, c) { if (!a.name) throw new Error('name が必要'); const { out, bad } = cleanNotes(a.notes); st.song.patterns[String(a.name)] = out; c.touch(); return { name: a.name, notes: out.length, dropped: bad }; } },
  write_track: { sig: '{track(0-7), inst?, pan?, notes?:[[start,len,midi,vel,(inst),(pan)]], seq?:[[patName,at,transpose,velDelta]], mode?:"replace"|"append"|"replace_range", from?, to?}',
    desc: 'トラック(単音・16分単位)にノート/パターン参照を書く。replace=全置換(省略時) / append=末尾追加 / replace_range=[from,to)の範囲だけ置換。1回は150ノート前後までに分けて書く。重なりは自動で切り詰める',
    run(st, a, c) { const t = trk(st, a.track), mode = a.mode || 'replace'; if (a.inst != null) t.inst = Math.round(+a.inst); if (a.pan != null) t.pan = clamp(Math.round(+a.pan), 0, 127);
      const cl = cleanNotes(a.notes), seq = (Array.isArray(a.seq) ? a.seq : []).filter(q => Array.isArray(q) && st.song.patterns[q[0]]).map(q => [q[0], +q[1] || 0, +q[2] || 0, +q[3] || 0]);
      const miss = (Array.isArray(a.seq) ? a.seq : []).filter(q => !(Array.isArray(q) && st.song.patterns[q[0]])).map(q => q && q[0]);
      const f = +a.from || 0, to = a.to == null ? 1e9 : +a.to, inR = x => x >= f && x < to;
      if (mode === 'replace') { if (a.notes !== undefined) t.notes = cl.out; if (a.seq !== undefined) t.seq = seq; }
      else if (mode === 'append') { t.notes = t.notes.concat(cl.out); t.seq = (t.seq || []).concat(seq); }
      else if (mode === 'replace_range') { t.notes = t.notes.filter(n => !inR(n[0])).concat(cl.out); t.seq = (t.seq || []).filter(q => !inR(q[1])).concat(seq); }
      else throw new Error('mode が不正');
      const fixed = monoFix(t.notes); c.touch(); const ex = expandedOf(st, t);
      return { track: +a.track, inst: t.inst, stored_notes: t.notes.length, expanded_notes: ex.length, seq_refs: (t.seq || []).length, end_step: ex.length ? r1(Math.max(...ex.map(n => n.s + n.l))) : 0, auto_trimmed_overlaps: fixed, dropped_invalid: cl.bad, pitch_clamped: cl.clamped, unknown_patterns: miss.length ? miss : undefined }; } },
  edit_notes: { sig: '{track, op:"transpose"|"velocity"|"shift"|"delete"|"clear", amount?, from?, to?}', desc: 'トラックの直接ノートに範囲編集([from,to)の16分単位)。transpose=半音 / velocity=加算 / shift=時間ずらし / delete=範囲削除 / clear=全消去(seq含む)。patterns参照(seq)は対象外',
    run(st, a, c) { const t = trk(st, a.track), f = +a.from || 0, to = a.to == null ? 1e9 : +a.to, am = +a.amount || 0; let n = 0;
      if (a.op === 'clear') { n = t.notes.length; t.notes = []; t.seq = []; }
      else if (a.op === 'delete') { const b = t.notes.length; t.notes = t.notes.filter(x => !(x[0] >= f && x[0] < to)); n = b - t.notes.length; }
      else if (['transpose', 'velocity', 'shift'].includes(a.op)) { for (const x of t.notes) if (x[0] >= f && x[0] < to) { if (a.op === 'transpose') x[2] = clamp(x[2] + am, 12, 83); else if (a.op === 'velocity') x[3] = clamp(Math.round(x[3] + am), 1, 127); else x[0] = Math.max(0, r3(x[0] + am)); n++; } monoFix(t.notes); }
      else throw new Error('op が不正'); c.touch(); return { track: +a.track, affected: n, notes_left: t.notes.length }; } },
  inspect: { sig: '{what:"meta"|"instruments"|"sounds"|"patterns"|"track", track?}', desc: '現在の曲データの生内容を見る(引き継ぎ直後の確認用)。track は先頭400ノートまで',
    run(st, a) { const s = st.song; switch (a.what) { case 'meta': return { title: s.title, bpm: s.bpm, loop_start: s.loop_start, plan: s.plan, tracks: s.tracks.map((t, i) => ({ i, inst: t.inst, pan: t.pan, notes: t.notes.length, seq: (t.seq || []).length })) };
      case 'instruments': return s.instruments.map(i => ({ ...i, has_recipe: !!st.sounds[i.id] })); case 'sounds': return st.sounds; case 'patterns': return Object.fromEntries(Object.entries(s.patterns).map(([k, v]) => [k, v.slice(0, 80)]));
      case 'track': { const t = trk(st, a.track); return { inst: t.inst, pan: t.pan, notes: t.notes.slice(0, 400), seq: t.seq, truncated: t.notes.length > 400 }; } default: throw new Error('what が不正'); } } },
  piano_roll: { sig: '{track?:0-7|"all", from_bar?(1始まり), bars?(単独8/全体4まで)}', desc: 'ASCII譜面で実際のノートを見る(耳の代わりに内容確認する)', run: (st, a) => pianoRoll(st, a) },
  analyze_song: { sig: '{}', desc: '記号解析: 音域・跳躍・重なり・調推定と調外音・不協和・密度/強弱の推移・主題の反復・ループ継ぎ目・警告一覧', run: st => analyzeSong(st) },
  render_audio: { sig: '{seconds?, from_sec?}', desc: '実際にSPCへコンパイルし、エミュレータで鳴らして音響を解析(音量/クリップ/帯域バランス/声部別の聴こえ方/ループ継ぎ目/容量)。評価の前に必須', run: (st, a, c) => renderAudio(st, c, a || {}) },
  analyze_sound: { sig: '{id}', desc: '音色レシピ単体を解析(サイズ・倍音バランス・ループ継ぎ目の段差・減衰時間・明暗)', run: (st, a) => analyzeSound(st, Math.round(+a.id)) },
  evaluate: { sig: '{scores:{melody,harmony,rhythm,structure,timbre,mix,loop,fit (各1-10)}, evidence:[根拠の文字列(数値/小節番号を引用)], problems:[], next:[]}', desc: '自己評価を記録(現リビジョンで render_audio 済みが必須)。厳しく採点し、最低の軸を次の作業に当てる。fit=依頼との一致',
    run(st, a, c) { if (!c.audioFresh()) throw new Error('評価の前に現在の曲で render_audio を実行してください'); const K = ['melody', 'harmony', 'rhythm', 'structure', 'timbre', 'mix', 'loop', 'fit'], sc = a.scores || {};
      for (const k of K) if (!(+sc[k] >= 1 && +sc[k] <= 10)) throw new Error('scores.' + k + ' は1〜10'); if (!Array.isArray(a.evidence) || a.evidence.length < 2) throw new Error('evidence に根拠を2つ以上(数値や小節番号を引用)');
      const overall = r1(mean(K.map(k => +sc[k]))), prev = st.evals[st.evals.length - 1], best = st.evals.reduce((m, e) => Math.max(m, e.overall), 0);
      const e = { rev: st.rev, turn: st.turn, model: c.model, overall, scores: Object.fromEntries(K.map(k => [k, +sc[k]])), evidence: a.evidence.slice(0, 6), problems: (a.problems || []).slice(0, 8), next: (a.next || []).slice(0, 6), audio: c.audioBrief() };
      st.evals.push(e); let saved = false; if (overall >= best) { st.snapshots.best = { song: JSON.parse(JSON.stringify(st.song)), sounds: JSON.parse(JSON.stringify(st.sounds)), overall, rev: st.rev }; saved = true; }
      const low = K.slice().sort((x, y) => sc[x] - sc[y]).slice(0, 2); const w = c.lastAnalysisWarnings(); const out = { overall, delta_vs_prev: prev ? r1(overall - prev.overall) : null, best: Math.max(best, overall), snapshot_best_saved: saved, weakest_axes: low, hint: '次は ' + low.join('/') + ' を改善。悪化したら snapshot restore best' };
      if (overall >= 9 && w > 2) out.caution = '自己採点が高い割に analyze_song の警告が ' + w + ' 件残っています。採点を見直してください'; return out; } },
  snapshot: { sig: '{action:"save"|"restore"|"list"|"delete", name}', desc: '曲+音色の保存点。best は evaluate が自動保存。大きな改変前に save、悪化したら restore',
    run(st, a, c) { const S_ = st.snapshots; if (a.action === 'list') return Object.entries(S_).map(([k, v]) => ({ name: k, overall: v.overall, rev: v.rev }));
      const nm = String(a.name || '').slice(0, 24); if (!nm) throw new Error('name が必要');
      if (a.action === 'save') { if (Object.keys(S_).length >= 8 && !S_[nm]) { const old = Object.keys(S_).find(k => k !== 'best'); delete S_[old]; } S_[nm] = { song: JSON.parse(JSON.stringify(st.song)), sounds: JSON.parse(JSON.stringify(st.sounds)), rev: st.rev, overall: null }; return { saved: nm }; }
      if (a.action === 'restore') { if (!S_[nm]) throw new Error('そのsnapshotはありません'); st.song = JSON.parse(JSON.stringify(S_[nm].song)); st.sounds = JSON.parse(JSON.stringify(S_[nm].sounds)); c.touch(); return { restored: nm, hint: 'render_audio し直してください' }; }
      if (a.action === 'delete') { delete S_[nm]; return { deleted: nm }; } throw new Error('action が不正'); } },
  memo: { sig: '{add?:[文字列], todo?:[文字列(全置換)]}', desc: '作業メモとTODOを永続化。AIが交代しても必ず引き継がれる唯一の「記憶」。決定事項・方針・未解決点は必ずここへ',
    run(st, a) { if (Array.isArray(a.add)) for (const s of a.add) { const v = String(s).slice(0, 300); if (!st.notes.includes(v)) st.notes.push(v); } st.notes = st.notes.slice(-30); if (Array.isArray(a.todo)) st.todo = a.todo.map(s => String(s).slice(0, 200)).slice(0, 12); return { notes: st.notes.length, todo: st.todo }; } },
  ask_critic: { sig: '{focus?}', desc: '別視点の批評家AIに曲の解析結果と譜面の抜粋を見せて講評を得る(1〜2回まで推奨)。結果は参考意見として自分で判断する',
    async run(st, a, c) { if (!c.callText) throw new Error('批評家AIは利用できません'); const an = analyzeSong(st), roll = pianoRoll(st, { track: 'all', from_bar: 1, bars: 4 }), mid = Math.max(1, Math.floor(an.overview.bars / 2)), roll2 = pianoRoll(st, { track: 'all', from_bar: mid, bars: 2 });
      const txt = await c.callText('あなたは辛口で具体的な音楽批評家です(SNES/チップチューンの作編曲に詳しい)。与えられた解析データと譜面から、最も改善効果が大きい点を優先順に最大5つ、小節番号やトラック番号を挙げて具体的な修正案つきで日本語で述べてください。JSONのみ: {"verdict":"一言","issues":[{"where":"","problem":"","fix":""}]}',
        JSON.stringify({ request: st.goal, plan: st.song.plan, focus: a && a.focus, analysis: an, audio: c.audioBrief(), roll_start: roll, roll_middle: roll2 })); return txt; } },
  finish: { sig: '{summary}', desc: '完成を宣言して終了。現リビジョンが render_audio と evaluate 済みで、総合スコアが十分(既定7以上)なときだけ受理される',
    run(st, a, c) { const e = st.evals[st.evals.length - 1]; if (!c.audioFresh()) throw new Error('最終版で render_audio が未実施です'); if (!e || e.rev !== st.rev) throw new Error('最終版で evaluate が未実施です');
      st.finishRejects = st.finishRejects || 0; if (e.overall < c.minScore && c.turnsLeft > 4 && st.finishRejects < 3) { st.finishRejects++; throw new Error('総合 ' + e.overall + ' < ' + c.minScore + '。最も低い軸を改善してから再評価してください(あと' + (3 - st.finishRejects) + '回まで拒否)'); }
      st.status = 'done'; st.summary = String(a.summary || '').slice(0, 600); return { done: true, overall: e.overall }; } }
};

function describeTools() { return Object.entries(TOOLS).map(([k, t]) => '- ' + k + ' ' + t.sig + '\n    ' + t.desc).join('\n'); }
const API = { TOOLS, describeTools, build, analyzeSong, renderAudio, analyzeSound, pianoRoll, ensure, totalSteps };
if (isNode) module.exports = API; else root.AGENTTOOLS = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
