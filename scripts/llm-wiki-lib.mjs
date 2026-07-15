import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

const TEXT_EXTENSIONS = new Set([
  '.csv',
  '.json',
  '.log',
  '.md',
  '.mdx',
  '.txt',
  '.tsv',
  '.yaml',
  '.yml',
]);

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'with',
]);

const KNOWN_ENTITIES = [
  'Antigravity',
  'Claude Code',
  'Codex',
  'GitNexus',
  'Graphify',
  'LanceDB',
  'LLM Wiki',
  'MCP',
  'Obsidian Memory',
  'Obsidian',
  'OpenAI',
];

export function parseArgs(argv) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      options._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (['dry-run', 'force', 'json', 'strict'].includes(key)) {
      options[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      options[key] = true;
      continue;
    }
    options[key] = value;
    i += 1;
  }
  return options;
}

export function repoRelative(repoRoot, path) {
  return relative(repoRoot, path).split('\\').join('/');
}

export function resolveInside(repoRoot, candidate) {
  const full = isAbsolute(candidate) ? resolve(candidate) : resolve(repoRoot, candidate);
  const rel = relative(repoRoot, full);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return full;
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function ensureWikiLayout(repoRoot) {
  for (const dir of ['raw', 'wiki', 'wiki/concepts', 'wiki/entities', 'wiki/sources']) {
    mkdirSync(resolve(repoRoot, dir), { recursive: true });
  }
}

export function slugify(value) {
  const slug = String(value ?? '')
    .normalize('NFKD')
    .replace(/['"]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || 'note';
}

export function titleFromSlug(slug) {
  return String(slug)
    .split('-')
    .filter(Boolean)
    .map((part) => {
      if (part.length <= 3 && part === part.toLowerCase()) return part.toUpperCase();
      return `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`;
    })
    .join(' ');
}

export function wikilink(target, label = '') {
  const cleanTarget = String(target).replace(/\.md$/i, '');
  return label ? `[[${cleanTarget}|${label}]]` : `[[${cleanTarget}]]`;
}

export function noteTarget(repoRoot, notePath) {
  return repoRelative(repoRoot, notePath).replace(/\.md$/i, '');
}

export function walkFiles(root, predicate = () => true) {
  if (!existsSync(root)) return [];
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkFiles(full, predicate));
    } else if (entry.isFile() && predicate(full)) {
      found.push(full);
    }
  }
  return found;
}

export function expandSourceInputs(repoRoot, inputs) {
  const rawRoot = resolve(repoRoot, 'raw');
  const requested = inputs.length > 0 ? inputs : ['raw'];
  const files = [];

  for (const input of requested) {
    const full = resolveInside(repoRoot, input);
    if (!full) throw new Error(`Source is outside repository: ${input}`);
    const rel = repoRelative(repoRoot, full);
    if (rel !== 'raw' && !rel.startsWith('raw/')) {
      throw new Error(`INGEST sources must live under raw/: ${input}`);
    }
    if (!existsSync(full)) throw new Error(`Source not found: ${input}`);

    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...walkFiles(full, (path) => statSync(path).isFile()));
    } else if (stat.isFile()) {
      files.push(full);
    }
  }

  return [...new Set(files)]
    .filter((file) => repoRelative(repoRoot, file).startsWith('raw/'))
    .filter((file) => file !== rawRoot)
    .sort();
}

export function readSourceText(sourcePath) {
  const ext = extname(sourcePath).toLowerCase();
  const buffer = readFileSync(sourcePath);
  if (!TEXT_EXTENSIONS.has(ext) && buffer.includes(0)) {
    return '';
  }
  return buffer.toString('utf8');
}

export function extractTitle(sourceText, sourcePath) {
  const heading = sourceText.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  return titleFromSlug(slugify(basename(sourcePath, extname(sourcePath))));
}

function cleanMarkdown(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[[^\]]+\]\([^)]+\)/g, ' ')
    .replace(/^#+\s+/gm, '')
    .replace(/[*_>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function summarizeSource(sourceText, sourcePath) {
  const clean = cleanMarkdown(sourceText);
  if (!clean) {
    return [`${basename(sourcePath)} is a non-text or empty source. Add a manual summary after ingestion.`];
  }
  const sentences = clean
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, 3);
  return sentences.length > 0 ? sentences : [clean.slice(0, 240)];
}

function uniqueBySlug(values, limit) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const label = String(value).replace(/\s+/g, ' ').trim();
    const slug = slugify(label);
    if (!label || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ title: label, slug });
    if (out.length >= limit) break;
  }
  return out;
}

export function extractConcepts(sourceText, title, limit = 8) {
  const headings = [...sourceText.matchAll(/^#{2,4}\s+(.+)$/gm)].map((match) => match[1]);
  const tokens = cleanMarkdown(sourceText)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 4 && !STOP_WORDS.has(token));
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  const frequent = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([token]) => titleFromSlug(slugify(token)));

  const candidates = headings.length > 0 ? [...headings, ...frequent] : [title, ...frequent];
  return uniqueBySlug(candidates, limit);
}

export function extractEntities(sourceText, limit = 8) {
  const found = [];
  for (const entity of KNOWN_ENTITIES) {
    if (sourceText.includes(entity)) found.push(entity);
  }

  const titleCaseMatches = sourceText.match(/\b[A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*){0,3}\b/g) ?? [];
  for (const candidate of titleCaseMatches) {
    if (candidate.length < 3) continue;
    if (['The', 'This', 'Source', 'Summary', 'Concepts', 'Entities'].includes(candidate)) continue;
    found.push(candidate);
  }

  return uniqueBySlug(found, limit);
}

export function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return {};
  const end = text.indexOf('\n---', 4);
  if (end === -1) return {};
  const body = text.slice(4, end);
  const data = {};
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    data[match[1]] = match[2].replace(/^["']|["']$/g, '').trim();
  }
  return data;
}

export function extractWikiLinks(text) {
  const links = [];
  const pattern = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    links.push(match[1].trim());
  }
  return links;
}

export function resolveWikiTarget(repoRoot, target) {
  const clean = target.replace(/\\/g, '/').replace(/\.md$/i, '');
  const candidates = [
    resolve(repoRoot, clean),
    resolve(repoRoot, `${clean}.md`),
    resolve(repoRoot, 'wiki', clean),
    resolve(repoRoot, 'wiki', `${clean}.md`),
  ];
  for (const candidate of candidates) {
    const inside = resolveInside(repoRoot, candidate);
    if (inside && existsSync(inside)) return inside;
  }

  const basenameTarget = basename(clean);
  const matches = walkFiles(resolve(repoRoot, 'wiki'), (path) => extname(path).toLowerCase() === '.md')
    .filter((path) => basename(path, '.md') === basenameTarget);
  return matches.length === 1 ? matches[0] : null;
}

export function writeTextFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
