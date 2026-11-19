/* agent.js : 自己評価しながら作曲する SPC 作曲エージェント (spcgen.js / agenttools.js / libspc.js 必須)
 *
 * 【AIを途中で交代できる仕組み】
 *  - 会話履歴をAI側に持たせない。曲・音色・評価・メモ・TODO・行動ログは全て JSON の「セッション状態」に保存。
 *  - 毎ターン、状態から「現在の状態」プロンプトを作り直して送る(ステートレス)。だから どのAI/どのモデルでも続きから動ける。
 *  - トークン切れ/レート制限/課金切れ/障害/コンテキスト超過/認証エラーは分類し、次のAIへ自動切替。
 *    全AIが使えない時は pause し、状態は保存済み。キーを足して resume() すればそのまま続行。 */
(function (root) {
'use strict';
const isNode = typeof module === 'object' && module.exports;
const S = isNode ? require('./spcgen.js') : root.SPCGEN;
const T = isNode ? require('./agenttools.js') : root.AGENTTOOLS;
const sleep = ms => new Promise(r => setTimeout(r, ms));
class AgentPause extends Error { }
class AgentAbort extends Error { }

const SYSTEM = () => `あなたは「SNES(SPC700)作曲エージェント」です。作曲 → 実際に鳴らして測る → 自己評価 → 修正 を自分で繰り返し、ツールだけを使って曲を完成させます。

【動作プロトコル】
- 毎ターン、JSONオブジェクト1つだけを出力: {"thought":"今の判断(100字以内)","calls":[{"tool":"ツール名","args":{...}}]}  (Markdownや前置きは書かない)
- calls は1ターン最大6個。上から順に実行され、結果は次ターンの「直前ターンのツール結果」に載る。
- 会話履歴は渡されない。毎ターン最新の「現在の状態」だけが渡される。別のAIが途中から引き継ぐこともある。方針・決定事項・未解決点は必ず memo に書く(あなたの頭の中は引き継がれない)。
- 1回の出力が長いと途中で切れて失敗する。write_track は1回あたり150ノート前後まで。長い曲はセクション/小節範囲ごとに mode:"append" か "replace_range" で分けて書く。繰り返しは write_pattern + seq を使う。notes は空白/改行なしのコンパクトJSONで。

【ハードウェア制約】
- track は 0〜7 の最大8本(=8ボイス)。各trackは単音(和音・重なり禁止)。和音はアルペジオか複数trackで。
- 時間は16分音符単位(1小節=16。小数可)。midi は12〜83、vel は1〜127、pan は0〜127(64=中央)。bpm は曲全体で固定(途中変更不可)。
- instrument は最大16種。展開後の全ノート数は合計およそ6000個以内。曲データ+全サンプルは約60KBに収める(超えると曲末が切られる)。
- 曲はループ再生される。曲の最後は loop_start(16分単位)へ自然に繋がること。
- ノートは [start,len,midi,vel] または [start,len,midi,vel,instId,pan]。音色は track.inst(既定)かノート5番目で切替。
- 曲の長さ・構成・コード進行・音色の選び方は自由。型にはまった定番に寄せず、plan.concept に沿って独自に設計する。始まり・展開・山場・結びがあり、主題の再現や変奏があること。

【進め方(目安)】
1) set_meta で plan(concept/key/form/chords/motif)とbpmを決め、memo に方針を書く。
2) define_instrument → design_sound で全楽器の音色を設計。極端そうな音色は analyze_sound で点検。
3) 骨格(bass・drums)→和声(arp/pad)→主旋律の順などで、セクションごとに write_track。piano_roll で書いた内容を確認する。
4) analyze_song の警告を潰す。
5) render_audio で実際に鳴らして音量・帯域・声部のバランス・ループ継ぎ目を確認 → evaluate で自己採点。
6) 最も低い軸から直す。大きな改変前は snapshot save、悪化したら snapshot restore。変更のたび render_audio → evaluate をやり直す。
7) 仕上げ前に ask_critic を1〜2回使い、妥当な指摘を取り込む。
8) 総合7以上で致命的な警告が無ければ、最終 render_audio → evaluate → finish。残りターンが少ない時は必ず収束させる。

【評価の姿勢】
- あなたは音を直接聴けない。根拠は analyze_song / render_audio / piano_roll / analyze_sound の数値と譜面。evidence には必ず数値・小節番号・トラック番号を引用する。
- 甘く採点しない。警告が残る軸を8以上にしない。変更して良くならなかったら元に戻す。依頼(goal)に合っているか(fit)を常に確認する。
- 同じ解析ばかり繰り返さず、解析したら必ず修正か次の工程へ進む。

【ツール一覧】
${T.describeTools()}

【音色レシピ仕様】(design_sound の recipe にそのまま使う。下の「JSONのみを返す/出力形式」は無視し、上の動作プロトコルに従うこと)
${S.SOUND_SYS}`;

// ---------- エラー分類 ----------
function classify(e) {
  const s = e.status, m = String(e.message || '');
  if (s === 401 || (s === 403 && /api key|permission|invalid|unauthor|forbidden/i.test(m))) return 'auth';
  if (s === 404) return 'config';
  if ((s === 400 || s === 413) && /context|too long|too many tokens|maximum.*(token|length)|exceeds.*(token|limit)|input.*length|prompt is too long/i.test(m)) return 'context';
  if (s === 402 || s === 429 || /credit|quota|billing|insufficient|usage limit|rate.?limit|resource_exhausted|too many requests|exceeded your/i.test(m)) return 'quota';
  if (!s || s >= 500 || s === 529 || s === 408 || /overload|timeout|fetch failed|network/i.test(m)) return 'transient';
  return 'other';
}
function retryAfterMs(m) { const x = /(?:retry|try again)[^0-9]{0,30}(\d+(?:\.\d+)?)\s*(ms|s|m)\b/i.exec(m || ''); if (!x) return null; const v = +x[1]; return Math.min(30 * 60000, Math.round(x[2] === 'ms' ? v : x[2] === 's' ? v * 1000 : v * 60000)); }
const labelOf = c => (c.label || (c.provider || 'anthropic') + ':' + (c.model || (S.DEFAULTS[c.provider || 'anthropic'] || S.DEFAULTS.openai).model));
const jsn = (x, n) => { let s; try { s = typeof x === 'string' ? x : JSON.stringify(x); } catch (e) { s = String(x); } return s === undefined ? '' : (s.length > n ? s.slice(0, n) + '…(省略 ' + (s.length - n) + '字)' : s); };
const argsBrief = a => jsn(JSON.parse(JSON.stringify(a || {}, (k, v) => Array.isArray(v) && v.length > 6 ? '[' + v.length + '件]' : v)), 140);

class SPCAgent {
  /** opts: {goal, providers:[{provider,model,key,endpoint,label?,maxOut?}], storage?, maxTurns, minScore, maxWaitMs, log, onEvent, session?} */
  constructor(o) {
    this.opts = { maxTurns: 60, minScore: 7, maxWaitMs: 90000, ...o };
    this.log = o.log || (() => { }); this.onEvent = o.onEvent || (() => { });
    this.storage = o.storage || null;
    const st = o.session || { v: 1, id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), createdAt: Date.now(), goal: o.goal || '', status: 'idle', turn: 0, journal: [], lastResults: [], handoffs: [], usage: {} };
    this.st = T.ensure(st); if (o.goal && !this.st.goal) this.st.goal = o.goal;
    this.ctx = { cache: null, audio: null };
    this.setProviders(o.providers || []);
    this.aborted = false; this.level = 0; this.lastLabel = this.st.lastModel || null; this.handoff = null; this.streak = 0;
  }
  static fromSession(json, opts) { const st = typeof json === 'string' ? JSON.parse(json) : json; return new SPCAgent({ ...opts, session: st }); }
  setProviders(list) { // 使えるAIの優先順リスト(先頭が最優先)。実行中に差し替え可
    this.providers = list.map(c => ({ ...c })); this.cool = this.providers.map(() => 0); this.tries = this.providers.map(() => 0); this.softFails = this.providers.map(() => 0);
    this.providers.forEach((c, i) => { const p = c.provider || 'anthropic'; if ((p === 'anthropic' || p === 'gemini') && !c.key) this.cool[i] = Infinity; });
  }
  stop() { this.aborted = true; }
  emit(e) { try { this.onEvent(e); } catch (x) { } }
  save() {
    this.st.updatedAt = Date.now(); this.st.lastModel = this.lastLabel;
    if (!this.storage) return;
    try { this.storage.setItem('spcagent:' + this.st.id, JSON.stringify(this.st)); this.storage.setItem('spcagent:last', this.st.id); } catch (e) { this.log('⚠ 保存失敗: ' + e.message); }
  }
  exportSession() { return JSON.stringify(this.st); }

  // ---------- AI選択とフェイルオーバー ----------
  pick() { const now = Date.now(); for (let i = 0; i < this.providers.length; i++) if (this.cool[i] <= now) return i; return -1; }
  nextWake() { const now = Date.now(); let w = null; this.cool.forEach(c => { if (c !== Infinity && c > now) w = w === null ? c - now : Math.min(w, c - now); }); return w; }
  mark(i, kind, ms, reason) {
    this.cool[i] = ms === Infinity ? Infinity : Date.now() + ms; const lb = labelOf(this.providers[i]);
    (this.st.usage[lb] = this.st.usage[lb] || { turns: 0, errors: 0 }).errors++;
    this.log('⚠ ' + lb + ' → ' + kind + (ms === Infinity ? ' (この実行中は除外)' : ' (' + Math.round(ms / 1000) + '秒休止)') + ': ' + String(reason).slice(0, 140));
    this.emit({ type: 'provider_down', label: lb, kind, reason: String(reason).slice(0, 300) });
  }
  /** mk({level,hint,handoff}) → user文字列。validate(text) → 解析済み値(不正なら throw)。AIを順に試し、成功した値を返す */
  async llm(system, mk, max, validate) {
    let hint = '', reason = '';
    for (let guard = 0; guard < 60; guard++) {
      if (this.aborted) throw new AgentAbort();
      const i = this.pick();
      if (i < 0) {
        const w = this.nextWake();
        if (w !== null && w <= this.opts.maxWaitMs) { this.log('… 全AIが休止中。' + Math.ceil(w / 1000) + '秒待機'); this.emit({ type: 'wait', ms: w }); await sleep(w + 200); continue; }
        throw new AgentPause(this.providers.length ? '使えるAIが無くなりました(トークン切れ/認証エラー等)。キーやモデルを追加して再開してください' : 'AIが設定されていません');
      }
      const cfg = this.providers[i], lb = labelOf(cfg);
      if (this.lastLabel && this.lastLabel !== lb) { // ★引き継ぎ発生
        this.level = 0; // 別のAIはコンテキスト上限が違うので縮小レベルをリセット
        this.handoff = { from: this.lastLabel, to: lb, turn: this.st.turn, reason: reason || '前のAIが利用不可' };
        this.st.handoffs.push({ ...this.handoff, at: Date.now() }); this.st.handoffs = this.st.handoffs.slice(-30);
        this.log('🔁 引き継ぎ: ' + this.handoff.from + ' → ' + lb + ' (' + this.handoff.reason.slice(0, 80) + ')'); this.emit({ type: 'switch', ...this.handoff });
      }
      this.lastLabel = lb; this.emit({ type: 'model', label: lb });
      try {
        const text = await S.callOnce({ ...cfg }, system, mk({ level: this.level, hint, handoff: this.handoff }), Math.min(cfg.maxOut || 12000, max));
        const val = validate(text);
        this.tries[i] = 0; this.softFails[i] = 0; (this.st.usage[lb] = this.st.usage[lb] || { turns: 0, errors: 0 }).turns++; this.handoff = null;
        return val;
      } catch (e) {
        if (e instanceof AgentAbort || e instanceof AgentPause) throw e;
        if (e.parseFail) { // 形式不正: ヒント付きで1回再試行、ダメなら別のAIへ
          if (++this.softFails[i] < 2) { hint = e.message; this.log('… ' + lb + ' の応答が不正(' + e.message.slice(0, 60) + ')。再試行'); continue; }
          this.softFails[i] = 0; hint = ''; reason = lb + ' の出力形式が不正'; this.mark(i, 'format', 3 * 60000, e.message); continue;
        }
        const k = classify(e); reason = lb + ' ' + k + ': ' + e.message.slice(0, 100);
        if (k === 'auth' || k === 'config') this.mark(i, k, Infinity, e.message);
        else if (k === 'quota') this.mark(i, k, retryAfterMs(e.message) || 5 * 60000, e.message);
        else if (k === 'context') { if (this.level < 2) { this.level++; this.log('… コンテキスト超過 → 状態の要約を縮めて再試行(level ' + this.level + ')'); } else this.mark(i, k, 60000, e.message); }
        else if (k === 'transient') { if (++this.tries[i] <= 2) { this.log('… ' + lb + ' 一時エラー。再試行 ' + this.tries[i] + '/2'); await sleep(1200 * Math.pow(2, this.tries[i])); } else { this.tries[i] = 0; this.mark(i, k, 60000, e.message); } }
        else this.mark(i, k, 2 * 60000, e.message);
      }
    }
    throw new AgentPause('AI呼び出しが繰り返し失敗しました');
  }
  async callText(system, user) { // 批評家など1回きりの自由応答(同じフェイルオーバーを通す)
    return this.llm(system, () => user, 6000, t => { if (!String(t).trim()) { const e = new Error('空の応答'); e.parseFail = true; throw e; } return String(t).slice(0, 4000); });
  }

  // ---------- 状態 → プロンプト ----------
  stateText(level, hint, handoff) {
    const st = this.st, sg = st.song, L = [], left = this.opts.maxTurns - st.turn, ev = st.evals, last = ev[ev.length - 1], best = ev.reduce((m, e) => Math.max(m, e.overall), 0);
    const audioOk = this.ctx.audio && this.ctx.audio.rev === st.rev, evalOk = last && last.rev === st.rev;
    L.push('# 依頼\n' + st.goal);
    L.push('# 進行\nturn ' + (st.turn + 1) + '/' + this.opts.maxTurns + '(残り' + left + ') / rev ' + st.rev + ' / 現revでrender_audio=' + (audioOk ? '済' : '未') + ' evaluate=' + (evalOk ? '済' : '未') + ' / 評価回数 ' + ev.length + ' / 最高スコア ' + (best || '-'));
    if (handoff) L.push('# 【引き継ぎ通知】\n前任AI(' + handoff.from + ')が ' + handoff.reason + ' により停止し、あなた(' + handoff.to + ')が続きを担当します。会話履歴は無く、下の状態・メモ・TODO・評価・行動ログが全てです。まずそれらを読み、前任の方針を尊重して続きから作業してください。内容が不確かなら inspect / piano_roll / analyze_song で確認してから進めること。');
    L.push('# 曲の現状\ntitle=' + sg.title + ' bpm=' + sg.bpm + ' loop_start=' + sg.loop_start + '\nplan=' + jsn(sg.plan, 700));
    L.push('instruments: ' + (sg.instruments.map(i => '@' + i.id + ' ' + i.name + '(' + i.kind + ',' + (st.sounds[i.id] ? 'recipe:' + st.sounds[i.id].type : 'recipe無し') + ') ' + (level < 2 ? i.desc.slice(0, 80) : '')).join(' | ') || '(未定義)'));
    L.push('tracks: ' + (sg.tracks.map((t, i) => { const n = T.TOOLS.inspect.run(st, { what: 'meta' }).tracks[i]; let end = 0; try { const ex = S.expand(t, sg.patterns); for (const x of ex) end = Math.max(end, +x[0] + +x[1]); } catch (e) { } return 'T' + i + '[inst' + t.inst + ' pan' + t.pan + ' ' + (n.notes + n.seq ? 'notes' + n.notes + '+seq' + n.seq + ' ~' + Math.ceil(end / 16) + '小節目まで' : '空') + ']'; }).join(' ') || '(未作成)') + '\npatterns: ' + (Object.keys(sg.patterns).map(k => k + '(' + sg.patterns[k].length + ')').join(' ') || '-') + ' / snapshots: ' + (Object.keys(st.snapshots).join(',') || '-'));
    if (ev.length) L.push('# 評価履歴(新しい順・最大' + (level ? 1 : 3) + '件)\n' + ev.slice(-(level ? 1 : 3)).reverse().map(e => 'rev' + e.rev + ' 総合' + e.overall + ' ' + jsn(e.scores, 200) + '\n  問題: ' + jsn(e.problems, 400) + '\n  次: ' + jsn(e.next, 300)).join('\n'));
    L.push('# メモ(あなた/前任AIが残した決定事項)\n' + (st.notes.slice(level >= 2 ? -8 : -30).map((s, i) => '- ' + s).join('\n') || '(なし)'));
    L.push('# TODO\n' + (st.todo.map((s, i) => (i + 1) + '. ' + s).join('\n') || '(なし)'));
    const K = [8, 3, 1][Math.min(level, 2)], cap = [7000, 3500, 1500][Math.min(level, 2)];
    if (K) L.push('# 直近の行動ログ(古→新)\n' + (st.journal.slice(-K).map(j => 't' + j.turn + ' [' + j.model + '] ' + j.thought + '\n' + j.calls.map(c => '  - ' + c.t + ' ' + c.a + ' → ' + (c.ok ? 'OK ' : 'ERR ') + c.r).join('\n')).join('\n') || '(なし)'));
    L.push('# 直前ターンのツール結果(全文)\n' + (st.lastResults.length ? st.lastResults.map(r => '### ' + r.tool + ' ' + (r.ok ? '→ OK' : '→ ERROR') + '\n' + jsn(r.out, cap)).join('\n') : '(まだ何も実行していません。最初は set_meta と memo から)'));
    const notes = [];
    if (this.streak >= 4) notes.push('解析/確認ばかりが ' + this.streak + ' ターン続いています。解析結果をもとに修正(write_track/edit_notes/design_sound)へ進んでください。');
    if (left <= 4) notes.push('残りターンが少ない: 最終版で render_audio → evaluate → finish を実行して収束させてください。');
    else if (!sg.tracks.length) notes.push('まだ曲がありません。plan を決めて作り始めてください。');
    if (hint) notes.push('前回の応答は使えませんでした: ' + hint + ' → 指定形式のJSONのみを、短めの出力で返してください。');
    if (notes.length) L.push('# 注意\n' + notes.map(s => '- ' + s).join('\n'));
    L.push('# 出力\n次の1手を {"thought":"…","calls":[{"tool":"…","args":{…}}]} のJSONだけで返してください。');
    return L.join('\n\n');
  }
  parseTurn(text) {
    let o; try { o = S.extractJSON(text); } catch (e) { const x = new Error('JSONとして解析できません(出力が長すぎて切れた可能性)'); x.parseFail = true; throw x; }
    let calls = Array.isArray(o.calls) ? o.calls : (o.tool ? [{ tool: o.tool, args: o.args }] : null);
    if (!calls || !calls.length || !calls.every(c => c && typeof c.tool === 'string')) { const x = new Error('calls 配列(各要素に tool 名)がありません'); x.parseFail = true; throw x; }
    return { thought: String(o.thought || '').slice(0, 300), calls: calls.slice(0, 6), skipped: Math.max(0, calls.length - 6) };
  }

  // ---------- ツール実行 ----------
  makeCtx() {
    const st = this.st, self = this, c = this.ctx;
    c.touch = () => { st.rev++; }; c.model = this.lastLabel; c.minScore = this.opts.minScore; c.turnsLeft = this.opts.maxTurns - st.turn;
    c.audioFresh = () => !!(c.audio && c.audio.rev === st.rev);
    c.audioBrief = () => { const a = c.audio && c.audio.summary; return a ? { peak_db: a.peak_db, rms_db: a.rms_db, clip_pct: a.clip_pct, spectrum: a.spectrum, per_voice: a.per_voice, loop_seam: a.loop_seam, warnings: a.warnings } : null; };
    c.lastAnalysisWarnings = () => { try { return T.analyzeSong(st).warnings.length; } catch (e) { return 0; } };
    c.callText = (sys, usr) => self.callText(sys, usr);
    return c;
  }
  async exec(call) {
    const t = T.TOOLS[call.tool], ctx = this.makeCtx();
    if (!t) return { ok: false, out: { error: '未知のツール "' + call.tool + '"。使えるのは: ' + Object.keys(T.TOOLS).join(', ') } };
    try { return { ok: true, out: await t.run(this.st, call.args || {}, ctx) }; }
    catch (e) { return { ok: false, out: { error: String(e.message || e) } }; }
  }
  /** 1ターン進める */
  async step() {
    const st = this.st;
    const turn = await this.llm(SYSTEM(), ({ level, hint, handoff }) => this.stateText(level, hint, handoff), 12000, t => this.parseTurn(t));
    st.turn++; this.emit({ type: 'turn', turn: st.turn, model: this.lastLabel, thought: turn.thought });
    if (turn.thought) this.log('💭 [' + st.turn + '] ' + turn.thought);
    const results = [], jc = []; let mutated = false, analysis = true; const rev0 = st.rev;
    for (const call of turn.calls) {
      const r = await this.exec(call); results.push({ tool: call.tool, ok: r.ok, out: r.out });
      jc.push({ t: call.tool, a: argsBrief(call.args), ok: r.ok, r: jsn(r.out, 160) });
      this.log((r.ok ? '🔧 ' : '❌ ') + call.tool + ' ' + argsBrief(call.args).slice(0, 70) + ' → ' + jsn(r.out, 110).replace(/\s+/g, ' '));
      this.emit({ type: 'tool', tool: call.tool, ok: r.ok, out: r.out });
      if (r.ok && call.tool === 'evaluate') this.emit({ type: 'eval', eval: st.evals[st.evals.length - 1] });
      if (st.status === 'done') break;
    }
    if (turn.skipped) results.push({ tool: '(system)', ok: false, out: { error: 'calls が多すぎ ' + turn.skipped + ' 個を実行していません。次ターンにまわしてください' } });
    mutated = st.rev !== rev0; this.streak = mutated ? 0 : this.streak + 1;
    st.lastResults = results.map(r => { const s = typeof r.out === 'string' ? r.out : JSON.stringify(r.out); return { tool: r.tool, ok: r.ok, out: s.length > 8000 ? s.slice(0, 8000) + '…' : r.out }; });
    st.journal.push({ turn: st.turn, model: this.lastLabel, thought: turn.thought, calls: jc }); st.journal = st.journal.slice(-80);
    if (this.ctx.cache && this.ctx.cache.rev === st.rev && this.ctx.cache !== this._emitted) { this._emitted = this.ctx.cache; this.emit({ type: 'built', res: this.ctx.cache.res }); }
    this.save();
  }
  /** 最終版を整える: 最高スコア版より悪化していたら best に戻す */
  async finalize() {
    const st = this.st, last = st.evals[st.evals.length - 1], b = st.snapshots.best;
    if (b && last && last.rev === st.rev && last.overall < b.overall - 0.4) { st.song = JSON.parse(JSON.stringify(b.song)); st.sounds = JSON.parse(JSON.stringify(b.sounds)); st.rev++; this.log('↩ 最終版が最高評価(' + b.overall + ')より低い(' + last.overall + ')ので最高評価の版に戻しました'); }
    try { const res = await T.build(st, this.ctx); this.emit({ type: 'built', res }); return res; } catch (e) { this.log('⚠ 最終ビルド失敗: ' + e.message); return null; }
  }
  async run() {
    const st = this.st; this.aborted = false;
    if (st.status === 'done') { this.emit({ type: 'done' }); return this.result(); }
    if (st.status === 'paused') this.cool = this.cool.map(c => c === Infinity ? c : 0); // 手動再開時は休止を解除して試し直す
    st.status = 'running'; st.pauseReason = ''; this.emit({ type: 'status', status: 'running' }); this.save();
    try {
      while (st.status === 'running' && st.turn < this.opts.maxTurns) { await this.step(); }
      if (st.status === 'running') { st.status = 'done'; st.summary = st.summary || '最大ターン数に達したため打ち切り'; }
      await this.finalize(); this.save(); this.emit({ type: 'done', summary: st.summary }); return this.result();
    } catch (e) {
      if (e instanceof AgentPause) { st.status = 'paused'; st.pauseReason = e.message; this.save(); this.log('⏸ 一時停止: ' + e.message + ' (状態は保存済み。AI設定を直して再開できます)'); this.emit({ type: 'paused', reason: e.message }); return this.result(); }
      if (e instanceof AgentAbort) { st.status = 'paused'; st.pauseReason = '手動停止'; this.save(); this.emit({ type: 'paused', reason: '手動停止' }); return this.result(); }
      st.status = 'error'; st.pauseReason = String(e.message || e); this.save(); this.emit({ type: 'error', error: st.pauseReason }); throw e;
    }
  }
  result() { return { status: this.st.status, turn: this.st.turn, rev: this.st.rev, summary: this.st.summary, reason: this.st.pauseReason, best: this.st.evals.reduce((m, e) => Math.max(m, e.overall), 0) }; }
  async build() { return T.build(this.st, this.ctx); }
}
const API = { SPCAgent, classify, labelOf, AgentPause };
if (isNode) module.exports = API; else root.SPCAGENT = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
