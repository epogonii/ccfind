#!/usr/bin/env node
// ccfind - BM25 full-text search over local Claude Code transcripts.
// Subcommands: index, search, stats, bench
// No network calls. Reads ~/.claude/projects/*/*.jsonl, writes ~/.claude/ccfind/.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import zlib from 'node:zlib';

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
const STORE = path.join(HOME, '.claude', 'ccfind');
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
  // `/ccfind где мы разбирались с coredns` - the words inside the tag are the
  // user's actual question. Dropping the whole element threw away the prompt of
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
  // v0.1 rebuilds whole corpus on any change: 90 MB takes ~2 s, and a correct
  // incremental merge is only worth writing once the on-disk format settles.

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
      let xt = exchanges.findIndex((x) => x.si === si);
      if (xt === -1) {
        exchanges.push({ si, t: sessions[si].title, ts: sessions[si].first, n: 0 });
        xt = exchanges.length - 1;
      }
      pushDoc(xt, 'title', sessions[si].title, sessions[si].first, false);
    }
    sessions[si].n = exchanges.filter((x) => x.si === si).length;
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
// Coverage is weighted by idf squared, not by term count. "image-gc-high порог
// на ноде" is answered by the one session containing the identifier, even though
// it never says "порог". Plain idf is not enough: three ordinary words still
// out-sum one rare identifier. Squaring makes the rarest term of a query
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
  const empty = { terms: full, hits: [], docsScored: 0, exchangesScored: 0, sessionsScored: 0 };
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

  const hits = groups.slice(0, limit).map((g) => {
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
      resume: `claude --resume ${s.id}`,
    };
  });
  return { terms: full, group, hits, total: groups.length, docsScored: scores.size,
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
  console.log(res.hits.length < total
    ? `best ${res.hits.length} of ${total} matching ${unit}s:\n`
    : `${total} matching ${unit}${total === 1 ? '' : 's'}:\n`);
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
    console.log(`   resume it: ${h.resume}\n`);
  }
  const more = (res.total || res.hits.length) - res.hits.length;
  if (more > 0) console.log(`${more} more matched but were not shown - re-run with --limit ${res.total}`);
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
  const cap = args.turns ? +args.turns : 40;
  const shown = turns.slice(0, cap);
  if (args.json) {
    console.log(JSON.stringify({
      session: ses.id, title: ses.title, project: ses.project, cwd: ses.cwd,
      branch: ses.branch, first: ses.first, last: ses.last, turns: turns.length,
      shown: shown.map((x) => ({ when: x.ts, prompt: x.t })),
      resume: `claude --resume ${ses.id}`,
    }, null, 2));
  } else {
    const width = Math.min(Math.max(process.stdout.columns || 88, 60), 100);
    const day = (t) => (t ? t.slice(0, 16).replace('T', ' ') : '?');
    console.log(`${ses.title || ses.project}`);
    console.log(`${day(ses.first)} to ${day(ses.last)}  ${shortPath(ses.cwd) || ses.project}` +
                `${ses.branch ? '  ' + ses.branch : ''}  ${turns.length} turn${turns.length === 1 ? '' : 's'}`);
    console.log(`resume it: claude --resume ${ses.id}\n`);
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
    console.error('                              [--exclude ID[,ID...]] [--self] [--json]');
    process.exit(1);
  }
  let res;
  try {
    res = search(q, {
      limit: args.limit ? +args.limit : 10,
      group: typeof args.group === 'string' ? args.group : 'session',
      project: typeof args.project === 'string' ? args.project : null,
      session: typeof args.session === 'string' ? args.session : null,
      field: typeof args.field === 'string' ? args.field : null,
      // The session doing the searching is never the answer to its own question.
      // Comma-separated so a caller can drop several known-irrelevant sessions at
      // once (a benchmark excluding its own scratch runs, a retry of a bad session).
      exclude: args.self ? null : [...(typeof args.exclude === 'string' ? args.exclude.split(',') : []),
                                   process.env.CLAUDE_CODE_SESSION_ID || null,
                                   process.env.CLAUDE_SESSION_ID || null]
                                  .map((s) => s && s.trim()).filter(Boolean),
      days: args.days ? +args.days : null,
    });
  } catch (e) {
    // A typo in a flag or a missing index is a usage problem, not a crash.
    console.error(`ccfind: ${e.message}`);
    process.exit(1);
  }
  if (args.json) console.log(JSON.stringify(res, null, 2));
  else human(res);
}
