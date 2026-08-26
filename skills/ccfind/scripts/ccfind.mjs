#!/usr/bin/env node
// ccfind - BM25 full-text search over local Claude Code transcripts.
// Subcommands: index, search, show, open, pick, stats, bench, install, uninstall
// No network calls. Reads ~/.claude/projects/*/*.jsonl, writes ~/.claude/ccfind/.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
// Where Claude Code keeps its state. `CLAUDE_CONFIG_DIR` is Claude Code's own
// override, so honouring it is the difference between finding a user's history
// and reporting that they have none; `CCFIND_CONFIG_DIR` points ccfind at a
// different corpus than the CLI is using, which is how the demo is recorded
// against a synthetic history instead of somebody's real one.
const CONFIG = process.env.CCFIND_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR
             || path.join(HOME, '.claude');
const PROJECTS = path.join(CONFIG, 'projects');
const STORE = path.join(CONFIG, 'ccfind');
const DOCS = path.join(STORE, 'docs.jsonl');
const INDEX = path.join(STORE, 'index.json.gz');
const STATE = path.join(STORE, 'state.json');

// Field weights: a hit in what the user actually asked outranks a hit in
// scrollback from a grep that happened to print the word.
const FIELD_WEIGHT = { title: 3.5, prompt: 3.0, answer: 1.5, thinking: 0.7, tool: 1.0, output: 0.5, summary: 0.4 };
const FIELDS = ['title', 'prompt', 'answer', 'thinking', 'tool', 'output', 'summary'];
const IDXV = 4;
const CHUNK = 1000;           // chars per indexed chunk
const MAX_TOOL_INPUT = 2000;  // truncate tool args
const MAX_TOOL_OUTPUT = 16000;// truncate tool results
const K1 = 1.2, B = 0.75;
const MAX_DF_RATIO = 0.4;     // ignore terms present in >40% of chunks
const SUBTOKEN_QUERY_WEIGHT = 0.35; // "kube-vip" must beat every stray "kube"

// Claude Code marks its own process environment per session, and every one of
// those marks is wrong for a window we are about to open on a *different*
// session. `CLAUDE_CODE_CHILD_SESSION` is the one that costs data: inherited by
// the resumed run, it turns transcript saving off, so that conversation is never
// written to disk and ccfind can never find it again. The rest are this session's
// identity and its IPC channel, equally wrong to hand to another run. Settings
// the user actually chose - `CLAUDE_CONFIG_DIR` above all - are deliberately
// absent from this list and pass through untouched.
const SESSION_MARKERS = [
  'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID',
];
const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of SESSION_MARKERS) delete env[k];
  return env;
};

// ---------------------------------------------------------------- tokenizer

const SPLIT = /[^\p{L}\p{N}_.-]+/u;
const CAMEL = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

function variants(raw) {
  // Returns [full, ...subtokens] for one whitespace-delimited word.
  const t = raw.replace(/^[.\-]+|[.\-]+$/g, '');
  if (!t || t.length > 64) return [];
  const out = [t.toLowerCase()];
  if (/[._-]/.test(t)) {
    for (const p of t.split(/[._-]+/)) if (p.length > 1) out.push(p.toLowerCase());
  }
  if (CAMEL.test(t)) {
    for (const p of t.split(CAMEL)) if (p.length > 1) out.push(p.toLowerCase());
  }
  return [...new Set(out)];
}

export function tokenize(text) {
  const out = [];
  for (const raw of String(text).split(SPLIT)) {
    if (raw) out.push(...variants(raw));
  }
  return out;
}

// Query tokens carry weights: the compound the user typed counts full, the
// pieces it decomposes into count little. Without this, "kube-vip" ranks every
// exchange that ever said "kube" alongside the ones about the VIP itself.
function queryTerms(q) {
  const w = new Map();
  const full = new Set();
  for (const raw of String(q).split(SPLIT)) {
    if (!raw) continue;
    const vs = variants(raw);
    if (!vs.length) continue;
    full.add(vs[0]);
    w.set(vs[0], Math.max(w.get(vs[0]) || 0, 1.0));
    for (const sub of vs.slice(1)) {
      if (full.has(sub)) continue;
      w.set(sub, Math.max(w.get(sub) || 0, SUBTOKEN_QUERY_WEIGHT));
    }
  }
  for (const f of full) w.set(f, 1.0);
  return { weights: w, full: [...full] };
}

// ---------------------------------------------------------------- extraction

const B64ISH = /^[A-Za-z0-9+/=\s]{400,}$/;

// Injected context is not something the user typed. Indexing it as a prompt
// (weight 3.0) would rank hook boilerplate above real questions, and showing it
// as the "ask" line makes a correct hit look wrong.
const INJECTED = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  // `/ccfind which session had the coredns fix` - the words inside the tag are
  // the user's actual question. Dropping the whole element threw away the prompt of
  // every slash-command turn; only the wrapper is boilerplate.
  /<\/?command-args>/g,
  /<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g,
  /^[ \t]*(?:UserPromptSubmit|SessionStart)[^\n]*hook[^\n]*$/gm,
  /\[Image #\d+\]/g,
];

function cleanPrompt(text) {
  let t = String(text);
  for (const re of INJECTED) t = t.replace(re, ' ');
  return t.trim();
}

function textOfToolResult(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && b.type === 'text' ? b.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function* fieldsOf(entry) {
  const msg = entry.message;
  if (!msg || typeof msg !== 'object') return;
  const role = msg.role;
  const content = msg.content;
  // A compaction summary is written by Claude, not asked by the user, and it
  // repeats every topic of the session it replaces. Indexed as a prompt it would
  // let a continuation outrank the session that did the work, and it would
  // supply the "ask" line. Own field, lowest weight: still findable, never wins.
  const userField = entry.isCompactSummary ? 'summary' : 'prompt';
  // A meta turn is injected, not typed: the body of a skill the model loaded, the
  // "messages below were generated by the user" caveat, an image-cache path,
  // "Continue from where you left off." 145 of 969 user turns in the test corpus.
  // Indexed as prompts they rank a skill's own README above the question it
  // answered - which is exactly what happened to this tool's own transcript.
  if (entry.isMeta && role === 'user') return;

  if (typeof content === 'string') {
    if (role === 'user') {
      const c = cleanPrompt(content);
      if (c) yield { field: userField, text: c };
    }
    return;
  }
  if (!Array.isArray(content)) return;

  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    switch (b.type) {
      case 'text': {
        if (role === 'user') {
          const c = cleanPrompt(b.text || '');
          if (c) yield { field: userField, text: c };
        } else if (b.text) {
          yield { field: 'answer', text: b.text };
        }
        break;
      }
      case 'thinking':
        if (b.thinking) yield { field: 'thinking', text: b.thinking };
        break;
      case 'tool_use': {
        let args = '';
        try { args = JSON.stringify(b.input ?? {}); } catch { args = ''; }
        yield { field: 'tool', text: `${b.name || ''} ${args.slice(0, MAX_TOOL_INPUT)}` };
        break;
      }
      case 'tool_result': {
        const t = textOfToolResult(b.content).slice(0, MAX_TOOL_OUTPUT);
        if (t && !B64ISH.test(t)) yield { field: 'output', text: t };
        break;
      }
      default:
        break; // image, server_tool_use, advisor_tool_result (encrypted): nothing to index
    }
  }
}

function chunks(text) {
  const s = text.replace(/\s+/g, ' ').trim();
  if (!s) return [];
  if (s.length <= CHUNK) return [s];
  const out = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + CHUNK, s.length);
    if (end < s.length) {
      const sp = s.lastIndexOf(' ', end);
      if (sp > i + CHUNK * 0.6) end = sp;
    }
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

// ---------------------------------------------------------------- index build

async function buildIndex({ full = false, quiet = false } = {}) {
  const t0 = Date.now();
  fs.mkdirSync(STORE, { recursive: true });

  const files = [];
  for (const dir of safeReaddir(PROJECTS)) {
    const dp = path.join(PROJECTS, dir);
    if (!safeStat(dp)?.isDirectory()) continue;
    for (const f of safeReaddir(dp)) {
      if (f.endsWith('.jsonl')) files.push(path.join(dir, f));
    }
  }

  const prev = full ? {} : readJSON(STATE, {});
  let stale = false;
  for (const rel of files) {
    const st = safeStat(path.join(PROJECTS, rel));
    const p = prev[rel];
    if (!st || !p || p.size !== st.size || p.mtimeMs !== st.mtimeMs) { stale = true; break; }
  }
  if (!full && !stale && Object.keys(prev).length === files.length
      && fs.existsSync(DOCS) && fs.existsSync(INDEX)) {
    const cached = readIndex();
    // An index written by an older field layout cannot be trusted even when
    // every transcript is unchanged: field ids shift and weights move with them.
    if (cached && cached.v === IDXV) {
      if (!quiet) console.error(`ccfind: index up to date (${files.length} transcripts)`);
      return cached;
    }
    _index = null;
  }
  // v0.1 rebuilds whole corpus on any change: roughly 13 MB/s measured, and a
  // correct incremental merge is only worth writing once the on-disk format
  // settles.

  const docsFd = fs.openSync(DOCS, 'w');
  const state = {};
  const sessions = [];      // {id, title, project, cwd, branch, first, last, n}
  const sessionIdx = new Map();
  const exchanges = [];     // {si, t, ts, n}
  const dx = [];            // doc -> exchange index
  const dfld = [];          // doc -> field id
  const dl = [];
  const offsets = [];
  const postings = new Map();
  let docId = 0, offset = 0, bytesRead = 0;

  const pushDoc = (xi, field, text, ts, sc) => {
    const toks = tokenize(text);
    if (!toks.length) return;
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    const w = FIELD_WEIGHT[field] ?? 1.0;
    for (const [t, n] of tf) {
      let arr = postings.get(t);
      if (!arr) { arr = []; postings.set(t, arr); }
      arr.push(docId, n * w);
    }
    const buf = Buffer.from(JSON.stringify({ t: text, ts, sc: sc ? 1 : 0 }) + '\n', 'utf8');
    fs.writeSync(docsFd, buf);
    offsets.push(offset, buf.length);
    offset += buf.length;
    dl.push(toks.length * w);
    dx.push(xi);
    dfld.push(FIELDS.indexOf(field));
    exchanges[xi].n++;
    docId++;
  };

  for (const rel of files) {
    const abs = path.join(PROJECTS, rel);
    const st = safeStat(abs);
    if (!st) continue;
    state[rel] = { size: st.size, mtimeMs: st.mtimeMs };
    bytesRead += st.size;

    const project = path.dirname(rel);
    const sid = path.basename(rel, '.jsonl');
    const si = sessions.length;
    sessionIdx.set(sid, si);
    sessions.push({ id: sid, title: null, project, cwd: null, branch: null, first: null, last: null, n: 0 });

    // Every exchange this file pushes carries this file's si, and exchanges is
    // append-only, so the file's own slice is exactly [x0, exchanges.length).
    // That turns "which exchanges belong to this session" from a scan of the
    // whole array per file into two integers.
    const x0 = exchanges.length;
    let xi = -1;
    let sawPrompt = false;

    const rl = readline.createInterface({
      input: fs.createReadStream(abs, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }

      // Session titles: /rename wins over the model-written one.
      if (e.type === 'custom-title' && e.customTitle) sessions[si].title = e.customTitle;
      else if (e.type === 'ai-title' && e.aiTitle && !sessions[si].title) sessions[si].title = e.aiTitle;
      if (e.type !== 'user' && e.type !== 'assistant') continue;

      const s = sessions[si];
      if (e.cwd && !s.cwd) s.cwd = e.cwd;
      if (e.gitBranch && !s.branch) s.branch = e.gitBranch;
      if (e.timestamp) { if (!s.first) s.first = e.timestamp; s.last = e.timestamp; }

      for (const { field, text } of fieldsOf(e)) {
        if (!text) continue;
        // A user prompt opens a new exchange; the tool calls and answers that
        // follow hang off it, which is how people remember conversations.
        if (field === 'prompt') {
          if (sawPrompt || xi === -1) {
            exchanges.push({ si, t: text.replace(/\s+/g, ' ').trim().slice(0, 220), ts: e.timestamp || null, n: 0 });
            xi = exchanges.length - 1;
          }
          sawPrompt = true;
        } else if (xi === -1) {
          exchanges.push({ si, t: '(session start)', ts: e.timestamp || null, n: 0 });
          xi = exchanges.length - 1;
          sawPrompt = false;
        }
        for (const chunk of chunks(text)) pushDoc(xi, field, chunk, e.timestamp || null, e.isSidechain);
      }
    }

    // Index the title against the session's first exchange so a search for the
    // topic finds the session even when the wording only exists in the title.
    if (sessions[si].title) {
      let xt = exchanges.length > x0 ? x0 : -1;
      if (xt === -1) {
        exchanges.push({ si, t: sessions[si].title, ts: sessions[si].first, n: 0 });
        xt = exchanges.length - 1;
      }
      pushDoc(xt, 'title', sessions[si].title, sessions[si].first, false);
    }
    sessions[si].n = exchanges.length - x0;
  }
  fs.closeSync(docsFd);

  const N = docId;
  const avgdl = N ? dl.reduce((a, b) => a + b, 0) / N : 0;
  const maxDf = Math.max(4, Math.floor(N * MAX_DF_RATIO));
  const post = {};
  let dropped = 0;
  for (const [t, arr] of postings) {
    if (arr.length / 2 > maxDf) { dropped++; continue; }
    post[t] = arr;
  }

  const index = { v: IDXV, N, avgdl, dl, offsets, dx, dfld, exchanges, sessions,
                  postings: post, built: new Date().toISOString(), bytesRead, files: files.length };
  fs.writeFileSync(INDEX, zlib.gzipSync(Buffer.from(JSON.stringify(index)), { level: 6 }));
  fs.writeFileSync(STATE, JSON.stringify(state));

  if (!quiet) {
    console.error(
      `ccfind: indexed ${files.length} sessions, ` +
      `${(bytesRead / 1048576).toFixed(1)} MB of transcripts, in ${Date.now() - t0} ms` +
      (dropped ? ` (${dropped} words too common to be useful)` : '')
    );
  }
  return index;
}

// ---------------------------------------------------------------- search

let _index = null;
function readIndex() {
  if (_index) return _index;
  if (!fs.existsSync(INDEX)) return null;
  _index = JSON.parse(zlib.gunzipSync(fs.readFileSync(INDEX)));
  return _index;
}

function readDoc(idx, id) {
  const off = idx.offsets[id * 2], len = idx.offsets[id * 2 + 1];
  const fd = fs.openSync(DOCS, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, off);
    return JSON.parse(buf.toString('utf8'));
  } finally { fs.closeSync(fd); }
}

function scoreDocs(idx, query) {
  const { weights, full } = queryTerms(query);
  const scores = new Map();
  const hitFull = new Map(); // doc -> Set(full term) : coverage counts only what was typed
  const idfOf = new Map();
  for (const [t, qw] of weights) {
    const arr = idx.postings[t];
    if (!arr) continue;
    const df = arr.length / 2;
    const idf = Math.log(1 + (idx.N - df + 0.5) / (df + 0.5));
    const isFull = qw === 1.0;
    if (isFull) idfOf.set(t, idf);
    for (let i = 0; i < arr.length; i += 2) {
      const id = arr[i], tf = arr[i + 1];
      const norm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (idx.dl[id] / idx.avgdl)));
      scores.set(id, (scores.get(id) || 0) + qw * idf * norm);
      if (isFull) {
        let s = hitFull.get(id);
        if (!s) { s = new Set(); hitFull.set(id, s); }
        s.add(t);
      }
    }
  }
  return { scores, hitFull, full, weights, idfOf };
}

// Roll chunk scores up one level: the best chunk dominates, corroborating
// chunks add a capped bonus so a long noisy session cannot out-sum a precise
// short one. Coverage of the typed terms multiplies - it is the strongest
// signal that a conversation is about the thing asked for.
// Coverage is weighted by idf squared, not by term count. A query like
// "image-gc-high threshold on the node" is answered by the one session holding
// that identifier, even when it never spells out the other three words - which
// is the usual shape when the identifier is English and the sentence around it
// is not. Plain idf is not enough: three ordinary words still out-sum one rare
// identifier. Squaring makes the rarest term of a query
// dominate its own coverage, which is what a person means when they type it.
function rollup(entries, idfOf, restCap = 1.5, restWeight = 0.25) {
  let total = 0;
  for (const v of idfOf.values()) total += v * v;
  const out = [];
  for (const g of entries) {
    const rest = Math.min(g.rest, g.best.sc * restCap);
    let got = 0;
    for (const t of g.terms) { const v = idfOf.get(t) || 0; got += v * v; }
    const cov = total > 0 ? got / total : 1;
    g.score = (g.best.sc + restWeight * rest) * (0.35 + 0.65 * cov);
    g.cov = cov;
    out.push(g);
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function search(query, opts = {}) {
  const idx = readIndex();
  if (!idx) throw new Error('no index yet; run: ccfind.mjs index');
  const limit = opts.limit ?? 10;
  const group = opts.group === 'exchange' ? 'exchange' : 'session';
  const { scores, hitFull, full, idfOf } = scoreDocs(idx, query);
  const empty = { terms: full, group, hits: [], relevant: 0, weak: 0, total: 0,
                  docsScored: 0, exchangesScored: 0, sessionsScored: 0 };
  if (!scores.size) return empty;

  // --field restricts the search to that field rather than only requiring the
  // winning chunk to sit in it. A low-weight field never wins a roll-up, so the
  // post-filter made `--field summary` and `--field thinking` unsearchable.
  if (opts.field) {
    const fi = FIELDS.indexOf(opts.field);
    if (fi < 0) throw new Error(`unknown field: ${opts.field} (have ${FIELDS.join('|')})`);
    for (const id of [...scores.keys()]) if (idx.dfld[id] !== fi) scores.delete(id);
    if (!scores.size) return empty;
  }

  const byX = new Map();
  for (const [id, sc] of scores) {
    const xi = idx.dx[id];
    let g = byX.get(xi);
    if (!g) { g = { xi, best: { id, sc }, rest: 0, terms: new Set(), docs: 0 }; byX.set(xi, g); }
    if (sc > g.best.sc) { g.rest += g.best.sc; g.best = { id, sc }; } else g.rest += sc;
    g.docs++;
    for (const t of hitFull.get(id) || []) g.terms.add(t);
  }
  const xRanked = rollup([...byX.values()], idfOf);

  let groups;
  if (group === 'exchange') {
    groups = xRanked.map((g) => ({ ...g, si: idx.exchanges[g.xi].si }));
  } else {
    const byS = new Map();
    for (const g of xRanked) {
      const si = idx.exchanges[g.xi].si;
      let s = byS.get(si);
      if (!s) { s = { si, best: { id: g.best.id, sc: g.score, xi: g.xi }, rest: 0, terms: new Set(), docs: 0 }; byS.set(si, s); }
      else if (g.score > s.best.sc) { s.rest += s.best.sc; s.best = { id: g.best.id, sc: g.score, xi: g.xi }; }
      else s.rest += g.score;
      s.docs += g.docs;
      for (const t of g.terms) s.terms.add(t);
    }
    groups = rollup([...byS.values()], idfOf, 1.0, 0.15);
    for (const g of groups) g.xi = g.best.xi;
  }

  // filters
  const sessOf = (g) => idx.sessions[g.si ?? idx.exchanges[g.xi].si];
  if (opts.project) {
    const q = opts.project.toLowerCase();
    groups = groups.filter((g) => {
      const s = sessOf(g);
      return (s.project || '').toLowerCase().includes(q) || (s.cwd || '').toLowerCase().includes(q);
    });
  }
  if (opts.session) groups = groups.filter((g) => sessOf(g).id.startsWith(opts.session));
  if (opts.exclude) {
    const ex = Array.isArray(opts.exclude) ? opts.exclude : [opts.exclude];
    groups = groups.filter((g) => !ex.some((e) => e && sessOf(g).id.startsWith(e)));
  }
  if (opts.days) {
    const cut = Date.now() - opts.days * 86400000;
    groups = groups.filter((g) => {
      const ts = idx.exchanges[g.xi].ts || sessOf(g).last;
      return ts ? Date.parse(ts) >= cut : false;
    });
  }

  // The turn a session opened with is the cheapest honest description of it:
  // exchanges are pushed in file order, so the first one per session is it.
  const firstOf = new Map();
  for (let i = 0; i < idx.exchanges.length; i++) {
    const si = idx.exchanges[i].si;
    if (!firstOf.has(si)) firstOf.set(si, idx.exchanges[i]);
  }

  // BM25 has no notion of "not relevant": every session holding one query word
  // gets a score, so a 25-row list is one answer plus 24 sessions that happen to
  // share the word "restart". The gate keeps the hits scoring within a fraction
  // of the top one and hands back the rest as a count, so the caller states a
  // measured number instead of eyeballing the table.
  //
  // 0.25 is where the sweep over 12 ground-truth queries settles: it drops 169
  // of 173 irrelevant hits for 0.03 of P@3, where 0.3 buys two more of those
  // 173 at 0.06. What it costs is always the same shape - a session that
  // mentions the identifier once in passing, which grep-based ground truth
  // scores as relevant and a reader does not. The top hit is exempt by
  // construction: a search that matched something always answers with something.
  const WEAK_BAR = 0.25;
  let relevant = groups.length;
  if (!opts.all && groups.length) {
    const bar = groups[0].score * WEAK_BAR;
    relevant = 1;
    while (relevant < groups.length && groups[relevant].score >= bar) relevant++;
  }

  const hits = groups.slice(0, Math.min(limit, relevant)).map((g) => {
    const x = idx.exchanges[g.xi];
    const s = sessOf(g);
    const open = firstOf.get(g.si ?? idx.exchanges[g.xi].si);
    const doc = readDoc(idx, g.best.id);
    return {
      score: +g.score.toFixed(2),
      coverage: +g.cov.toFixed(2),
      chunks: g.docs,
      title: s.title,
      session: s.id,
      project: s.project,
      cwd: s.cwd,
      branch: s.branch,
      when: x.ts || s.last,
      prompt: x.t,
      field: FIELDS[idx.dfld[g.best.id]],
      sidechain: !!doc.sc,
      snippet: snippet(doc.t, full),
      opening: open && open.t !== x.t ? open.t : null,
      turns: s.n || null,
      // Two different things, and the difference is the whole point: `/resume`
      // is a built-in slash command (argumentHint "[conversation id or search
      // term]") that switches this window to that session, while
      // `claude --resume` starts a separate run in a terminal.
      open: `/resume ${s.id}`,
      resume: `claude --resume ${s.id}`,
    };
  });
  // `total` stays what it always was - everything that matched after the
  // filters - so a caller can still say how wide the field was. `relevant` is
  // what survived the gate, `weak` what it cut.
  return { terms: full, group, hits, relevant, weak: groups.length - relevant,
           total: groups.length, docsScored: scores.size,
           exchangesScored: byX.size, sessionsScored: new Set(xRanked.map((g) => idx.exchanges[g.xi].si)).size };
}

function snippet(text, terms, width = 260) {
  const low = text.toLowerCase();
  let best = 0, bestScore = -1;
  for (let i = 0; i < Math.max(1, low.length - width / 2); i += 40) {
    const win = low.slice(i, i + width);
    let s = 0;
    for (const t of terms) if (win.includes(t)) s++;
    if (s > bestScore) { bestScore = s; best = i; }
  }
  const from = Math.max(0, best - 20);
  let out = text.slice(from, from + width);
  if (from > 0) out = '...' + out;
  if (from + width < text.length) out += '...';
  return out;
}

// ---------------------------------------------------------------- cli

function readJSON(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; }
}
function safeReaddir(p) { try { return fs.readdirSync(p); } catch { return []; } }
function safeStat(p) { try { return fs.statSync(p); } catch { return null; } }

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { o[k] = next; i++; } else o[k] = true;
    } else o._.push(a);
  }
  return o;
}

// A count flag that fails to parse falls back to the default instead of
// poisoning a slice with NaN ("--limit abc" silently showing zero hits).
function posInt(v, dflt) {
  const n = Math.floor(+v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// Same idea for a window of days, except fractions are meaningful: --days 0.5
// is the last twelve hours. Not posInt, which would floor that to 0 and quietly
// drop the filter the user asked for.
function posNum(v, dflt) {
  const n = +v;
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// Plain-text output is what a first-time reader sees, so it spells things out:
// where the session lived, the words the user themselves used, and which part of
// the conversation the match landed in. --json carries the raw numbers.
const FIELD_LABEL = {
  title: 'the session name',
  prompt: 'your own question',
  answer: 'the answer',
  thinking: 'the reasoning',
  tool: 'a command that ran',
  output: 'command output',
  summary: 'the session summary',
};

function wrap(text, width, indent) {
  const out = [];
  let line = '';
  for (const w of String(text).split(/\s+/)) {
    if (line && line.length + 1 + w.length > width) { out.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out.map((l) => indent + l).join('\n');
}

function shortPath(p) {
  if (!p) return null;
  return p === HOME ? '~' : p.startsWith(HOME + path.sep) ? '~' + p.slice(HOME.length) : p;
}

function human(res) {
  if (!res.hits.length) {
    console.log(`nothing matched: ${res.terms.join(' ')}`);
    return;
  }
  const width = Math.min(Math.max(process.stdout.columns || 88, 60), 100);
  // res.total is the count after filters, so it never promises a session the
  // caller cannot actually reach (the current session is excluded by default).
  const total = res.total ?? (res.group === 'session' ? res.sessionsScored : res.exchangesScored);
  const unit = res.group === 'session' ? 'session' : 'turn';
  // The gate already dropped the long tail, so the header counts what it kept:
  // saying "best 4 of 61" when 57 of those 61 were one shared common word reads
  // as a search that found plenty and showed little.
  const rel = res.relevant ?? total;
  console.log(res.hits.length < rel
    ? `best ${res.hits.length} of ${rel} relevant ${unit}s:\n`
    : `${rel} relevant ${unit}${rel === 1 ? '' : 's'}:\n`);
  let n = 0;
  for (const h of res.hits) {
    n++;
    const when = h.when ? h.when.slice(0, 16).replace('T', ' ') : 'date unknown';
    const meta = [when, shortPath(h.cwd) || h.project];
    if (h.branch) meta.push(h.branch);
    if (h.sidechain) meta.push('subagent');
    const words = res.terms.length;
    const found = Math.round(h.coverage * words);
    const cov = found >= words
      ? `all ${words} word${words === 1 ? '' : 's'} present`
      : `${found} of ${words} words present`;
    console.log(`${n}. ${h.title || h.project}`);
    console.log(`   ${meta.join('  ')}`);
    console.log(`   score ${h.score}, ${cov}`);
    if (h.prompt) console.log(wrap(`you asked: "${h.prompt}"`, width - 3, '   '));
    if (h.opening) console.log(wrap(`session began: "${h.opening}"`, width - 3, '   '));
    console.log(`   matched in ${FIELD_LABEL[h.field] || h.field}:`);
    console.log(wrap(h.snippet, width - 5, '     '));
    console.log(`   open it:   ${h.open}${process.env.CLAUDECODE ? '' : `   (in a terminal: ${h.resume})`}\n`);
  }
  // Two different numbers, so two lines: relevant hits that --limit cut off are
  // worth re-running for, weak ones are worth knowing about but not printing.
  const more = (res.relevant ?? res.total ?? res.hits.length) - res.hits.length;
  if (more > 0) console.log(`${more} more relevant - re-run with --limit ${res.relevant}`);
  if (res.weak > 0) console.log(`${res.weak} weak match${res.weak === 1 ? '' : 'es'} scored far below the top hit and were hidden - --all shows them`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || 'search';

if (cmd === 'index') {
  await buildIndex({ full: !!args.full });
} else if (cmd === 'stats') {
  const idx = readIndex();
  if (!idx) { console.error('no index'); process.exit(1); }
  console.log(JSON.stringify({
    built: idx.built, transcripts: idx.files, sessions: idx.sessions.length,
    exchanges: idx.exchanges.length, chunks: idx.N,
    terms: Object.keys(idx.postings).length, avgdl: +idx.avgdl.toFixed(1),
    mbRead: +(idx.bytesRead / 1048576).toFixed(1),
    indexMb: +(fs.statSync(INDEX).size / 1048576).toFixed(2),
    docsMb: +(fs.statSync(DOCS).size / 1048576).toFixed(2),
    titled: idx.sessions.filter((s) => s.title).length,
  }, null, 2));
} else if (cmd === 'show') {
  // Reading one session's shape without opening the transcript: what it started
  // from, every turn in order, so a picked search hit can be understood in place.
  const want = args._[1];
  if (!want) { console.error('usage: ccfind.mjs show <session-id> [--turns N] [--json]'); process.exit(1); }
  const idx = readIndex();
  if (!idx) { console.error('no index - run: ccfind.mjs index'); process.exit(1); }
  const si = idx.sessions.findIndex((x) => x.id.startsWith(want));
  if (si === -1) { console.error(`ccfind: no session starting with ${want}`); process.exit(1); }
  const ses = idx.sessions[si];
  const turns = idx.exchanges
    .map((x, i) => ({ ...x, i }))
    .filter((x) => x.si === si && x.t && x.t !== '(session start)');
  const cap = args.turns ? posInt(args.turns, 40) : 40;
  const shown = turns.slice(0, cap);
  if (args.json) {
    console.log(JSON.stringify({
      session: ses.id, title: ses.title, project: ses.project, cwd: ses.cwd,
      branch: ses.branch, first: ses.first, last: ses.last, turns: turns.length,
      shown: shown.map((x) => ({ when: x.ts, prompt: x.t })),
      open: `/resume ${ses.id}`,
      resume: `claude --resume ${ses.id}`,
    }, null, 2));
  } else {
    const width = Math.min(Math.max(process.stdout.columns || 88, 60), 100);
    const day = (t) => (t ? t.slice(0, 16).replace('T', ' ') : '?');
    console.log(`${ses.title || ses.project}`);
    console.log(`${day(ses.first)} to ${day(ses.last)}  ${shortPath(ses.cwd) || ses.project}` +
                `${ses.branch ? '  ' + ses.branch : ''}  ${turns.length} turn${turns.length === 1 ? '' : 's'}`);
    console.log(`open it: /resume ${ses.id}   (in a terminal: claude --resume ${ses.id})\n`);
    console.log('what you asked, in order:');
    let n = 0;
    for (const x of shown) {
      n++;
      console.log(wrap(`${String(n).padStart(2)}. ${day(x.ts).slice(11) || '  '}  ${x.t}`, width - 4, '  '));
    }
    if (turns.length > shown.length) {
      console.log(`\n${turns.length - shown.length} more turns - re-run with --turns ${turns.length}`);
    }
  }
} else if (cmd === 'install' || cmd === 'uninstall') {
  // `ccfind` on PATH without the user hand-writing an alias.
  //
  // Not a symlink: Claude Code installs a plugin into
  // ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/, and that
  // <version> segment changes on every `claude plugin update`, so a symlink
  // into it dies at the next update. What gets written is a tiny launcher that
  // re-reads installed_plugins.json at run time and imports whatever version is
  // installed now - in the same process, so it costs no extra node startup.
  const self = fileURLToPath(import.meta.url);
  const onPath = (process.env.PATH || '').split(path.delimiter);
  const candidates = [path.join(HOME, '.local', 'bin'), path.join(HOME, 'bin'), '/usr/local/bin'];
  const writable = (d) => { try { fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; } };
  // An explicit CCFIND_BIN_DIR wins outright - it is the user naming the dir,
  // and picking a different one because theirs is not on PATH yet is not help.
  let dir = process.env.CCFIND_BIN_DIR
         || candidates.find((d) => onPath.includes(d) && fs.existsSync(d) && writable(d))
         || candidates.find((d) => fs.existsSync(d) && writable(d))
         || path.join(HOME, '.local', 'bin');
  const link = path.join(dir, 'ccfind');
  const MARK = 'ccfind launcher (generated by `ccfind install`)';
  const launcher = (fallback) => `#!/usr/bin/env node
// ${MARK} - do not edit.
// Resolves the installed plugin version at run time so a plugin update needs
// no reinstall. Delete it with \`ccfind uninstall\`.
//
// CommonJS on purpose. The file has no .mjs extension, and Node only infers
// ESM from the syntax itself since 20.19 - on Node 18, which ccfind supports,
// an import statement here is a SyntaxError and the launcher never runs.
// require plus a dynamic import() works on every supported version.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const FALLBACK = ${JSON.stringify(fallback)};
const REG = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
const script = (p) => path.join(p, 'skills', 'ccfind', 'scripts', 'ccfind.mjs');

let target = FALLBACK;
try {
  const reg = JSON.parse(fs.readFileSync(REG, 'utf8'));
  const rows = Object.entries(reg.plugins || {})
    .filter(([k]) => k === 'ccfind' || k.startsWith('ccfind@'))
    .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
    .filter((r) => r && r.installPath)
    .sort((a, b) => String(a.lastUpdated || '').localeCompare(String(b.lastUpdated || '')));
  for (const r of rows) if (fs.existsSync(script(r.installPath))) target = script(r.installPath);
} catch { /* no registry - fall back to the path this launcher was installed from */ }

if (!fs.existsSync(target)) {
  console.error('ccfind: plugin files not found at ' + target);
  console.error('reinstall the plugin, then run: ccfind install');
  process.exit(1);
}
// A dynamic import resolves an ES module from CommonJS; top-level await does not
// exist here, so failures are reported through the rejection instead.
import(pathToFileURL(target).href).catch((err) => {
  console.error(err);
  process.exit(1);
});
`;

  if (cmd === 'uninstall') {
    let st = null;
    try { st = fs.lstatSync(link); } catch { console.log(`nothing at ${link}`); process.exit(0); }
    const ours = st.isSymbolicLink()
      ? fs.readlinkSync(link).endsWith('ccfind.mjs')            // 0.6.0 and earlier
      : (() => { try { return fs.readFileSync(link, 'utf8').includes(MARK); } catch { return false; } })();
    if (!ours) {
      console.error(`ccfind: ${link} was not written by ccfind - leaving it alone`);
      process.exit(1);
    }
    fs.unlinkSync(link);
    console.log(`removed ${link}`);
  } else {
    fs.mkdirSync(dir, { recursive: true });
    let st = null;
    try { st = fs.lstatSync(link); } catch { /* free */ }
    if (st && !st.isSymbolicLink()) {
      let mine = false;
      try { mine = fs.readFileSync(link, 'utf8').includes(MARK); } catch { /* binary or unreadable */ }
      if (!mine) {
        console.error(`ccfind: ${link} already exists and was not written by ccfind - not touching it`);
        process.exit(1);
      }
    }
    if (st) fs.unlinkSync(link);
    fs.writeFileSync(link, launcher(self), { mode: 0o755 });
    console.log(`installed: ${link}`);
    console.log(`  resolves to the installed plugin, currently ${shortPath(self)}`);
    if (!onPath.includes(dir)) {
      // The startup file to append to is the one the user's own shell reads.
      // Naming ~/.zshrc to someone running bash sends them to edit a file that
      // is never sourced, and the command then still does not exist - which
      // looks like the launcher failed rather than like the wrong advice it is.
      const sh = path.basename(process.env.SHELL || '');
      const line = `export PATH="${dir}:$PATH"`;
      console.log(`\n${dir} is not on your PATH. Add it:`);
      if (sh === 'fish') {
        console.log(`  fish_add_path ${dir}`);
      } else if (sh === 'bash') {
        // macOS terminals start login shells, which read ~/.bash_profile and
        // ignore ~/.bashrc; Linux ones are interactive non-login and do the
        // opposite.
        const rc = process.platform === 'darwin' ? '~/.bash_profile' : '~/.bashrc';
        console.log(`  echo '${line}' >> ${rc} && exec bash`);
      } else if (sh === 'zsh' || !sh) {
        console.log(`  echo '${line}' >> ~/.zshrc && exec zsh`);
      } else {
        console.log(`  ${line}`);
        console.log(`  put that line in ${sh}'s startup file to make it stick`);
      }
    } else {
      console.log('run it as: ccfind pick "<query>"');
    }
  }
} else if (cmd === 'open') {
  // "Open it" for real. `/resume <id>` switches the window it is typed in, but
  // nothing a plugin can call switches the active session, so the only honest
  // way to open a session from inside one is a new terminal window running
  // `claude --resume`. Working directory is the session's own cwd, so relative
  // paths in it still mean what they meant.
  const want = args._[1];
  if (!want) { console.error('usage: ccfind.mjs open <session-id>'); process.exit(1); }
  const idx = readIndex();
  if (!idx) { console.error('no index - run: ccfind.mjs index'); process.exit(1); }
  const ses = idx.sessions.find((x) => x.id.startsWith(want));
  if (!ses) { console.error(`ccfind: no session starting with ${want}`); process.exit(1); }
  // The id lands unquoted in a shell command below. It is a transcript's file
  // name, so a stray file with metacharacters in its name must stop here rather
  // than run inside the new window.
  if (!/^[A-Za-z0-9._-]+$/.test(ses.id)) { console.error(`ccfind: refusing to launch: session id ${JSON.stringify(ses.id)} is not a plain file name`); process.exit(1); }
  const cwd = ses.cwd && fs.existsSync(ses.cwd) ? ses.cwd : HOME;
  const inner = `cd ${JSON.stringify(cwd)} && claude --resume ${ses.id}`;
  // The same command wrapped so a Linux emulator still confirms closing the
  // window. Two things are needed and neither is enough alone. `set -m` turns on
  // job control, which puts `claude` in its own process group: a VTE terminal
  // decides whether anything is running by comparing the pty's foreground process
  // group with the process it spawned, and without job control `claude` shares the
  // shell's group, the two match, and the first click on the close button ends the
  // session with no prompt - while every other window of the same terminal asks.
  // The trailing `exit $?` is what keeps a shell there to own that group at all:
  // a shell handed `-c` replaces itself with the last command rather than forking
  // it, job control or not, so without the builtin `claude` simply becomes the
  // terminal's own process again. The exit status is still `claude`'s.
  //
  // Not on macOS: `do script` types the command into a new window's *interactive*
  // shell, which already has job control and stays at a prompt when `claude`
  // quits, so Terminal and iTerm warn on their own - and exiting that shell would
  // close a window the user was meant to keep. Not in tmux either: `kill-window`
  // never asks.
  const guiInner = `set -m; ${inner}; exit $?`;

  // Ordered by how little it surprises the user: their own multiplexer first,
  // then the terminal they are actually in, then anything installed.
  const emulators = () => {
    if (process.env.TMUX) return [['tmux', ['new-window', '-n', 'ccfind', 'sh', '-lc', inner]]];
    if (process.platform === 'darwin') {
      const app = process.env.TERM_PROGRAM === 'iTerm.app' ? 'iTerm' : 'Terminal';
      const script = app === 'iTerm'
        ? `tell application "iTerm" to tell current window to create tab with default profile command "sh -lc ${inner.replace(/["\\]/g, '\\$&')}"`
        : `tell application "Terminal" to do script ${JSON.stringify(inner)}`;
      return [['osascript', ['-e', script]], ['osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(inner)}`]]];
    }
    // xdg-terminal-exec first: it is the freedesktop dispatcher and honours the
    // terminal the user actually chose, which no hard-coded list can know. The
    // rest are the emulators that ship as a desktop's default, newest first -
    // ptyxis is GNOME's since Fedora 41, kgx (GNOME Console) before that, and a
    // box with neither still has gnome-terminal.
    const linux = [['xdg-terminal-exec', ['sh', '-lc', guiInner]],
                   ['x-terminal-emulator', ['-e', 'sh', '-lc', guiInner]],
                   ['ptyxis', ['--', 'sh', '-lc', guiInner]],
                   ['kgx', ['--', 'sh', '-lc', guiInner]],
                   ['gnome-terminal', ['--', 'sh', '-lc', guiInner]],
                   ['konsole', ['-e', 'sh', '-lc', guiInner]],
                   ['foot', ['sh', '-lc', guiInner]],
                   ['kitty', ['sh', '-lc', guiInner]],
                   ['wezterm', ['start', '--', 'sh', '-lc', guiInner]],
                   ['alacritty', ['-e', 'sh', '-lc', guiInner]],
                   ['terminator', ['-x', 'sh', '-lc', guiInner]],
                   ['xfce4-terminal', ['-x', 'sh', '-lc', guiInner]],
                   ['xterm', ['-e', 'sh', '-lc', guiInner]]];
    return process.env.TERMINAL ? [[process.env.TERMINAL, ['-e', 'sh', '-lc', guiInner]], ...linux] : linux;
  };

  if (process.env.CCFIND_OPEN_DRYRUN) {
    for (const [c, a] of emulators()) console.log([c, ...a].map((x) => JSON.stringify(x)).join(' '));
    process.exit(0);
  }
  // `osascript` is the tool, not the thing the user sees - name the app.
  const label = (c) => (c !== 'osascript' ? c
    : process.env.TERM_PROGRAM === 'iTerm.app' ? 'iTerm' : 'Terminal');
  // Two shapes of terminal, and the difference matters here. A client-server
  // one (ptyxis, gnome-terminal, kgx) hands the request to its already-running
  // instance and exits 0 in a few hundred ms. A foreground one (kitty, foot,
  // xterm) *is* the window: it does not exit while the window is open. So
  // spawnSync would block this process for as long as the user keeps the window
  // around - and `open` is run from inside a tool call, which would hang with
  // it. Asynchronous instead, with three outcomes: an early exit 0 means the
  // window is up, an early non-zero exit or a spawn error means try the next
  // candidate, and still running after the grace period means it is a
  // foreground terminal that opened fine, so let go of it and stop.
  const GRACE_MS = posInt(process.env.CCFIND_OPEN_GRACE_MS, 700);
  const launch = (c, a) => new Promise((resolve) => {
    let child;
    try { child = spawn(c, a, { stdio: 'ignore', detached: true, env: cleanEnv() }); }
    catch { resolve(false); return; }
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
    // unref so this process can exit while the terminal it opened keeps running.
    const timer = setTimeout(() => { child.unref(); done(true); }, GRACE_MS);
    child.on('error', () => done(false));
    // A null code means killed by a signal, which is not an opened window.
    child.on('exit', (code) => done(code === 0));
  });
  let opened = null;
  for (const [c, a] of emulators()) {
    if (await launch(c, a)) { opened = c; break; }
  }
  if (opened) {
    console.log(`opened ${ses.title || ses.id.slice(0, 8)} in a new ${label(opened)} window`);
    console.log(`  ${cwd}`);
  } else {
    console.error('ccfind: could not open a terminal window here.');
    console.error(`switch this window instead:  /resume ${ses.id}`);
    console.error(`or run:  ${inner}`);
    process.exit(1);
  }
} else if (cmd === 'pick') {
  // Arrow-key picker for a real terminal. Inside Claude Code a skill cannot take
  // over the screen, so this is the only place where "select it and open it" can
  // literally mean that: Enter hands the terminal to `claude --resume`.
  const q = args._.slice(1).join(' ');
  if (!q) { console.error('usage: ccfind.mjs pick <query> [--limit N] [--all]'); process.exit(1); }
  const limit = posInt(args.limit, 15);
  const all = !!args.all;
  let res;
  try {
    res = search(q, { limit, group: 'session', all });
  } catch (e) { console.error(`ccfind: ${e.message}`); process.exit(1); }
  if (!res.hits.length) { console.error(`nothing matched: ${res.terms.join(' ')}`); process.exit(1); }

  const dry = !!process.env.CCFIND_PICK_DRYRUN;
  const open = (h) => {
    if (dry) { console.log(h.resume); process.exit(0); }
    const r = spawnSync('claude', ['--resume', h.session], { stdio: 'inherit', env: cleanEnv() });
    if (r.error) {
      console.error(`ccfind: could not run claude (${r.error.message})`);
      console.error(h.resume);
      process.exit(1);
    }
    process.exit(r.status ?? 0);
  };

  // A key script in CCFIND_PICK_KEYS is fed to the same handler a terminal feeds,
  // which is how the filter gets tested without a pseudo-terminal: `\e` is Escape,
  // `\r` is Enter, `\b` is Backspace (DEL, 0x7f - what a modern keyboard sends), `\xNN` is that byte, and every other
  // character is itself.
  const keyScript = process.env.CCFIND_PICK_KEYS
    ? process.env.CCFIND_PICK_KEYS
        .replace(/\\e/g, '\u001b').replace(/\\r/g, '\r').replace(/\\b/g, '\u007f')
        .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    : '';

  // No tty means no arrows: print the list and the commands rather than pretending.
  if (!keyScript && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    human(res);
    process.exit(0);
  }

  const ESC = '\u001b';
  let rows = res.hits;
  let query = q;
  let cur = 0;
  const w = () => Math.min(Math.max(process.stdout.columns || 80, 60), 120);
  const trunc = (t, n) => (t && t.length > n ? t.slice(0, n - 1) + '…' : t || '');

  // Rows visible at once: the terminal height minus the header and the detail
  // pane, so a 13-hit list on a 24-row window scrolls instead of eating its own
  // header. `top` is the first visible row and follows the cursor in draw().
  let top = 0;
  // The filter line is drawn under the list, and the list gives up two rows to
  // it, so the screen row a click lands on keeps meaning the same row either way.
  let filtering = false, buf = '', saved = null;
  const viewport = () => Math.max(3, Math.min(Math.max(rows.length, 1),
    (process.stdout.rows || 24) - 9 - (filtering ? 2 : 0)));

  // Every keystroke inside the filter re-runs the search. The index is already
  // in memory by then, so that costs a few milliseconds and reads no file.
  // An empty filter matches nothing, which is a state the screen has to survive:
  // no cursor, no detail pane, and Enter opening nothing.
  const requery = (text) => {
    let r;
    try { r = search(text, { limit, group: 'session', all }); } catch { return; }
    res = r; rows = r.hits; query = text;
    cur = rows.length ? Math.min(cur, rows.length - 1) : 0;
    top = 0;
  };
  const step = (d) => { if (rows.length) cur = (cur + d + rows.length) % rows.length; };

  let quiet = false;
  const draw = () => {
    if (quiet) return;
    const width = w();
    const vp = viewport();
    if (cur < top) top = cur;
    if (cur >= top + vp) top = cur - vp + 1;
    if (top > rows.length - vp) top = Math.max(0, rows.length - vp);
    let out = `${ESC}[2J${ESC}[H`;
    out += `ccfind: ${res.total} session${res.total === 1 ? '' : 's'} match "${query}"` +
           `${res.total > rows.length ? `, showing ${rows.length}` : ''}` +
           `${rows.length > vp ? `  [${cur + 1}/${rows.length}]` : ''}\n`;
    out += filtering
      ? `${ESC}[2m type to filter, enter to keep it, esc to put the old list back${ESC}[0m\n\n`
      : `${ESC}[2m up/down or click to move, / to filter, enter to resume, q to quit${ESC}[0m\n\n`;
    rows.slice(top, top + vp).forEach((h, k) => {
      const i = top + k;
      const when = h.when ? h.when.slice(0, 10) : '          ';
      const label = `${when}  ${trunc(h.title || h.project, width - 34)}`;
      const score = String(h.score).padStart(7);
      out += i === cur
        ? `${ESC}[7m > ${label.padEnd(width - 12)}${score} ${ESC}[0m\n`
        : `   ${label.padEnd(width - 12)}${ESC}[2m${score}${ESC}[0m\n`;
    });
    if (!rows.length) out += `${ESC}[2m   nothing matches${ESC}[0m\n`;
    if (rows.length > vp) {
      const above = top, below = rows.length - top - vp;
      out += `${ESC}[2m   ${above ? `${above} above` : ''}${above && below ? ', ' : ''}` +
             `${below ? `${below} below` : ''}${ESC}[0m\n`;
    }
    const h = rows[cur];
    if (h) {
      out += `\n${ESC}[2m${'-'.repeat(width - 2)}${ESC}[0m\n`;
      out += `${shortPath(h.cwd) || h.project}${h.branch ? '  ' + h.branch : ''}` +
             `${h.turns ? `  ${h.turns} turns` : ''}\n`;
      if (h.opening) out += `${ESC}[2mbegan:${ESC}[0m ${trunc(h.opening, w() - 8)}\n`;
      if (h.prompt && h.prompt !== '(session start)')
        out += `${ESC}[2masked:${ESC}[0m ${trunc(h.prompt, w() - 8)}\n`;
      out += `${ESC}[2m${h.field}:${ESC}[0m ${trunc(h.snippet.replace(/\s+/g, ' '), w() - 8)}\n`;
    }
    if (filtering) out += `\n${ESC}[2mfilter:${ESC}[0m ${buf}${ESC}[7m ${ESC}[0m\n`;
    process.stdout.write(out);
  };

  // Mouse: SGR tracking (1006) on top of normal button tracking (1000), so a
  // click can select a row and the wheel can scroll. It must be turned back off
  // on every exit path - left on, it eats the terminal's own text selection.
  const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`, MOUSE_OFF = `${ESC}[?1000l${ESC}[?1006l`;
  // Rows start on the 4th screen line: header, hint, blank, then the list.
  const FIRST_ROW = 4;

  // Raw mode only exists when a terminal is on the other end, so a replayed key
  // script has to be able to leave without touching it.
  let raw = false;
  const leave = (fn) => {
    if (raw) {
      process.stdin.setRawMode(false);
      process.stdout.write(`${MOUSE_OFF}${ESC}[2J${ESC}[H`);
    }
    fn();
  };
  // One chunk can carry several keys - held arrows, or a terminal that batches -
  // so consume the whole buffer instead of comparing it to one sequence, which
  // silently drops every keypress after the first.
  const onKeys = (chunk) => {
    let s = chunk, moved = false;
    while (s.length) {
      // SGR mouse report: ESC [ < button ; col ; row (M press | m release)
      const mouse = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s);
      if (mouse) {
        const [, btn, , rowStr, kind] = mouse;
        const b = +btn, row = +rowStr;
        s = s.slice(mouse[0].length);
        if (b === 64) { step(-1); moved = true; continue; }  // wheel up
        if (b === 65) { step(1); moved = true; continue; }   // wheel down
        if (kind !== 'M' || b !== 0) continue;               // release, or not the left button
        const hit = top + (row - FIRST_ROW);
        if (hit < 0 || hit >= rows.length || row < FIRST_ROW) continue;   // clicked outside the list
        if (hit === cur) return leave(() => open(rows[cur]));             // click the highlighted row to open it
        cur = hit; moved = true;
        continue;
      }
      const three = s.slice(0, 3);
      if (three === `${ESC}[A` || three === `${ESC}OA`) { step(-1); moved = true; s = s.slice(3); continue; }
      if (three === `${ESC}[B` || three === `${ESC}OB`) { step(1); moved = true; s = s.slice(3); continue; }
      const k = s[0];
      s = s.slice(1);
      if (filtering) {
        // The escape sequences above are matched first, so an arrow key moves the
        // cursor here too instead of typing itself into the buffer. Anything from
        // U+0020 up is a character the query can hold, Cyrillic included.
        if (k === '\r' || k === '\n') { filtering = false; saved = null; moved = true; }
        else if (k === ESC) { ({ res, rows, query, cur, top } = saved); filtering = false; saved = null; moved = true; }
        else if (k === '\u0003') return leave(() => process.exit(0));
        else if (k === '\u007f' || k === '\u0008') { buf = buf.slice(0, -1); requery(buf); moved = true; }
        else if (k === '\u0015') { buf = ''; requery(buf); moved = true; }  // ctrl-u clears the line
        else if (k.codePointAt(0) >= 32) { buf += k; requery(buf); moved = true; }
        continue;
      }
      if (k === 'k') { step(-1); moved = true; }
      else if (k === 'j') { step(1); moved = true; }
      // `/` opens the filter on the query that is already showing, so a search can
      // be narrowed in place instead of quitting and running ccfind again.
      else if (k === '/') { saved = { res, rows, query, cur, top }; filtering = true; buf = query; moved = true; }
      else if (k === '\r' || k === '\n') { if (rows.length) return leave(() => open(rows[cur])); }
      else if (k === 'q' || k === '\u0003' || k === ESC) return leave(() => process.exit(0));
    }
    if (moved) draw();
  };

  if (keyScript) {
    // Replaying keys with the screen off: what a test reads is the state the keys
    // left behind, printed once the script runs out.
    quiet = true;
    onKeys(keyScript);
    console.log(`filter: ${query}`);
    console.log(rows.length ? rows[cur].resume : '(no match)');
    process.exit(0);
  }

  raw = true;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdout.write(MOUSE_ON);
  process.on('exit', () => { try { process.stdout.write(MOUSE_OFF); } catch { /* closed */ } });
  draw();
  process.stdin.on('data', onKeys);
} else if (cmd === 'bench') {
  const queries = args._.slice(1);
  if (!queries.length) { console.error('bench needs queries'); process.exit(1); }
  readIndex();
  for (const q of queries) {
    const t = Date.now();
    const r = search(q, { limit: 1 });
    const ms = Date.now() - t;
    const h = r.hits[0];
    console.log(`${JSON.stringify(q).padEnd(30)} ${String(ms).padStart(5)}ms  ${String(r.sessionsScored).padStart(3)} sess  top=${h ? String(h.score).padStart(7) : '      -'}  ${h ? (h.title || h.project) : '(none)'}`);
  }
} else {
  const q = (cmd === 'search' ? args._.slice(1) : args._).join(' ');
  if (!q) {
    console.error('usage: ccfind.mjs search <query> [--limit N] [--group session|exchange]');
    console.error('                              [--project S] [--session ID] [--days N] [--field F]');
    console.error('                              [--exclude ID[,ID...]] [--self] [--all] [--json]');
    process.exit(1);
  }
  // A garbled --days used to disable the filter silently (NaN is falsy) and a
  // negative one silently matched nothing. Both now mean "no date filter", and
  // say so on stderr so stdout stays clean JSON.
  const days = posNum(args.days, null);
  if (args.days !== undefined && days === null) {
    console.error(`ccfind: ignoring --days ${args.days} - not a positive number of days`);
  }
  let res;
  try {
    res = search(q, {
      limit: posInt(args.limit, 10),
      group: typeof args.group === 'string' ? args.group : 'session',
      project: typeof args.project === 'string' ? args.project : null,
      session: typeof args.session === 'string' ? args.session : null,
      field: typeof args.field === 'string' ? args.field : null,
      // The session doing the searching is never the answer to its own question.
      // Comma-separated so a caller can drop several known-irrelevant sessions at
      // once (a benchmark excluding its own scratch runs, a retry of a bad session).
      // --self lifts only the automatic self-exclusion; an explicit --exclude
      // list stays honored either way.
      exclude: [...(typeof args.exclude === 'string' ? args.exclude.split(',') : []),
                ...(args.self ? [] : [process.env.CLAUDE_CODE_SESSION_ID || null,
                                      process.env.CLAUDE_SESSION_ID || null])]
               .map((s) => s && s.trim()).filter(Boolean),
      days,
      // Everything BM25 scored, gate and all. For "did I ever mention X at all",
      // where a single passing reference is the answer.
      all: !!args.all,
    });
  } catch (e) {
    // A typo in a flag or a missing index is a usage problem, not a crash.
    console.error(`ccfind: ${e.message}`);
    process.exit(1);
  }
  if (args.json) console.log(JSON.stringify(res, null, 2));
  else human(res);
}
