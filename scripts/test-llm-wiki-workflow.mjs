#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const tmp = mkdtempSync(join(tmpdir(), 'llm-wiki-test-'));

mkdirSync(join(tmp, 'raw'), { recursive: true });
mkdirSync(join(tmp, 'wiki', 'sources'), { recursive: true });

writeFileSync(
  join(tmp, 'raw', 'agentic-broker.md'),
  [
    '# Agentic Broker Notes',
    '',
    'LanceDB provides semantic recall for task-start context.',
    'GitNexus provides structural impact analysis and detect changes.',
    'Graphify connects cross module relationships across the vault.',
    'Obsidian Memory preserves durable project decisions.',
    '',
    '## Semantic Context Broker',
    '',
    'The broker should read immutable raw notes and create linked wiki pages.',
    '',
  ].join('\n'),
);

const ingestOut = execFileSync(
  'node',
  [
    join(repoRoot, 'scripts', 'ingest-llm-wiki.mjs'),
    '--repo',
    tmp,
    'raw/agentic-broker.md',
  ],
  { encoding: 'utf8' },
);

assert.match(ingestOut, /Ingested 1 source/);

const sourceNote = join(tmp, 'wiki', 'sources', 'agentic-broker.md');
assert.equal(existsSync(sourceNote), true);

const sourceText = readFileSync(sourceNote, 'utf8');
assert.match(sourceText, /source: raw\/agentic-broker\.md/);
assert.match(sourceText, /source_sha256:/);
assert.match(sourceText, /\[\[raw\/agentic-broker\.md\|raw\/agentic-broker\.md\]\]/);
assert.match(sourceText, /\[\[wiki\/concepts\/semantic-context-broker\|Semantic Context Broker\]\]/);
assert.match(sourceText, /\[\[wiki\/entities\/lancedb\|LanceDB\]\]/);

const conceptNote = join(tmp, 'wiki', 'concepts', 'semantic-context-broker.md');
const entityNote = join(tmp, 'wiki', 'entities', 'lancedb.md');
assert.equal(existsSync(conceptNote), true);
assert.equal(existsSync(entityNote), true);
assert.match(readFileSync(conceptNote, 'utf8'), /\[\[wiki\/sources\/agentic-broker\|Agentic Broker Notes\]\]/);
assert.match(readFileSync(entityNote, 'utf8'), /\[\[wiki\/sources\/agentic-broker\|Agentic Broker Notes\]\]/);

const lintJson = execFileSync(
  'node',
  [join(repoRoot, 'scripts', 'lint-llm-wiki.mjs'), '--repo', tmp, '--json'],
  { encoding: 'utf8' },
);
const lint = JSON.parse(lintJson);
assert.equal(lint.issueCount, 0, JSON.stringify(lint, null, 2));

writeFileSync(join(tmp, 'wiki', 'sources', 'bad.md'), '# Bad\n\nNo provenance here.\n');
const strictLint = spawnSync(
  'node',
  [join(repoRoot, 'scripts', 'lint-llm-wiki.mjs'), '--repo', tmp, '--strict'],
  { encoding: 'utf8' },
);

assert.equal(strictLint.status, 1);
assert.match(strictLint.stdout, /missing-provenance/);

const installerPath = join(repoRoot, 'scripts', 'install-agentic-knowledge.sh');
if (existsSync(installerPath)) {
  const installer = readFileSync(installerPath, 'utf8');
  assert.match(installer, /mkdir -p raw wiki\/concepts wiki\/entities wiki\/sources/);
  assert.match(installer, /copy_helper_script ingest-llm-wiki\.mjs/);
  assert.match(installer, /copy_helper_script lint-llm-wiki\.mjs/);
}

console.log('LLM Wiki workflow smoke test passed');
