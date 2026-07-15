#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import {
  ensureWikiLayout,
  expandSourceInputs,
  extractConcepts,
  extractEntities,
  extractTitle,
  noteTarget,
  parseArgs,
  readSourceText,
  repoRelative,
  sha256File,
  slugify,
  summarizeSource,
  wikilink,
  writeTextFile,
} from './llm-wiki-lib.mjs';

function sourceSlug(repoRoot, sourcePath) {
  const rel = repoRelative(repoRoot, sourcePath)
    .replace(/^raw\//, '')
    .replace(new RegExp(`${extname(sourcePath).replace('.', '\\.')}$`), '');
  return slugify(rel);
}

function formatBulletList(items, fallback) {
  if (items.length === 0) return `- ${fallback}`;
  return items.map((item) => `- ${item}`).join('\n');
}

function upsertLinkedNote({ notePath, title, sourceTarget, sourceTitle }) {
  const sourceLink = `- ${wikilink(sourceTarget, sourceTitle)}`;
  let text = existsSync(notePath)
    ? readFileSync(notePath, 'utf8')
    : `# ${title}\n\n## Sources\n`;

  if (!text.includes('## Sources')) {
    text = `${text.trimEnd()}\n\n## Sources\n`;
  }
  if (!text.includes(sourceLink)) {
    text = `${text.trimEnd()}\n${sourceLink}\n`;
  }
  writeTextFile(notePath, text);
}

function sourceNoteBody({
  title,
  rawTarget,
  rawRel,
  sourceHash,
  summary,
  concepts,
  entities,
}) {
  const conceptLinks = concepts.map((concept) => wikilink(`wiki/concepts/${concept.slug}`, concept.title));
  const entityLinks = entities.map((entity) => wikilink(`wiki/entities/${entity.slug}`, entity.title));
  const rawLink = `[[${rawRel}|${rawRel}]]`;

  return [
    '---',
    `source: ${rawRel}`,
    `source_sha256: ${sourceHash}`,
    `ingested_at: ${new Date().toISOString()}`,
    'generator: ingest-llm-wiki.mjs',
    '---',
    '',
    `# ${title}`,
    '',
    `Source: ${rawLink}`,
    '',
    '## Summary',
    '',
    formatBulletList(summary, 'No summary could be generated from this source.'),
    '',
    '## Concepts',
    '',
    formatBulletList(conceptLinks, 'No concepts extracted yet.'),
    '',
    '## Entities',
    '',
    formatBulletList(entityLinks, 'No entities extracted yet.'),
    '',
    '## Provenance',
    '',
    `- Raw source: ${rawLink}`,
    `- SHA-256: \`${sourceHash}\``,
    '',
  ].join('\n');
}

function ingestSource(repoRoot, sourcePath, { dryRun = false } = {}) {
  const rawRel = repoRelative(repoRoot, sourcePath);
  const rawTarget = rawRel.replace(/\.md$/i, '');
  const slug = sourceSlug(repoRoot, sourcePath);
  const sourceTarget = `wiki/sources/${slug}`;
  const sourceNotePath = resolve(repoRoot, `${sourceTarget}.md`);
  const sourceText = readSourceText(sourcePath);
  const title = extractTitle(sourceText, sourcePath);
  const sourceHash = sha256File(sourcePath);
  const summary = summarizeSource(sourceText, sourcePath);
  const concepts = extractConcepts(sourceText, title);
  const entities = extractEntities(sourceText);

  const planned = {
    source: rawRel,
    note: repoRelative(repoRoot, sourceNotePath),
    concepts: concepts.map((concept) => concept.title),
    entities: entities.map((entity) => entity.title),
  };

  if (dryRun) return planned;

  writeTextFile(
    sourceNotePath,
    sourceNoteBody({
      title,
      rawTarget,
      rawRel,
      sourceHash,
      summary,
      concepts,
      entities,
    }),
  );

  for (const concept of concepts) {
    upsertLinkedNote({
      notePath: resolve(repoRoot, 'wiki', 'concepts', `${concept.slug}.md`),
      title: concept.title,
      sourceTarget,
      sourceTitle: title,
    });
  }

  for (const entity of entities) {
    upsertLinkedNote({
      notePath: resolve(repoRoot, 'wiki', 'entities', `${entity.slug}.md`),
      title: entity.title,
      sourceTarget,
      sourceTitle: title,
    });
  }

  return planned;
}

const options = parseArgs(process.argv.slice(2));
const repoRoot = resolve(String(options.repo ?? process.cwd()));

try {
  ensureWikiLayout(repoRoot);
  const sources = expandSourceInputs(repoRoot, options._);
  const ingested = sources.map((sourcePath) =>
    ingestSource(repoRoot, sourcePath, { dryRun: Boolean(options['dry-run']) }),
  );

  if (options.json) {
    console.log(JSON.stringify({ sourceCount: ingested.length, sources: ingested }, null, 2));
  } else {
    const noun = ingested.length === 1 ? 'source' : 'sources';
    const mode = options['dry-run'] ? 'Planned' : 'Ingested';
    console.log(`${mode} ${ingested.length} ${noun}`);
    for (const item of ingested) {
      console.log(`- ${item.source} -> ${item.note}`);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
