#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import {
  DEFAULT_MODEL,
  collectGraphItems,
  collectObsidianItems,
  createEmbeddingProvider,
  embedInBatches,
  getCurrentCommit,
  isDocItem,
  parseArgs,
  repoRelative,
  resolveObsidianVault,
  roundVector,
  sha256File,
  withDirectoryLock,
  writeLanceTable,
  writeJson,
} from './semantic-vector-lib.mjs';

const options = parseArgs(process.argv.slice(2));
const repoRoot = resolve(String(options.repo ?? process.cwd()));
const graphPath = resolve(repoRoot, String(options.graph ?? 'graphify-out/graph.json'));
const requestedOut = options.out ? String(options.out) : null;
const indexDir = requestedOut?.endsWith('.json')
  ? dirname(resolve(repoRoot, requestedOut))
  : resolve(repoRoot, String(options.out ?? options.dir ?? 'semantic-vector-index'));
const dbPath = resolve(indexDir, String(options.db ?? 'lancedb'));
const manifestPath = requestedOut?.endsWith('.json')
  ? resolve(repoRoot, requestedOut)
  : resolve(indexDir, String(options.manifest ?? 'manifest.json'));
const tableName = String(options.table ?? 'nodes');
const providerName = String(
  options.provider ?? process.env.AGENTIC_KNOWLEDGE_VECTOR_PROVIDER ?? 'gitnexus',
);
const model = String(options.model ?? process.env.AGENTIC_KNOWLEDGE_VECTOR_MODEL ?? DEFAULT_MODEL);
const dimensions = Number.parseInt(String(options.dimensions ?? '384'), 10);
const batchSize = Number.parseInt(String(options['batch-size'] ?? '16'), 10);
const maxTextChars = Number.parseInt(String(options['max-text-chars'] ?? '6000'), 10);
const maxItems = Number.parseInt(String(options['max-items'] ?? '0'), 10);
const device = String(options.device ?? process.env.AGENTIC_KNOWLEDGE_VECTOR_DEVICE ?? 'cpu');
const lockTimeoutSecs = Number.parseInt(
  String(options['lock-timeout'] ?? process.env.AGENTIC_KNOWLEDGE_VECTOR_LOCK_TIMEOUT_SECS ?? '600'),
  10,
);
const excludePrefixesRaw = String(
  options['exclude-prefixes']
  ?? options.exclude
  ?? process.env.AGENTIC_KNOWLEDGE_EXCLUDE_PREFIXES
  ?? 'legacy_reference,vendor',
);
const excludePrefixes = excludePrefixesRaw
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);

const { nodes, links, items, skipped, excludePrefixes: actualExcludes } = collectGraphItems({
  repoRoot,
  graphPath,
  maxTextChars,
  maxItems,
  excludePrefixes,
});

// Exclude test/spec/e2e/mock nodes — noise for "find the right feature/interface"
// retrieval. These paths are scattered (nested __tests__, .spec.ts suffixes) so the
// prefix-based excludePrefixes can't catch them. Toggle off with
// AGENTIC_KNOWLEDGE_EXCLUDE_TESTS=0 or --exclude-tests=0.
const excludeTests = String(
  options['exclude-tests'] ?? process.env.AGENTIC_KNOWLEDGE_EXCLUDE_TESTS ?? '1',
) !== '0';
const TEST_FILE_RE = /(^|\/)(__tests__|__mocks__|e2e)\/|\.(spec|test)\.[cm]?[jt]sx?$/i;
const testFiltered = excludeTests
  ? items.filter((item) => !TEST_FILE_RE.test(String(item.sourceFile ?? '')))
  : items;
const testSkipped = items.length - testFiltered.length;
if (excludeTests && testSkipped > 0) {
  console.log(`Excluding ${testSkipped} test/spec/e2e node(s) — ${testFiltered.length} items remain`);
}

// docs-only: drop code nodes (code recall is served by the CMM code engine).
// Opt-in via --docs-only or AGENTIC_KNOWLEDGE_DOCS_ONLY=1 so bare invocations
// (and the existing test suite) keep the full-index behaviour.
const docsOnly = String(
  options['docs-only'] ?? process.env.AGENTIC_KNOWLEDGE_DOCS_ONLY ?? '0',
) !== '0';
const graphItems = docsOnly ? testFiltered.filter(isDocItem) : testFiltered;
if (docsOnly) {
  console.log(`docs-only: kept ${graphItems.length}/${testFiltered.length} graph doc node(s)`);
}

// Obsidian vault ingestion (opt-in): the vault lives outside the repo, so it is
// invisible to graphify/CMM. Embedding it lets the broker surface past
// decisions/root-causes/contracts at task start.
const includeObsidian = String(
  options.obsidian ?? process.env.AGENTIC_KNOWLEDGE_OBSIDIAN ?? '0',
) !== '0';
const projectName = (options.project ?? process.env.AGENTIC_KNOWLEDGE_PROJECT_NAME ?? '') || null;
let obsidianItems = [];
let obsidianVault = null;
if (includeObsidian) {
  obsidianVault = resolveObsidianVault({
    repoRoot,
    explicit: options['obsidian-vault'] ?? process.env.AGENTIC_KNOWLEDGE_OBSIDIAN_VAULT ?? null,
    projectName,
  });
  if (obsidianVault) {
    const res = collectObsidianItems({ vaultDir: obsidianVault, maxTextChars });
    obsidianItems = res.items;
    console.log(`Obsidian: embedded ${obsidianItems.length} section(s) from ${res.fileCount} note(s) in ${obsidianVault}`);
  } else {
    console.log('Obsidian: vault not found — skipping (set AGENTIC_KNOWLEDGE_OBSIDIAN_VAULT to override)');
  }
}

const embedItems = [...graphItems, ...obsidianItems];

if (actualExcludes.length > 0) {
  console.log(
    `Excluding ${skipped} graph node(s) matching prefixes [${actualExcludes.join(', ')}] — `
    + `${items.length}/${nodes.length} items will be embedded`,
  );
}

if (embedItems.length === 0) {
  throw new Error(`No embeddable graph nodes found in ${repoRelative(repoRoot, graphPath)}`);
}

const provider = await createEmbeddingProvider({
  provider: providerName,
  model,
  dimensions,
  device,
});

try {
  const vectors = await embedInBatches(
    provider,
    embedItems.map((item) => item.text),
    batchSize,
  );

  const rows = embedItems.map((item, index) => ({
    id: item.id,
    label: item.label,
    sourceFile: item.sourceFile ?? '',
    sourceLocation: item.sourceLocation ?? '',
    fileType: item.fileType ?? '',
    community: item.community === null || item.community === undefined ? '' : String(item.community),
    text: item.text,
    textHash: item.textHash,
    vector: roundVector(vectors[index]),
  }));

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repo: {
      path: repoRoot,
      commit: getCurrentCommit(repoRoot),
    },
    provider: {
      name: provider.name,
      model: provider.model,
      dimensions: vectors[0]?.length ?? provider.dimensions,
      semantic: provider.semantic,
      device: provider.device ?? null,
    },
    store: {
      kind: 'lancedb',
      uri: repoRelative(repoRoot, dbPath),
      table: tableName,
      vectorColumn: 'vector',
      textColumn: 'text',
    },
    source: {
      graphPath: repoRelative(repoRoot, graphPath),
      graphHash: sha256File(graphPath),
      nodeCount: nodes.length,
      linkCount: links.length,
      indexedItemCount: embedItems.length,
      docsOnly,
      graphDocItemCount: graphItems.length,
      obsidian: {
        enabled: includeObsidian,
        vault: obsidianVault,
        itemCount: obsidianItems.length,
      },
    },
  };

  await withDirectoryLock(
    resolve(indexDir, '.build.lock'),
    async () => {
      await writeLanceTable({ dbPath, tableName, rows });
      writeJson(manifestPath, manifest);
    },
    lockTimeoutSecs,
  );

  console.log(
    `Semantic vector index written: ${repoRelative(repoRoot, dbPath)} table=${tableName} (${embedItems.length} items, ${manifest.provider.dimensions} dims, provider=${provider.name})`,
  );
} finally {
  await provider.dispose();
}
