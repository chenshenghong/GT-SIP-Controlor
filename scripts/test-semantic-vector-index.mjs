#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const tmp = mkdtempSync(join(tmpdir(), 'agentic-vector-test-'));

mkdirSync(join(tmp, 'graphify-out'), { recursive: true });
mkdirSync(join(tmp, 'src'), { recursive: true });

writeFileSync(
  join(tmp, 'src', 'audio.js'),
  [
    'export function mixVirtualAudio(systemAudio, microphone) {',
    '  return [systemAudio, microphone].filter(Boolean).join(" + ");',
    '}',
    '',
  ].join('\n'),
);

writeFileSync(
  join(tmp, 'graphify-out', 'graph.json'),
  JSON.stringify(
    {
      directed: true,
      graph: {},
      nodes: [
        {
          id: 'mixVirtualAudio',
          label: 'mixVirtualAudio',
          source_file: 'src/audio.js',
          source_location: 'src/audio.js:1',
          community: 1,
          file_type: 'javascript',
        },
        {
          id: 'virtualMicrophoneOutput',
          label: 'virtualMicrophoneOutput',
          source_file: 'src/audio.js',
          source_location: 'src/audio.js:2',
          community: 1,
          file_type: 'javascript',
        },
      ],
      links: [{ source: 'mixVirtualAudio', target: 'virtualMicrophoneOutput' }],
    },
    null,
    2,
  ),
);

const buildOut = execFileSync(
  'node',
  [
    join(repoRoot, 'scripts', 'build-semantic-vector-index.mjs'),
    '--repo',
    tmp,
    '--provider',
    'test',
    '--dimensions',
    '12',
  ],
  { encoding: 'utf8' },
);

assert.match(buildOut, /Semantic vector index written/);

const manifestPath = join(tmp, 'semantic-vector-index', 'manifest.json');
const index = JSON.parse(readFileSync(manifestPath, 'utf8'));

assert.equal(index.schemaVersion, 1);
assert.equal(index.store.kind, 'lancedb');
assert.equal(index.store.table, 'nodes');
assert.equal(existsSync(join(tmp, 'semantic-vector-index', 'lancedb')), true);
assert.equal(index.provider.name, 'test');
assert.equal(index.provider.semantic, false);
assert.equal(index.provider.dimensions, 12);
assert.equal(index.source.graphPath, 'graphify-out/graph.json');
assert.equal(index.source.nodeCount, 2);
assert.equal(index.source.indexedItemCount, 2);
assert.equal(typeof index.source.graphHash, 'string');

mkdirSync(join(tmp, 'semantic-vector-index', '.build.lock'), { recursive: true });
writeFileSync(join(tmp, 'semantic-vector-index', '.build.lock', 'pid'), '999999\n');
execFileSync(
  'node',
  [
    join(repoRoot, 'scripts', 'build-semantic-vector-index.mjs'),
    '--repo',
    tmp,
    '--provider',
    'test',
    '--dimensions',
    '12',
  ],
  { encoding: 'utf8' },
);
assert.equal(existsSync(join(tmp, 'semantic-vector-index', '.build.lock')), false);

const queryOut = execFileSync(
  'node',
  [
    join(repoRoot, 'scripts', 'query-semantic-vector-index.mjs'),
    '--repo',
    tmp,
    '--provider',
    'test',
    '--json',
    'virtual microphone mixer',
  ],
  { encoding: 'utf8' },
);

const query = JSON.parse(queryOut);
assert.equal(query.query, 'virtual microphone mixer');
assert.equal(query.results.length, 2);
assert.equal('embedding' in query.results[0], false);
assert.equal(typeof query.results[0].distance, 'number');
assert.match(query.results.map((result) => result.text).join('\n'), /mixVirtualAudio/);

console.log('semantic vector index smoke test passed');
