// mend: one patch tool for every AI edit format (SPEC.md version 1, MIT).
// Node 22, standard library only; run as `node main.ts [options] [PATCH]`.
// Reads unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A
// patches (section 8) and JSON edits (section 9), finds each edit's old
// lines at the first of three matching tiers (section 5), and changes every
// file or none (section 10). In a trial the grader runs `node /bot/main.ts`
// with MAKEFUN_ENV_URL set, and this file hands over to runner.ts (the last
// lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in order, as [old, new] pairs (for `R` output lines). */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file as lines: its line break, its lines, and whether it ends with a break (section 3). */
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** A line normalised for one matching tier (section 5). */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trimEndWs(s);
  return trimWs(s);
}

/** Every 0-based position where O occurs in lines at one tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length - from) return out;
  const want = o.map((l) => normLine(l, tier));
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 with --strict) at which O occurs at least once, from `from`. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrences(lines, o, tier, from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** One line of a replacement: its text, and whether it is a context line. */
interface RLine {
  text: string;
  ctx: boolean;
}

/**
 * The lines that replace the k matched lines (section 5): a context line is
 * written as the file's own matched line, never the patch's; at tier 2 every
 * other line is re-indented from O's first line's leading whitespace to the
 * file's first matched line's; at tiers 0 and 1 lines are written as they are.
 */
function buildReplacement(fileLines: string[], pos: number, o: RLine[], n: RLine[], tier: number): string[] {
  const f = leadingWs(fileLines[pos]!);
  const p = leadingWs(o[0]!.text);
  const oCtx: number[] = [];
  o.forEach((l, j) => {
    if (l.ctx) oCtx.push(j);
  });
  let seenCtx = 0;
  return n.map((l) => {
    if (l.ctx) {
      const at = fileLines[pos + oCtx[seenCtx]!]!;
      seenCtx += 1;
      return at;
    }
    if (tier !== 2) return l.text;
    if (/^[ \t]*$/.test(l.text)) return l.text;
    if (l.text.startsWith(p)) return f + l.text.slice(p.length);
    return l.text;
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: Array<{ kind: string; text: string }>;
}

interface UniSection {
  oldP: string | null;
  newP: string | null;
  renOld: string | null;
  renNew: string | null;
  gitOld: string | null;
  gitNew: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, spaces removed, a/ or b/ stripped. */
function headerPath(line: string): string {
  const cut = line.slice(4).split('\t')[0]!;
  const p = cut.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Whether a `\` line follows the hunk body's last context or `+` line. */
function backslashAfterLast(body: Hunk['body']): boolean {
  let last = -1;
  body.forEach((b, i) => {
    if (b.kind === ' ' || b.kind === '+') last = i;
  });
  return last >= 0 && body[last + 1] !== undefined && body[last + 1]!.kind === '\\';
}

/** O and N of a hunk body, in body order, with context flags (section 6). */
function hunkON(body: Hunk['body']): { o: RLine[]; n: RLine[] } {
  const o: RLine[] = [];
  const n: RLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      o.push({ text: b.text, ctx: true });
      n.push({ text: b.text, ctx: true });
    } else if (b.kind === '-') o.push({ text: b.text, ctx: false });
    else if (b.kind === '+') n.push({ text: b.text, ctx: false });
  }
  return { o, n };
}

/** Apply a section's hunks in order to a file's text; throws Fail on a hunk failure. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const st = splitFile(text);
  let lines = [...st.lines];
  let final = st.final;
  let d = 0;
  for (const hunk of hunks) {
    const { o, n } = hunkON(hunk.body);
    const noNl = backslashAfterLast(hunk.body);
    if (o.length === 0) {
      if (n.length === 0) continue;
      const at = Math.max(0, Math.min(hunk.a + d, lines.length));
      const ins = n.map((l) => l.text);
      const atEnd = at === lines.length;
      lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
      if (atEnd) final = !noNl;
      d += n.length;
      continue;
    }
    const found = findTier(lines, o.map((l) => l.text), strict);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let pos = found.occ[0]!;
    for (const cur of found.occ) {
      if (Math.abs(cur - target) < Math.abs(pos - target)) pos = cur;
    }
    const repl = buildReplacement(lines, pos, o, n, found.tier);
    const toEnd = pos + o.length === lines.length;
    lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + o.length)];
    if (toEnd) final = !noNl;
    d += n.length - o.length;
  }
  return joinFile(lines, st.br, final);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let current: UniSection | null = null;
  let inHeader = false;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:$| )/;
  const gitRe = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = gitRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      current = { oldP: null, newP: null, renOld: null, renNew: null, gitOld: m[1]!, gitNew: m[2]!, create: false, del: false, hunks: [] };
      sections.push(current);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        const oldP = headerPath(line);
        const newP = headerPath(next);
        if (current !== null && inHeader) {
          current.oldP = oldP;
          current.newP = newP;
        } else {
          current = { oldP, newP, renOld: null, renNew: null, gitOld: null, gitNew: null, create: false, del: false, hunks: [] };
          sections.push(current);
          inHeader = true;
        }
        i += 2;
        continue;
      }
      if (current !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (current === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const body: Hunk['body'] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          if (l === '') body.push({ kind: ' ', text: '' });
          else body.push({ kind: l[0]!, text: l.slice(1) });
          j += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
      current.hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }
    if (current !== null && inHeader) {
      if (line.startsWith('rename from ')) current.renOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) current.renNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) current.create = true;
      else if (line.startsWith('deleted file mode')) current.del = true;
    }
    i += 1;
  }
  return sections.map((s) => {
    const oldRaw = s.oldP ?? s.renOld ?? s.gitOld ?? '';
    const newRaw = s.newP ?? s.renNew ?? s.gitNew ?? '';
    const isCreate = oldRaw === '/dev/null' || s.create;
    const isDelete = !isCreate && (newRaw === '/dev/null' || s.del);
    if (isCreate) {
      return (tree: Tree) => {
        if (!safe(newRaw)) throw new Fail('unsafe', newRaw);
        if (tree.get(newRaw) !== null) throw new Fail('exists', newRaw);
        const plus: string[] = [];
        s.hunks.forEach((h) => {
          h.body.forEach((b) => {
            if (b.kind === '+') plus.push(b.text);
          });
        });
        // A created file ends with a line break unless a `\` line follows its last `+` line.
        let lastPlusBackslash = false;
        for (let hi = s.hunks.length - 1; hi >= 0; hi -= 1) {
          const h = s.hunks[hi]!;
          let lastPlus = -1;
          h.body.forEach((b, bi) => {
            if (b.kind === '+') lastPlus = bi;
          });
          if (lastPlus >= 0) {
            lastPlusBackslash = h.body[lastPlus + 1] !== undefined && h.body[lastPlus + 1]!.kind === '\\';
            break;
          }
        }
        let text = '';
        if (plus.length > 0) {
          text = plus.join('\n') + (lastPlusBackslash ? '' : '\n');
        }
        tree.now.set(newRaw, text);
      };
    }
    if (isDelete) {
      return (tree: Tree) => {
        if (!safe(oldRaw)) throw new Fail('unsafe', oldRaw);
        if (tree.get(oldRaw) === null) throw new Fail('missing', oldRaw);
        tree.now.set(oldRaw, null);
      };
    }
    if (oldRaw !== newRaw) {
      return (tree: Tree) => {
        if (!safe(oldRaw)) throw new Fail('unsafe', oldRaw);
        if (!safe(newRaw)) throw new Fail('unsafe', newRaw);
        const before = tree.get(oldRaw);
        if (before === null) throw new Fail('missing', oldRaw);
        if (tree.get(newRaw) !== null) throw new Fail('exists', newRaw);
        const out = applyHunks(before, s.hunks, strict, oldRaw);
        tree.now.set(oldRaw, null);
        tree.now.set(newRaw, out);
        tree.moves.push([oldRaw, newRaw]);
      };
    }
    return (tree: Tree) => {
      if (!safe(oldRaw)) throw new Fail('unsafe', oldRaw);
      const before = tree.get(oldRaw);
      if (before === null) throw new Fail('missing', oldRaw);
      tree.now.set(oldRaw, applyHunks(before, s.hunks, strict, oldRaw));
    };
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let from = 0;
  for (;;) {
    let searchIdx = -1;
    for (let j = from; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        searchIdx = j;
        break;
      }
    }
    if (searchIdx < 0) break;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (!blank(l) && !l.trim().startsWith('```')) {
        path = l.trim();
        break;
      }
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eqIdx = -1;
    for (let k = searchIdx + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eqIdx = k;
        break;
      }
    }
    if (eqIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let endIdx = -1;
    for (let m = eqIdx + 1; m < lines.length; m += 1) {
      if (lines[m]!.trimEnd() === '>>>>>>> REPLACE') {
        endIdx = m;
        break;
      }
    }
    if (endIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, endIdx);
    const p = path;
    edits.push((tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const st = splitFile(before);
      const found = findTier(st.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length !== 1) throw new Fail('ambiguous', p);
      const o: RLine[] = oldLines.map((t) => ({ text: t, ctx: false }));
      const n: RLine[] = newLines.map((t) => ({ text: t, ctx: false }));
      const pos = found.occ[0]!;
      const repl = buildReplacement(st.lines, pos, o, n, found.tier);
      const linesOut = [...st.lines.slice(0, pos), ...repl, ...st.lines.slice(pos + oldLines.length)];
      tree.now.set(p, joinFile(linesOut, st.br, st.final));
    });
    prevPath = p;
    prevEnd = endIdx;
    from = endIdx + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  lines: Array<{ text: string; num: number }>;
  moveTo: string | null;
  chunks: V4aChunk[];
}

function isSectionStart(line: string): boolean {
  return line.startsWith('*** Add File:') || line.startsWith('*** Delete File:') || line.startsWith('*** Update File:');
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: V4aSection['kind'] | null = null;
    let path = '';
    if (line.startsWith('*** Add File:')) {
      kind = 'add';
      path = line.slice(13).trim();
    } else if (line.startsWith('*** Delete File:')) {
      kind = 'delete';
      path = line.slice(16).trim();
    } else if (line.startsWith('*** Update File:')) {
      kind = 'update';
      path = line.slice(16).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startNo = i + 1;
    const raw: Array<{ text: string; num: number }> = [];
    let j = i + 1;
    while (j < last && !isSectionStart(lines[j]!)) {
      raw.push({ text: lines[j]!, num: j + 1 });
      j += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    const sec: V4aSection = { kind, path, lineNo: startNo, lines: raw, moveTo: null, chunks: [] };
    if (kind === 'add') {
      for (const r of raw) {
        if (r.text.startsWith('+') || r.text === '') continue;
        throw new Exit2(`error: parse ${r.num}`);
      }
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.num}`);
      }
    } else {
      let k = 0;
      if (k < raw.length && raw[k]!.text.startsWith('*** Move to:')) {
        sec.moveTo = raw[k]!.text.slice(12).trim();
        k += 1;
      }
      let cur: V4aChunk | null = null;
      const push = (): void => {
        if (cur !== null) {
          sec.chunks.push(cur);
          cur = null;
        }
      };
      while (k < raw.length) {
        const r = raw[k]!;
        if (r.text === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.num}`);
          cur.eof = true;
          push();
          k += 1;
        } else if (r.text.startsWith('@@')) {
          push();
          const anchor = r.text.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          k += 1;
        } else if (r.text.startsWith('*** ')) {
          throw new Exit2(`error: parse ${r.num}`);
        } else if (r.text === '' || r.text[0] === ' ' || r.text[0] === '-' || r.text[0] === '+') {
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          cur.body.push(r.text);
          k += 1;
        } else {
          throw new Exit2(`error: parse ${r.num}`);
        }
      }
      push();
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
    }
    sections.push(sec);
    i = j;
  }
  return sections.map((sec) => {
    if (sec.kind === 'add') {
      const fileLines = sec.lines.map((r) => (r.text === '' ? '' : r.text.slice(1)));
      return (tree: Tree) => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.now.set(sec.path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
      };
    }
    if (sec.kind === 'delete') {
      return (tree: Tree) => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
      };
    }
    const moveTo = sec.moveTo;
    return (tree: Tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const before = tree.get(sec.path);
      if (before === null) throw new Fail('missing', sec.path);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const out = applyV4aChunks(before, sec.chunks, strict, sec.path);
      if (moveTo !== null) {
        tree.now.set(sec.path, null);
        tree.now.set(moveTo, out);
        tree.moves.push([sec.path, moveTo]);
      } else {
        tree.now.set(sec.path, out);
      }
    };
  });
}

/** Apply V4A chunks in order with the cursor (section 8); throws Fail on a chunk failure. */
function applyV4aChunks(text: string, chunks: V4aChunk[], strict: boolean, path: string): string {
  const st = splitFile(text);
  const lines = [...st.lines];
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor !== null) {
      const found = findTier(lines, [chunk.anchor], strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      cursor = found.occ[0]! + 1;
    }
    const o: RLine[] = [];
    const n: RLine[] = [];
    for (const b of chunk.body) {
      if (b === '') {
        o.push({ text: '', ctx: true });
        n.push({ text: '', ctx: true });
      } else if (b[0] === ' ') {
        o.push({ text: b.slice(1), ctx: true });
        n.push({ text: b.slice(1), ctx: true });
      } else if (b[0] === '-') o.push({ text: b.slice(1), ctx: false });
      else if (b[0] === '+') n.push({ text: b.slice(1), ctx: false });
    }
    if (o.length === 0) {
      const at = chunk.eof ? lines.length : cursor;
      const ins = n.map((l) => l.text);
      lines.splice(at, 0, ...ins);
      cursor = at + ins.length;
      continue;
    }
    const found = findTier(lines, o.map((l) => l.text), strict, cursor);
    if (found === null) throw new Fail('no-match', path);
    let pos: number;
    if (chunk.eof) {
      const eofOcc = found.occ.filter((p) => p + o.length === lines.length);
      if (eofOcc.length === 0) throw new Fail('no-match', path);
      pos = eofOcc[0]!;
    } else {
      pos = found.occ[0]!;
    }
    const repl = buildReplacement(lines, pos, o, n, found.tier);
    lines.splice(pos, o.length, ...repl);
    cursor = pos + repl.length;
  }
  return joinFile(lines, st.br, st.final);
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const handled = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (handled.has(oldP) || handled.has(newP)) continue;
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      handled.add(oldP);
      handled.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (handled.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
