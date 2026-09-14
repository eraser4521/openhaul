/**
 * Creates the GitHub repository and pushes, then rewrites the OWNER/REPO
 * placeholders in the docs to the real slug.
 *
 * Run after `gh auth login`:
 *   node scripts/publish-to-github.mjs [repo-name] [--public]
 *
 * Defaults to a private repository named "openhaul".
 */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const repoName = args.find((a) => !a.startsWith('--')) ?? 'openhaul';
const visibility = args.includes('--public') ? 'public' : 'private';

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, { encoding: 'utf8', ...options }).trim();
}

function tryRun(command, commandArgs) {
  try {
    return run(command, commandArgs);
  } catch {
    return null;
  }
}

// --- preconditions -------------------------------------------------------

const auth = tryRun('gh', ['auth', 'status']);
if (auth === null) {
  console.error('Not signed in to GitHub. Run this first, then try again:\n');
  console.error('  gh auth login\n');
  process.exit(1);
}

const owner = run('gh', ['api', 'user', '--jq', '.login']);
const slug = `${owner}/${repoName}`;

const dirty = run('git', ['status', '--porcelain']);
if (dirty.length > 0) {
  console.error('The working tree has uncommitted changes. Commit them first:\n');
  console.error(dirty);
  process.exit(1);
}

// --- rewrite the documentation placeholders ------------------------------

const FILES = ['README.md', 'docs/SELF_HOSTING.md', 'CONTRIBUTING.md'];
let rewritten = 0;

for (const file of FILES) {
  const full = path.join(process.cwd(), file);
  const before = await readFile(full, 'utf8');
  const after = before.replaceAll('OWNER/REPO', slug);
  if (after !== before) {
    await writeFile(full, after, 'utf8');
    rewritten += 1;
  }
}

if (rewritten > 0) {
  console.log(`Pointed ${rewritten} file(s) at ${slug}.`);
  run('git', ['add', ...FILES]);
  run('git', [
    'commit',
    '-m',
    `Point documentation links at ${slug}\n\nReplaces the OWNER/REPO placeholders now that the repository exists.`,
  ]);
}

// --- create and push -----------------------------------------------------

const exists = tryRun('gh', ['repo', 'view', slug, '--json', 'name']) !== null;

if (exists) {
  console.log(`${slug} already exists; pushing to it.`);
  if (tryRun('git', ['remote', 'get-url', 'origin']) === null) {
    run('git', ['remote', 'add', 'origin', `https://github.com/${slug}.git`]);
  }
  run('git', ['push', '-u', 'origin', 'main'], { stdio: 'inherit' });
} else {
  console.log(`Creating ${visibility} repository ${slug} and pushing…`);
  run(
    'gh',
    [
      'repo',
      'create',
      slug,
      `--${visibility}`,
      '--source', '.',
      '--remote', 'origin',
      '--push',
      '--description',
      'Free, self-hostable auto transport load management for car haulers. VIN scanning, electronic BOLs, photo condition reports.',
    ],
    { stdio: 'inherit' },
  );
}

console.log(`\nDone: https://github.com/${slug}`);
console.log('CI runs on the first push — check the Actions tab.');
