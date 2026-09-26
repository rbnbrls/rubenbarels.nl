// Guards the coverage + static-tooling wiring added by kanban t_2e443594.
//
// The darkfactory quality lane measured this repository as rung `unmeasured`
// (`capability:coverage_tooling_absent`) with `quality:no_tools`: no coverage
// runner, no linter and no type checker — and the only workflow in the repository
// was the Coolify deploy, so nothing ever gated a merge. Closing that gap is only
// durable if it cannot be quietly undone, and the numbers it publishes have to be
// reproducible:
//
//   * `.c8rc.json` is the single source of the line floor;
//   * `.github/workflows/ci.yml` runs the suite *through* c8 (`npm run coverage`),
//     prints the line total, enforces that floor, runs eslint and `tsc --noEmit`,
//     and refuses a stale committed report;
//   * `coverage/lcov.info` is committed, so the published percentage is readable
//     from the default branch instead of living in a CI log that expires.
//
// Run with `npm test`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

const c8Config = JSON.parse(read('.c8rc.json'));
const packageJson = JSON.parse(read('package.json'));
const tsconfig = JSON.parse(read('tsconfig.json'));
const workflow = read('.github/workflows/ci.yml');
const eslintConfig = read('eslint.config.mjs');
const lcov = read('coverage/lcov.info');

/** Line totals of a committed lcov report. */
function lcovTotals(report) {
  const totals = { files: [], found: 0, hit: 0 };
  for (const line of report.split('\n')) {
    if (line.startsWith('SF:')) totals.files.push(line.slice(3).trim());
    else if (line.startsWith('LF:')) totals.found += Number(line.slice(3));
    else if (line.startsWith('LH:')) totals.hit += Number(line.slice(3));
  }
  return totals;
}

test('c8 is configured to run the repository suite and enforce a line floor', () => {
  assert.ok(packageJson.devDependencies.c8, 'c8 must be a devDependency');
  assert.equal(packageJson.scripts.coverage, 'c8 npm test', 'the coverage script must run the same suite as `npm test`');
  assert.equal(packageJson.scripts.test, 'node --test tests/*.test.mjs');

  assert.equal(c8Config['check-coverage'], true, 'coverage must be enforced, not just printed');
  assert.ok(Number.isInteger(c8Config.lines) && c8Config.lines > 0, 'a line floor must be set');
  assert.equal(c8Config.all, true, 'untested source files must count against the floor');
  assert.deepEqual(c8Config.reporter, ['text', 'lcovonly'], 'the line total must be printed and a machine-readable report written');
  assert.equal(c8Config['report-dir'], 'coverage');
  assert.ok(
    c8Config.include.some((pattern) => pattern.endsWith('.js')),
    'the report must measure the repository source, not only whatever the tests happen to load',
  );
  assert.ok(c8Config.exclude.includes('tests/**'), 'test code must not inflate the number');
});

test('the linter and type checker the lane measured as missing are configured', () => {
  assert.ok(packageJson.devDependencies.eslint, 'eslint must be a devDependency');
  assert.ok(packageJson.devDependencies.typescript, 'typescript must be a devDependency');
  assert.equal(packageJson.scripts.lint, 'eslint .', 'the lint script must cover the repository');
  assert.equal(packageJson.scripts.typecheck, 'tsc --noEmit', 'type checking must not emit files');

  assert.equal(tsconfig.compilerOptions.noEmit, true);
  assert.equal(tsconfig.compilerOptions.allowJs, true, 'the site is plain JavaScript, so .js must be checked');
  assert.equal(tsconfig.compilerOptions.checkJs, true, 'a type checker that skips the only source file checks nothing');
  assert.equal(tsconfig.compilerOptions.strict, true, 'the type check must be strict');
  assert.ok(tsconfig.include.includes('script.js'), 'script.js is the repository source that must be checked');

  assert.match(eslintConfig, /from '@eslint\/js'/, 'the lint config must build on the recommended rule set');
  assert.match(eslintConfig, /files: \['script\.js'\]/, 'the page script needs its own block');
  assert.match(eslintConfig, /globals\.browser/, 'browser globals must be declared for script.js');
  assert.match(eslintConfig, /globals\.node/, 'the tests run under Node');
});

test('CI gates a pull request on lint, the type check and the coverage runner', () => {
  assert.match(workflow, /^on:\n {2}pull_request:/m, 'pull requests must be gated, not only pushes to main');
  assert.match(workflow, /- name: Install dependencies\n {8}run: npm ci/);
  assert.match(workflow, /- name: Lint \(eslint\)\n {8}run: npm run lint/, 'eslint must run in CI');
  assert.match(workflow, /- name: Type check \(tsc\)\n {8}run: npm run typecheck/, 'tsc must gate a merge');
  assert.match(workflow, /- name: Coverage \(line total \+ floor from \.c8rc\.json\)/, 'the coverage step must be present');
  assert.match(workflow, /npm run coverage/, "CI must run the repository's own coverage command");
  assert.match(workflow, /node-version: '22\.23\.1'/, 'the Node patch that generated the committed report must be pinned');
});

test('the coverage floor the workflow declares is the floor c8 enforces', () => {
  const declared = workflow.match(/COVERAGE_FAIL_UNDER: (\d{1,3})/);
  assert.ok(declared, 'the workflow must declare the coverage floor it expects');
  assert.equal(
    Number(declared[1]),
    c8Config.lines,
    'COVERAGE_FAIL_UNDER in .github/workflows/ci.yml and "lines" in .c8rc.json drifted apart',
  );
});

test('a stale committed coverage report fails the build', () => {
  assert.match(
    workflow,
    /git diff --exit-code -- coverage\/lcov\.info/,
    'CI must refuse a coverage/lcov.info that no longer matches the current source',
  );
});

test('the committed lcov report is real and meets the floor', () => {
  assert.ok(lcov.startsWith('TN:\n'), 'the committed report must be an lcov report');
  assert.ok(lcov.includes('SF:script.js'), 'script.js must be part of the measured source');
  assert.ok(!/(^|\n)SF:\/|(^|\n)SF:[A-Za-z]:/m.test(lcov), 'paths must be repository-relative, never absolute');
  assert.ok(!lcov.includes('node_modules'), 'dependencies must not be measured');

  const { files, found, hit } = lcovTotals(lcov);
  assert.deepEqual(files, ['script.js'], 'the report must cover the repository source and nothing else');
  assert.ok(found > 0, 'a report without executable lines measures nothing');

  const percent = (100 * hit) / found;
  assert.ok(
    percent >= c8Config.lines,
    `the committed report (${percent.toFixed(2)}% of ${found} lines) is below the ${c8Config.lines}% floor`,
  );
});

test('every workflow that runs the suite installs the devDependencies first', () => {
  // `tests/script.test.mjs` boots the page in jsdom, so a workflow that runs the
  // suite on a bare runner fails on a missing module — exactly how this workflow
  // went red on the pull request that added the suite.
  for (const file of ['ci.yml', 'tests.yml']) {
    const workflowFile = read(`.github/workflows/${file}`);
    if (!/npm (test|run coverage)/.test(workflowFile)) continue;
    assert.match(workflowFile, /run: npm ci/, `${file} runs the suite without installing its dependencies`);
  }
  assert.match(
    read('.github/workflows/tests.yml'),
    /run: npm test/,
    'the Tests workflow must run the same command a developer runs locally',
  );
});

test('coverage output is ignored except the committed report', () => {
  const ignored = spawnSync('git', ['check-ignore', '--quiet', 'coverage/lcov.info'], { cwd: root });
  assert.notEqual(ignored.status, 0, 'coverage/lcov.info must be committable — it is our durable evidence');
  const ignoredTmp = spawnSync('git', ['check-ignore', '--quiet', 'coverage/tmp/v8-cov.json'], { cwd: root });
  assert.equal(ignoredTmp.status, 0, 'the rest of coverage/ (c8 scratch output) must stay untracked');
});
