// Guards the honesty of `.github/workflows/deploy.yml`.
//
// The deploy workflow is the only automatic path from `main` to production for
// this repository, so a green run has to mean "Coolify was asked to build and
// the build finished". Before this change the trigger step piped `curl -s` into
// a `python3 -c ... || echo "unknown"` fallback, so Coolify answering
// `{"message":"Unauthenticated."}`, a 404, a 5xx, a transport error, or a 2xx
// body without a `deployments` key all produced `deployment_uuid=unknown` and a
// green job while nothing was deployed. There was no wait step either, so a
// Coolify build that failed after being queued also stayed green.
//
// These tests execute the real `run:` blocks of the workflow (extracted from the
// YAML, not copied, so they cannot drift) under `bash -e` with a stubbed `curl`
// on PATH: every Coolify answer is played back from a fixture and the step's
// exit status, annotations and `$GITHUB_OUTPUT` are checked.
//
// Run with: node --test tests/*.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.join(here, '..', '.github', 'workflows', 'deploy.yml');
const workflow = readFileSync(workflowPath, 'utf8');

const TRIGGER_STEP = 'Trigger Coolify deployment';
const WAIT_STEP = 'Wait for Coolify deployment to finish';

const APP_UUID = 'fs3s4diz3zx892uwcjze7hv9';
const FAKE_TOKEN = 'fake-coolify-token-value-1234567890';
const UNAUTHENTICATED = '{"message":"Unauthenticated."}';
const QUEUED =
  '{"deployments":[{"message":"Application rubenbarels.nl deployment queued.",' +
  `"resource_uuid":"${APP_UUID}","deployment_uuid":"2koexlt0snkfsw5nnxbzz2ly"}]}`;
const QUEUED_UUID = '2koexlt0snkfsw5nnxbzz2ly';

// Plays back one `code|body` fixture per call (the last one repeats) and mimics the
// curl flags the workflow uses, including --fail/--fail-with-body's exit status.
const CURL_STUB = `#!/usr/bin/env bash
set -u
DIR="\${MOCK_DIR:?MOCK_DIR must be set}"
COUNT_FILE="\${DIR}/call_count"
N="$(cat "\${COUNT_FILE}" 2>/dev/null || echo 0)"
N=$((N + 1))
printf '%s' "\${N}" > "\${COUNT_FILE}"

SPEC="$(awk -v n="\${N}" '{ lines[NR] = $0 } END { print (n > NR ? lines[NR] : lines[n]) }' "\${DIR}/responses")"
CODE="\${SPEC%%|*}"
BODY="\${SPEC#*|}"

fail_on_error=0
out=""
fmt=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --fail|--fail-with-body) fail_on_error=1; shift ;;
    -o) out="$2"; shift 2 ;;
    -w) fmt="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ "\${CODE}" = "000" ]; then
  echo "curl: (7) Failed to connect to dev.7rb.nl port 443" >&2
  exit 7
fi

if [ -n "\${out}" ]; then
  printf '%s' "\${BODY}" > "\${out}"
else
  printf '%s' "\${BODY}"
fi
if [ -n "\${fmt}" ]; then
  printf '%s' "\${CODE}"
fi
case "\${CODE}" in
  4*|5*) [ "\${fail_on_error}" = "1" ] && exit 22 ;;
esac
exit 0
`;

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The dedented `run: |` script of the step called `stepName`. */
function stepRun(stepName) {
  const lines = workflow.split('\n');
  const namePattern = new RegExp(`^\\s*- name:\\s*${escapeRegExp(stepName)}\\s*$`);
  const start = lines.findIndex((line) => namePattern.test(line));
  assert.ok(start >= 0, `step "${stepName}" not found in ${workflowPath}`);

  let runIndex = -1;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*- name:/.test(lines[index])) break;
    if (/^\s*run:\s*\|\s*$/.test(lines[index])) {
      runIndex = index;
      break;
    }
  }
  assert.ok(runIndex >= 0, `step "${stepName}" has no \`run: |\` block`);

  const blockIndent = lines[runIndex].match(/^\s*/)[0].length;
  const bodyIndent = blockIndent + 2;
  const body = [];
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      body.push('');
      continue;
    }
    if (line.match(/^\s*/)[0].length < bodyIndent) break;
    body.push(line.slice(bodyIndent));
  }
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return `${body.join('\n')}\n`;
}

/** Runs a workflow step's shell with a stubbed curl and returns its observable result. */
function runStep(stepName, { responses, token = FAKE_TOKEN, env = {} }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'deploy-workflow-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    const curl = path.join(bin, 'curl');
    writeFileSync(curl, CURL_STUB);
    chmodSync(curl, 0o755);
    writeFileSync(path.join(dir, 'responses'), `${responses.join('\n')}\n`);

    const stepFile = path.join(dir, 'step.sh');
    writeFileSync(stepFile, stepRun(stepName));
    const githubOutput = path.join(dir, 'github_output');
    writeFileSync(githubOutput, '');

    // GitHub Actions runs `run:` blocks as `bash -e <file>`.
    const proc = spawnSync('bash', ['-e', stepFile], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        MOCK_DIR: dir,
        GITHUB_OUTPUT: githubOutput,
        COOLIFY_API_TOKEN: token,
        ...env,
      },
    });
    return {
      status: proc.status,
      output: `${proc.stdout ?? ''}${proc.stderr ?? ''}`,
      githubOutput: readFileSync(githubOutput, 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('trigger step goes green only when Coolify queued a deployment', () => {
  const { status, githubOutput } = runStep(TRIGGER_STEP, { responses: [`200|${QUEUED}`] });
  assert.equal(status, 0, 'a 200 with a deployment uuid must succeed');
  assert.match(githubOutput, new RegExp(`^deployment_uuid=${QUEUED_UUID}$`, 'm'));
});

test('trigger step fails on the 401 {"message":"Unauthenticated."} body', () => {
  const { status, output, githubOutput } = runStep(TRIGGER_STEP, { responses: [`401|${UNAUTHENTICATED}`] });
  assert.notEqual(status, 0, `401 must fail the step, got exit ${status}\n${output}`);
  assert.match(output, /::error/);
  assert.match(output, /Unauthenticated/);
  assert.doesNotMatch(githubOutput, /deployment_uuid=/, 'no uuid may be published on failure');
});

test('trigger step fails when a 2xx body carries no deployments[] entry', () => {
  const bodies = [
    '{"message":"Application rubenbarels.nl deployment queued."}',
    '{}',
    'null',
    '[]',
    '{"deployments":[]}',
    '{"deployments":[{"message":"queued"}]}',
  ];
  for (const body of bodies) {
    const { status, output, githubOutput } = runStep(TRIGGER_STEP, { responses: [`200|${body}`] });
    assert.notEqual(status, 0, `200 with ${body} must fail the step, got exit ${status}\n${output}`);
    assert.match(output, /::error/);
    assert.doesNotMatch(githubOutput, /deployment_uuid=/);
  }
});

test('trigger step fails on a non-JSON body', () => {
  const { status, output } = runStep(TRIGGER_STEP, { responses: ['200|<html>502 Bad Gateway</html>'] });
  assert.notEqual(status, 0, 'a non-JSON 200 body must fail the step');
  assert.match(output, /::error/);
});

test('trigger step fails on transport errors and non-2xx responses', () => {
  for (const fixture of ['000|', '500|{"message":"Server Error"}', '404|{"message":"No resources found."}']) {
    const { status, output } = runStep(TRIGGER_STEP, { responses: [fixture] });
    assert.notEqual(status, 0, `${fixture} must fail the step, got exit ${status}\n${output}`);
    assert.match(output, /::error/);
  }
});

test('trigger step fails with an actionable message when the token secret is unset', () => {
  const { status, output } = runStep(TRIGGER_STEP, { responses: [`401|${UNAUTHENTICATED}`], token: '' });
  assert.notEqual(status, 0, 'an empty COOLIFY_API_TOKEN must fail the step');
  assert.match(output, /::error/);
  assert.match(output, /COOLIFY_API_TOKEN/);
});

test('trigger step never prints the API token', () => {
  const { output } = runStep(TRIGGER_STEP, { responses: [`200|${QUEUED}`] });
  assert.doesNotMatch(output, new RegExp(FAKE_TOKEN), 'the token must never reach the log');
});

test('trigger step builds the Authorization header from the token env var', () => {
  const script = stepRun(TRIGGER_STEP);
  assert.match(
    script,
    /Authorization: Bearer \$\{COOLIFY_API_TOKEN\}/,
    'the header must interpolate the COOLIFY_API_TOKEN env var, never a literal',
  );
  assert.doesNotMatch(script, /Bearer \$\{\$\{\s*secrets\./, 'the env indirection is what keeps the token out of the log');
});

test('trigger step no longer contains the `|| echo "unknown"` fallback', () => {
  assert.doesNotMatch(stepRun(TRIGGER_STEP), /\|\| echo "unknown"/);
});

const FAST_WAIT_ENV = { DEPLOYMENT_ATTEMPTS: '2', DEPLOYMENT_WAIT_SECONDS: '0' };
const waitStep = (responses, attempts = FAST_WAIT_ENV.DEPLOYMENT_ATTEMPTS, token = FAKE_TOKEN) =>
  runStep(WAIT_STEP, {
    responses,
    token,
    env: { ...FAST_WAIT_ENV, DEPLOYMENT_ATTEMPTS: attempts, DEPLOYMENT_UUID: QUEUED_UUID },
  });

test('wait step is green once Coolify reports the deployment finished', () => {
  const { status } = waitStep(['200|{"status":"queued"}', '200|{"status":"building"}', '200|{"status":"finished"}'], '3');
  assert.equal(status, 0, 'a finished deployment must be green');
});

test('wait step fails when the Coolify build fails', () => {
  const { status, output } = waitStep(['200|{"status":"building"}', '200|{"status":"failed"}']);
  assert.notEqual(status, 0, 'a failed deployment must turn the job red');
  assert.match(output, /::error/);
});

test('wait step fails when the deployment never reaches a terminal status', () => {
  const { status, output } = waitStep(['200|{"status":"in_progress"}']);
  assert.notEqual(status, 0, 'a deployment that never finishes must not be reported as success');
  assert.match(output, /::error/);
});

test('wait step fails when the status response cannot be parsed', () => {
  const { status, output } = waitStep(['200|<html>502 Bad Gateway</html>']);
  assert.notEqual(status, 0, 'an unparsable status must not be treated as success');
  assert.match(output, /::error/);
});

test('wait step fails fast when the status endpoint rejects the request', () => {
  // A revoked token or a vanished deployment record must not burn the whole
  // ~20 minute poll window before failing with a generic timeout message.
  const fixtures = ['401|{"message":"Unauthenticated."}', '403|{"message":"Forbidden."}', '404|{"message":"No resources found."}'];
  for (const fixture of fixtures) {
    const { status, output } = waitStep([fixture]);
    assert.notEqual(status, 0, `${fixture} must fail the step\n${output}`);
    assert.match(output, /::error/);
    assert.match(output, /HTTP (401|403|404)/, `the annotation must name the HTTP status\n${output}`);
    assert.doesNotMatch(output, /\[2\/2\]/, `a rejected poll must not keep retrying\n${output}`);
  }
});

test('wait step fails when the trigger step produced no uuid', () => {
  const { status, output } = runStep(WAIT_STEP, { responses: ['200|{"status":"finished"}'], env: FAST_WAIT_ENV });
  assert.notEqual(status, 0, 'a missing uuid must not be treated as success');
  assert.match(output, /::error/);
});

test('wait step fails with an actionable message when the token secret is unset', () => {
  const { status, output } = waitStep(['200|{"status":"finished"}'], FAST_WAIT_ENV.DEPLOYMENT_ATTEMPTS, '');
  assert.notEqual(status, 0, 'an empty COOLIFY_API_TOKEN must fail the step');
  assert.match(output, /::error/);
  assert.match(output, /COOLIFY_API_TOKEN/);
});

test('deploy workflow deploys on push to main, can be re-run by hand and is bounded', () => {
  assert.match(workflow, /push:\s*\n\s*branches:\s*\[\s*main\s*\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /timeout-minutes:\s*\d+/, 'the job must be bounded by a timeout');
});

test('deploy workflow targets the rubenbarels.nl Coolify application', () => {
  assert.match(workflow, new RegExp(APP_UUID), 'the workflow must target the rubenbarels.nl Coolify app');
});
