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

const DEFAULT_LIMIT = 5;
const DEFAULT_MAX_CHARS = 4000;

function readStdin() {
  if (process.stdin.isTTY) return '';
  return readFileSync(0, 'utf8');
}

function extractPrompt(input) {
  const text = input.trim();
  if (!text) return '';

  try {
    const payload = JSON.parse(text);
    return String(
      payload.prompt ??
        payload.message ??
        payload.user_prompt ??
        payload.input ??
        payload.tool_input?.command ??
        '',
    ).trim();
  } catch {
    return text;
  }
}

function compactText(text, maxChars = 500) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join(' ')
    .slice(0, maxChars);
}

function resultLocation(result) {
  return result.sourceLocation || result.sourceFile || 'unknown';
}

function formatContext({ query, provider, results, staleWarning, maxChars }) {
  if (results.length === 0) return '';

  const lines = [
    'Agentic Knowledge Context',
    `Query: ${query}`,
    `Source: semantic-vector-index/lancedb via ${provider.name}${provider.semantic ? '' : ' (deterministic test provider)'}`,
  ];
  if (staleWarning) {
    lines.push(`Warning: ${staleWarning}`);
  }
  lines.push(
    'Use these semantic matches as starting points, then verify with GitNexus, graphify, and source files before changing code.',
    '',
  );

  for (const [index, result] of results.entries()) {
    const distance = Number(result.distance);
    const distanceText = Number.isFinite(distance) ? distance.toFixed(4) : 'unknown';
    lines.push(
      `${index + 1}. ${result.label}`,
      `   location: ${resultLocation(result)}`,
      `   distance: ${distanceText}`,
    );
    const snippet = compactText(result.text);
    if (snippet) {
      lines.push(`   excerpt: ${snippet}`);
    }
  }

  return `${lines.join('\n').slice(0, maxChars)}\n`;
}

function unavailableJson(query, reason) {
  return {
    available: false,
    query,
    reason,
    results: [],
  };
}

async function buildContext(options, query) {
  const repoRoot = resolve(String(options.repo ?? process.cwd()));
  const requestedIndex = String(options.index ?? options.manifest ?? 'semantic-vector-index/manifest.json');
  const manifestPath = resolve(repoRoot, requestedIndex);
  if (!existsSync(manifestPath)) {
    return unavailableJson(query, 'semantic vector manifest not found');
  }

  const index = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (index.store?.kind !== 'lancedb') {
    return unavailableJson(query, `unsupported vector store: ${index.store?.kind ?? 'unknown'}`);
  }

  let staleWarning = '';
  const graphPath = resolve(repoRoot, String(index.source?.graphPath ?? 'graphify-out/graph.json'));
  if (index.source?.graphHash && existsSync(graphPath)) {
    const currentGraphHash = sha256File(graphPath);
    if (currentGraphHash !== index.source.graphHash) {
      staleWarning = `${index.source.graphPath} changed after ${requestedIndex}; rebuild with node scripts/build-semantic-vector-index.mjs`;
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
  const limit = Number.parseInt(String(options.limit ?? DEFAULT_LIMIT), 10);
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

    return {
      available: true,
      query,
      stale: Boolean(staleWarning),
      staleWarning,
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
    };
  } finally {
    await provider.dispose();
  }
}

const options = parseArgs(process.argv.slice(2));
const query = options._.join(' ').trim() || extractPrompt(readStdin());

try {
  if (!query) {
    process.exit(0);
  }

  const payload = await buildContext(options, query);
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    process.exit(0);
  }

  if (!payload.available) {
    process.exit(0);
  }

  const maxChars = Number.parseInt(
    String(options.maxChars ?? options['max-chars'] ?? process.env.AGENTIC_KNOWLEDGE_CONTEXT_MAX_CHARS ?? DEFAULT_MAX_CHARS),
    10,
  );
  const output = formatContext({
    query,
    provider: payload.provider,
    results: payload.results,
    staleWarning: payload.staleWarning,
    maxChars: Number.isFinite(maxChars) && maxChars > 0 ? maxChars : DEFAULT_MAX_CHARS,
  });
  if (output) {
    process.stdout.write(output);
  }
} catch (error) {
  if (options.strict) {
    throw error;
  }
  if (options.json) {
    console.log(JSON.stringify(unavailableJson(query, error instanceof Error ? error.message : String(error)), null, 2));
  }
}
