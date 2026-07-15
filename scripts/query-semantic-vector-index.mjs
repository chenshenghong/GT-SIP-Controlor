#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  DEFAULT_MODEL,
  createEmbeddingProvider,
  parseArgs,
  searchLanceTable,
  sha256File,
} from './semantic-vector-lib.mjs';

const options = parseArgs(process.argv.slice(2));
const query = options._.join(' ').trim();
if (!query) {
  throw new Error('Usage: query-semantic-vector-index.mjs [--repo PATH] [--json] <query>');
}

const repoRoot = resolve(String(options.repo ?? process.cwd()));
const requestedIndex = String(options.index ?? options.manifest ?? 'semantic-vector-index/manifest.json');
const manifestPath = resolve(repoRoot, requestedIndex);
const index = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (index.store?.kind !== 'lancedb') {
  throw new Error(`Unsupported vector store in manifest: ${index.store?.kind ?? 'unknown'}`);
}
const graphPath = resolve(repoRoot, String(index.source?.graphPath ?? 'graphify-out/graph.json'));
if (index.source?.graphHash && existsSync(graphPath)) {
  const currentGraphHash = sha256File(graphPath);
  if (currentGraphHash !== index.source.graphHash) {
    console.error(
      `Semantic vector index is stale: ${index.source.graphPath} changed after ${manifestPath}. Rebuild with scripts/build-semantic-vector-index.mjs.`,
    );
  }
}
const providerName = String(
  options.provider ??
    process.env.AGENTIC_KNOWLEDGE_VECTOR_PROVIDER ??
    index.provider?.name ??
    'gitnexus',
);
const model = String(
  options.model ??
    process.env.AGENTIC_KNOWLEDGE_VECTOR_MODEL ??
    index.provider?.model ??
    DEFAULT_MODEL,
);
const dimensions = Number.parseInt(
  String(options.dimensions ?? index.provider?.dimensions ?? '384'),
  10,
);
const device = String(options.device ?? process.env.AGENTIC_KNOWLEDGE_VECTOR_DEVICE ?? 'cpu');
const limit = Number.parseInt(String(options.limit ?? '5'), 10);
const dbPath = resolve(repoRoot, String(options.db ?? index.store?.uri ?? `${dirname(requestedIndex)}/lancedb`));
const tableName = String(options.table ?? index.store?.table ?? 'nodes');

const provider = await createEmbeddingProvider({
  provider: providerName,
  model,
  dimensions,
  device,
});

try {
  const [queryVector] = await provider.embed([query]);
  const rows = await searchLanceTable({
    dbPath,
    tableName,
    vector: queryVector,
    limit,
  });
  const results = rows.map((row) => ({
    id: row.id,
    label: row.label,
    distance: row._distance,
    sourceFile: row.sourceFile,
    sourceLocation: row.sourceLocation,
    text: row.text,
  }));

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          query,
          provider: {
            name: provider.name,
            model: provider.model,
            semantic: provider.semantic,
          },
          store: {
            kind: 'lancedb',
            uri: index.store.uri,
            table: tableName,
          },
          results,
        },
        null,
        2,
      ),
    );
  } else {
    for (const [index, result] of results.entries()) {
      const location = result.sourceLocation || result.sourceFile || 'unknown';
      console.log(`${index + 1}. ${result.label} (distance=${Number(result.distance).toFixed(4)}) ${location}`);
    }
  }
} finally {
  await provider.dispose();
}
