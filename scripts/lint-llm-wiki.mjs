#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import {
  ensureWikiLayout,
  extractWikiLinks,
  parseArgs,
  parseFrontmatter,
  repoRelative,
  resolveInside,
  resolveWikiTarget,
  sha256File,
  walkFiles,
} from './llm-wiki-lib.mjs';

function firstHeading(text, fallback) {
  const match = text.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function issue(type, file, message, severity = 'error') {
  return { type, severity, file, message };
}

function sourceNotes(repoRoot) {
  return walkFiles(resolve(repoRoot, 'wiki', 'sources'), (path) => extname(path).toLowerCase() === '.md')
    .filter((path) => basename(path).toLowerCase() !== 'readme.md');
}

function wikiNotes(repoRoot) {
  return walkFiles(resolve(repoRoot, 'wiki'), (path) => extname(path).toLowerCase() === '.md');
}

function validateSourceNote(repoRoot, path) {
  const rel = repoRelative(repoRoot, path);
  const text = readFileSync(path, 'utf8');
  const frontmatter = parseFrontmatter(text);
  const issues = [];

  if (!frontmatter.source) {
    issues.push(issue('missing-provenance', rel, 'source note is missing frontmatter source'));
    return issues;
  }

  const sourcePath = resolveInside(repoRoot, frontmatter.source);
  const sourceRel = sourcePath ? repoRelative(repoRoot, sourcePath) : frontmatter.source;
  if (!sourcePath) {
    issues.push(issue('invalid-provenance', rel, `source must point inside the repository: ${frontmatter.source}`));
    return issues;
  }
  if (!existsSync(sourcePath)) {
    issues.push(issue('missing-source', rel, `raw source does not exist: ${frontmatter.source}`));
    return issues;
  }
  if (!sourceRel.startsWith('raw/') && !frontmatter.source_sha256) {
    return issues;
  }
  if (!frontmatter.source_sha256) {
    issues.push(issue('missing-source-hash', rel, 'source note is missing source_sha256'));
    return issues;
  }

  const currentHash = sha256File(sourcePath);
  if (currentHash !== frontmatter.source_sha256) {
    issues.push(issue('stale-source', rel, `raw source changed since ingest: ${frontmatter.source}`, 'warning'));
  }

  return issues;
}

function validateLinks(repoRoot, notes) {
  const issues = [];
  const outbound = new Map();
  const inbound = new Map(notes.map((path) => [repoRelative(repoRoot, path), 0]));

  for (const notePath of notes) {
    const rel = repoRelative(repoRoot, notePath);
    const text = readFileSync(notePath, 'utf8');
    const links = extractWikiLinks(text);
    outbound.set(rel, links.length);

    for (const target of links) {
      const resolved = resolveWikiTarget(repoRoot, target);
      if (!resolved) {
        issues.push(issue('broken-link', rel, `cannot resolve wikilink: [[${target}]]`));
        continue;
      }
      const targetRel = repoRelative(repoRoot, resolved);
      if (targetRel.startsWith('wiki/')) {
        inbound.set(targetRel, (inbound.get(targetRel) ?? 0) + 1);
      }
    }
  }

  return { issues, outbound, inbound };
}

function validateOrphans(repoRoot, notes, outbound, inbound) {
  const issues = [];
  for (const notePath of notes) {
    const rel = repoRelative(repoRoot, notePath);
    if (basename(notePath).toLowerCase() === 'readme.md') continue;
    const text = readFileSync(notePath, 'utf8');
    const frontmatter = parseFrontmatter(text);
    const hasRawSource = Boolean(frontmatter.source);
    const outboundCount = outbound.get(rel) ?? 0;
    const inboundCount = inbound.get(rel) ?? 0;
    if (outboundCount === 0 && inboundCount === 0 && !hasRawSource) {
      issues.push(issue('orphan-note', rel, 'note has no inbound links, outbound links, or raw source provenance', 'warning'));
    }
  }
  return issues;
}

function validateDuplicateTitles(repoRoot, notes) {
  const byTitle = new Map();
  for (const notePath of notes) {
    const rel = repoRelative(repoRoot, notePath);
    const title = firstHeading(readFileSync(notePath, 'utf8'), basename(notePath, '.md')).toLowerCase();
    if (!byTitle.has(title)) byTitle.set(title, []);
    byTitle.get(title).push(rel);
  }

  const issues = [];
  for (const [title, files] of byTitle.entries()) {
    if (files.length > 1) {
      issues.push(issue('duplicate-title', files[0], `duplicate title "${title}" also appears in: ${files.slice(1).join(', ')}`, 'warning'));
    }
  }
  return issues;
}

function lint(repoRoot) {
  ensureWikiLayout(repoRoot);
  const notes = wikiNotes(repoRoot);
  const issues = [];

  for (const sourceNote of sourceNotes(repoRoot)) {
    issues.push(...validateSourceNote(repoRoot, sourceNote));
  }

  const linkResult = validateLinks(repoRoot, notes);
  issues.push(...linkResult.issues);
  issues.push(...validateOrphans(repoRoot, notes, linkResult.outbound, linkResult.inbound));
  issues.push(...validateDuplicateTitles(repoRoot, notes));

  return {
    noteCount: notes.length,
    issueCount: issues.length,
    issues,
  };
}

function formatReport(report) {
  const lines = [`LLM Wiki lint: ${report.issueCount} issue${report.issueCount === 1 ? '' : 's'} across ${report.noteCount} notes`];
  for (const item of report.issues) {
    lines.push(`- [${item.severity}] ${item.type}: ${item.file} - ${item.message}`);
  }
  return `${lines.join('\n')}\n`;
}

const options = parseArgs(process.argv.slice(2));
const repoRoot = resolve(String(options.repo ?? process.cwd()));

try {
  const report = lint(repoRoot);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    process.stdout.write(formatReport(report));
  }

  if (options.strict && report.issueCount > 0) {
    process.exit(1);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
