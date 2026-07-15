import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MODEL = 'Snowflake/snowflake-arctic-embed-xs';
export const DEFAULT_PROVIDER = 'gitnexus';
export const DEFAULT_DIMENSIONS = 384;

const require = createRequire(import.meta.url);

export function parseArgs(argv) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      options._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === 'json') {
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

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmpPath, path);
}

export function getCurrentCommit(repoRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function repoRelative(repoRoot, path) {
  return relative(repoRoot, path).split('\\').join('/');
}

export function resolveInside(repoRoot, candidate) {
  if (!candidate) return null;
  const full = isAbsolute(candidate) ? resolve(candidate) : resolve(repoRoot, candidate);
  const rel = relative(repoRoot, full);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return full;
}

export function collectGraphItems({
  repoRoot,
  graphPath,
  maxTextChars = 6000,
  maxItems = 0,
  excludePrefixes = [],
}) {
  const graph = readJson(graphPath);
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const links = Array.isArray(graph.links)
    ? graph.links
    : Array.isArray(graph.edges)
      ? graph.edges
      : [];
  const selected = maxItems > 0 ? nodes.slice(0, maxItems) : nodes;

  const normalisedExcludes = excludePrefixes
    .map((p) => String(p).trim())
    .filter(Boolean);

  const isExcluded = (node) => {
    if (normalisedExcludes.length === 0) return false;
    const sourceFile = node.source_file ?? node.sourceFile ?? node.file ?? node.path ?? null;
    if (!sourceFile) return false;
    return normalisedExcludes.some((prefix) => String(sourceFile).startsWith(prefix));
  };

  const filtered = selected.filter((node) => !isExcluded(node));
  const skipped = selected.length - filtered.length;

  const items = filtered
    .map((node, index) => buildItem(repoRoot, node, index, maxTextChars))
    .filter((item) => item.text.trim().length > 0);

  return {
    graph,
    nodes,
    links,
    items,
    skipped,
    excludePrefixes: normalisedExcludes,
  };
}

// Doc-only retrieval: the broker surfaces design docs / decisions / specs for
// natural-language recall (incl. Chinese prose). Code structure/semantic recall
// is served by the codebase-memory-mcp (CMM) code engine, so the vector index no
// longer needs to embed code nodes. A node is a "doc" if graphify tagged it
// file_type=document, or its source file has a prose extension.
export const DOC_FILE_RE = /\.(md|markdown|mdx|txt|rst|adoc)$/i;

export function isDocItem(item) {
  if (!item) return false;
  if (String(item.fileType ?? '') === 'document') return true;
  if (String(item.fileType ?? '') === 'obsidian') return true;
  return DOC_FILE_RE.test(String(item.sourceFile ?? ''));
}

// Locate the project's Obsidian vault (which lives OUTSIDE the repo, so neither
// graphify nor CMM can index it). Cross-machine: Mac uses ~/Documents/Obsidian
// Vault/<project>, the build server uses /home/tcfnet/... .
export function resolveObsidianVault({ repoRoot = null, explicit = null, projectName = null } = {}) {
  if (explicit) return existsSync(explicit) ? explicit : null;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const name = projectName
    || (repoRoot ? repoRoot.split(/[\\/]/).filter(Boolean).pop() : null);
  if (!name) return null;
  const roots = [
    process.env.OBSIDIAN_VAULT,
    home ? join(home, 'Documents/Obsidian Vault') : null,
    home ? join(home, 'Obsidian Vault') : null,
    '/home/tcfnet/Documents/Obsidian Vault',
    '/home/tcfnet/Obsidian Vault',
  ].filter(Boolean);
  for (const root of roots) {
    const candidate = join(root, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Walk the vault for markdown, split each note into heading-scoped sections, and
// return items in the same shape as buildItem() so they embed alongside graph
// doc nodes. One item per section keeps retrieval granular.
export function collectObsidianItems({ vaultDir, maxTextChars = 6000 }) {
  if (!vaultDir || !existsSync(vaultDir)) {
    return { items: [], vaultDir: null, fileCount: 0 };
  }
  const files = walkMarkdownFiles(vaultDir);
  const items = [];
  for (const file of files) {
    let content;
    try {
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) continue;
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(vaultDir, file).split('\\').join('/');
    for (const section of splitMarkdownSections(content)) {
      const body = section.body.trim();
      if (!body) continue;
      const heading = section.heading || rel.replace(/\.md$/i, '');
      const text = [
        `source: Obsidian/${rel}`,
        `heading: ${heading}`,
        '',
        body,
      ].join('\n').slice(0, maxTextChars);
      items.push({
        id: `obsidian:${rel}#L${section.startLine}`,
        label: `${rel} :: ${heading}`,
        sourceFile: `Obsidian/${rel}`,
        sourceLocation: `L${section.startLine}`,
        fileType: 'obsidian',
        community: null,
        text,
        textHash: sha256(text),
      });
    }
  }
  return { items, vaultDir, fileCount: files.length };
}

function walkMarkdownFiles(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith('.')) continue; // skip .obsidian, .trash, etc.
    const full = join(dir, name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(full, acc);
    } else if (entry.isFile() && /\.(md|markdown)$/i.test(name)) {
      acc.push(full);
    }
  }
  return acc;
}

function splitMarkdownSections(content) {
  const lines = content.split(/\r?\n/);
  const sections = [];
  let current = { heading: '', startLine: 1, lines: [] };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const headingMatch = /^#{1,6}\s+(.*)$/.exec(line);
    if (headingMatch) {
      if (current.lines.join('\n').trim() || current.heading) {
        sections.push({ heading: current.heading, startLine: current.startLine, body: current.lines.join('\n') });
      }
      current = { heading: headingMatch[1].trim(), startLine: i + 1, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.join('\n').trim() || current.heading) {
    sections.push({ heading: current.heading, startLine: current.startLine, body: current.lines.join('\n') });
  }
  return sections;
}

function buildItem(repoRoot, node, index, maxTextChars) {
  const id = String(node.id ?? node.key ?? node.label ?? `node-${index}`);
  const label = String(node.label ?? node.name ?? id);
  const sourceFile = node.source_file ?? node.sourceFile ?? node.file ?? node.path ?? null;
  const sourceLocation = node.source_location ?? node.sourceLocation ?? node.location ?? null;
  const fileType = node.file_type ?? node.fileType ?? node.type ?? null;
  const community = node.community ?? null;

  const parts = [
    `id: ${id}`,
    `label: ${label}`,
    fileType ? `type: ${fileType}` : null,
    sourceFile ? `source_file: ${sourceFile}` : null,
    sourceLocation ? `source_location: ${sourceLocation}` : null,
    community !== null && community !== undefined ? `community: ${community}` : null,
  ].filter(Boolean);

  const snippet = readSourceSnippet(repoRoot, sourceFile, sourceLocation, maxTextChars);
  if (snippet) {
    parts.push('source_snippet:', snippet);
  }

  const text = parts.join('\n').slice(0, maxTextChars);
  return {
    id,
    label,
    sourceFile,
    sourceLocation,
    fileType,
    community,
    text,
    textHash: sha256(text),
  };
}

function readSourceSnippet(repoRoot, sourceFile, sourceLocation, maxTextChars) {
  const resolved = resolveInside(repoRoot, sourceFile);
  const full = resolved && existsSync(resolved)
    ? resolved
    : findRepoFileBySuffix(repoRoot, sourceFile);
  if (!full || !existsSync(full)) return '';
  try {
    const stat = statSync(full);
    if (!stat.isFile() || stat.size > 512 * 1024) return '';
    const content = readFileSync(full, 'utf8');
    const lines = content.split(/\r?\n/);
    const lineNumber = parseLineNumber(sourceLocation);
    if (!lineNumber) {
      return content.slice(0, maxTextChars);
    }
    const start = Math.max(0, lineNumber - 16);
    const end = Math.min(lines.length, lineNumber + 15);
    return lines
      .slice(start, end)
      .map((line, offset) => `${start + offset + 1}: ${line}`)
      .join('\n')
      .slice(0, maxTextChars);
  } catch {
    return '';
  }
}

const repoFileCache = new Map();

function findRepoFileBySuffix(repoRoot, sourceFile) {
  if (!sourceFile) return null;
  const normalized = String(sourceFile).split('\\').join('/');
  let files = repoFileCache.get(repoRoot);
  if (!files) {
    try {
      files = execFileSync('git', ['ls-files'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split(/\r?\n/)
        .filter(Boolean)
        .map((file) => file.split('\\').join('/'));
    } catch {
      files = [];
    }
    repoFileCache.set(repoRoot, files);
  }
  const match = files.find((file) => file.endsWith(`/${normalized}`) || file === normalized);
  return match ? resolve(repoRoot, match) : null;
}

function parseLineNumber(sourceLocation) {
  if (!sourceLocation) return null;
  const text = String(sourceLocation);
  const match = text.match(/:(\d+)(?::\d+)?$/) ?? text.match(/^L(\d+)$/i);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export async function createEmbeddingProvider({
  provider = DEFAULT_PROVIDER,
  model = DEFAULT_MODEL,
  dimensions = DEFAULT_DIMENSIONS,
  device = process.env.AGENTIC_KNOWLEDGE_VECTOR_DEVICE || 'cpu',
} = {}) {
  if (provider === 'test') {
    const dims = Number.parseInt(dimensions, 10) || 12;
    return {
      name: 'test',
      model: 'deterministic-test',
      dimensions: dims,
      semantic: false,
      async embed(texts) {
        return texts.map((text) => deterministicVector(text, dims));
      },
      async dispose() {},
    };
  }

  if (provider !== 'gitnexus') {
    throw new Error(`Unsupported vector provider: ${provider}`);
  }

  const embedderPath = locateGitNexusEmbedder();
  if (!embedderPath) {
    throw new Error(
      'Could not locate GitNexus embedder. Install gitnexus or set AGENTIC_KNOWLEDGE_VECTOR_PROVIDER=test for smoke tests.',
    );
  }

  if (!process.env.ORT_LOG_LEVEL) {
    process.env.ORT_LOG_LEVEL = '3';
  }

  const embedder = await import(pathToFileURL(embedderPath).href);
  await embedder.initEmbedder(undefined, { modelId: model }, device);

  return {
    name: 'gitnexus',
    model,
    dimensions: embedder.getEmbeddingDimensions?.() ?? DEFAULT_DIMENSIONS,
    semantic: true,
    device,
    source: embedderPath,
    async embed(texts) {
      const vectors = await embedder.embedBatch(texts);
      return vectors.map((vector) => Array.from(vector));
    },
    async dispose() {
      await embedder.disposeEmbedder?.();
    },
  };
}

export async function embedInBatches(provider, texts, batchSize = 16) {
  const vectors = [];
  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize);
    vectors.push(...(await provider.embed(batch)));
  }
  return vectors;
}

export function cosineSimilarity(a, b) {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

export function roundVector(vector) {
  return vector.map((value) => Number(value.toFixed(8)));
}

export async function openLanceDb(dbPath) {
  const lancedb = await import('@lancedb/lancedb');
  mkdirSync(dbPath, { recursive: true });
  return lancedb.connect(dbPath);
}

export async function writeLanceTable({ dbPath, tableName = 'nodes', rows }) {
  if (rows.length === 0) {
    throw new Error('Cannot write an empty LanceDB table');
  }
  const db = await openLanceDb(dbPath);
  try {
    let table;
    try {
      table = await db.createTable(tableName, rows, { mode: 'overwrite' });
    } catch {
      rmSync(join(dbPath, `${tableName}.lance`), { recursive: true, force: true });
      table = await db.createTable(tableName, rows);
    }
    await table.close?.();
  } finally {
    await db.close?.();
  }
}

export async function searchLanceTable({ dbPath, tableName = 'nodes', vector, limit = 5 }) {
  const db = await openLanceDb(dbPath);
  try {
    const table = await db.openTable(tableName);
    try {
      return await table.search(vector).limit(limit).toArray();
    } finally {
      await table.close?.();
    }
  } finally {
    await db.close?.();
  }
}

export async function withDirectoryLock(lockDir, fn, timeoutSecs = 600) {
  mkdirSync(dirname(lockDir), { recursive: true });
  const pidPath = join(lockDir, 'pid');
  const start = Date.now();
  while (true) {
    try {
      mkdirSync(lockDir);
      writeFileSync(pidPath, `${process.pid}\n`);
      break;
    } catch {
      try {
        const lockPid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
        if (Number.isFinite(lockPid)) {
          try {
            process.kill(lockPid, 0);
          } catch {
            rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
        }
      } catch {}
      const waitedSecs = Math.floor((Date.now() - start) / 1000);
      if (waitedSecs >= timeoutSecs) {
        throw new Error(`Timed out waiting for lock: ${lockDir}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  try {
    return await fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function deterministicVector(text, dimensions) {
  const values = [];
  for (let i = 0; i < dimensions; i += 1) {
    const digest = createHash('sha256').update(`${text}\0${i}`).digest();
    const raw = digest.readInt32BE(0) / 0x7fffffff;
    values.push(raw);
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / norm);
}

function locateGitNexusEmbedder() {
  const candidates = [];
  try {
    candidates.push(join(dirname(require.resolve('gitnexus/package.json')), 'dist/core/embeddings/embedder.js'));
  } catch {}

  try {
    const npmRoot = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    candidates.push(join(npmRoot, 'gitnexus/dist/core/embeddings/embedder.js'));
  } catch {}

  try {
    const whichCommand = process.platform === 'win32' ? 'where' : 'which';
    const bin = execFileSync(whichCommand, ['gitnexus'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .find(Boolean);
    if (bin) {
      const realBin = realpathSync(bin);
      candidates.push(resolve(dirname(realBin), '../core/embeddings/embedder.js'));
      candidates.push(resolve(dirname(realBin), '../../core/embeddings/embedder.js'));
    }
  } catch {}

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}
