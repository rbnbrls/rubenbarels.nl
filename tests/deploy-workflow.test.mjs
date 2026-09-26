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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
printf '%s\n' "$*" >> "\${DIR}/curl_calls"
COUNT_FILE="\${DIR}/call_count"
N="$(cat "\${COUNT_FILE}" 2>/dev/null || echo 0)"
N=$((N + 1))
printf '%s' "\${N}" > "\${COUNT_FILE}"

SPEC="$(awk -v n="\${N}" '{ lines[NR] = $0 } END { print (n > NR ? lines[NR] : lines[n]) }' "\${DIR}/responses")"
CODE="\${SPEC%%|*}"
BODY="\${SPEC#*|}"
# __NL__ stands in for a real newline: the fixtures are line-based, but a
# multi-line Coolify body is exactly the injection case being tested.
BODY="\${BODY//__NL__/$'\\n'}"

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

// Records every `sleep` the step performs, so a test can prove the poll loop does not
// sleep after its final attempt (which is what parked the old budget on the timeout).
const SLEEP_STUB = `#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "\${MOCK_DIR:?MOCK_DIR must be set}/sleeps"
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
    const sleep = path.join(bin, 'sleep');
    writeFileSync(sleep, SLEEP_STUB);
    chmodSync(sleep, 0o755);
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
    const recorded = (name) => {
      const file = path.join(dir, name);
      return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    };
    return {
      status: proc.status,
      output: `${proc.stdout ?? ''}${proc.stderr ?? ''}`,
      githubOutput: readFileSync(githubOutput, 'utf8'),
      // One entry per `curl` invocation (its argv) and per `sleep` invocation, so a
      // test can assert how many polls a step made, where it polled, and whether it
      // slept after its final attempt.
      curlCalls: recorded('curl_calls'),
      sleeps: recorded('sleeps'),
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

test('wait step fails fast when a 2xx body carries no usable status', () => {
  const bodies = [
    '<html>502 Bad Gateway</html>',
    '{"message":"Deployment not found."}',
    'null',
    '[]',
    '{}',
    '{"status":null}',
    '{"status":1234}',
  ];
  for (const body of bodies) {
    const { status, output, curlCalls } = waitStep([`200|${body}`], '60');
    assert.notEqual(status, 0, `200 with ${body} must fail the step, got exit ${status}\n${output}`);
    assert.match(output, /::error/);
    assert.match(output, /HTTP 200/);
    assert.ok(output.includes(body), `the annotation must quote the body: ${body}`);
    assert.doesNotMatch(output, /did not reach 'finished'/, 'an unusable body must not be retried for the full budget');
    assert.equal(curlCalls.length, 1);
  }
});

test('wait step fails fast when the status endpoint rejects the request', () => {
  // A revoked token, a vanished deployment record or any other rejected poll must not
  // burn the whole ~20 minute poll window before failing with a generic timeout
  // message: it must stop at the first bad answer and quote the HTTP code and body
  // (kanban t_2b136b43).
  const fixtures = [
    ['401', '{"message":"Unauthenticated."}'],
    ['403', '{"message":"Forbidden."}'],
    ['404', '{"message":"No resources found."}'],
    ['429', '{"message":"Too Many Requests"}'],
    ['503', '{"message":"Server Error"}'],
  ];
  for (const [code, body] of fixtures) {
    const { status, output, curlCalls } = waitStep([`${code}|${body}`]);
    assert.notEqual(status, 0, `HTTP ${code} must fail the step\n${output}`);
    assert.match(output, /::error/);
    assert.match(output, new RegExp(`HTTP ${code}`), `the annotation must name the HTTP status\n${output}`);
    assert.ok(output.includes(body), `the annotation must quote the body\n${output}`);
    assert.doesNotMatch(output, /\[2\/2\]/, `a rejected poll must not keep retrying\n${output}`);
    assert.equal(curlCalls.length, 1, `HTTP ${code} must stop the loop, not keep polling`);
  }
});

test('wait step fails fast when the token dies mid-run (401 on a later poll)', () => {
  const { status, output, curlCalls } = waitStep(['200|{"status":"building"}', `401|${UNAUTHENTICATED}`], '60');
  assert.notEqual(status, 0, `a mid-run 401 must fail the step, got exit ${status}\n${output}`);
  assert.match(output, /::error/);
  assert.match(output, /HTTP 401/);
  assert.match(output, /Unauthenticated/);
  assert.match(output, /COOLIFY_API_TOKEN/);
  assert.doesNotMatch(output, /did not reach 'finished'/, 'the timeout message must not mask the 401');
  assert.equal(curlCalls.length, 2, `the loop must stop at the first rejected poll, not keep polling (${curlCalls.length} polls)`);
});

test('wait step fails fast when the poll reports no usable HTTP status', () => {
  // `000` makes the stub behave like a transport error (no code on stdout at all);
  // `abc` mimics a curl that printed something non-numeric. Both used to be retried
  // for the whole budget (and a non-numeric code died with "integer expression
  // expected" instead of an annotation).
  for (const fixture of ['000|', 'abc|']) {
    const { status, output, curlCalls } = waitStep([fixture, '200|{"status":"finished"}'], '60');
    assert.notEqual(status, 0, `${fixture} must fail the step, got exit ${status}\n${output}`);
    assert.match(output, /::error/);
    assert.match(output, /HTTP 000/, 'a missing status code must be reported as 000');
    assert.doesNotMatch(output, /integer expression expected/, 'a missing code must not surface as an arithmetic error');
    assert.doesNotMatch(output, /did not reach 'finished'/);
    assert.equal(curlCalls.length, 1, 'an unusable answer must not be retried');
  }
});

test('wait step fails when the trigger step produced no uuid', () => {
  const { status, output } = runStep(WAIT_STEP, { responses: ['200|{"status":"finished"}'], env: FAST_WAIT_ENV });
  assert.notEqual(status, 0, 'a missing uuid must not be treated as success');
  assert.match(output, /::error/);
});

test('wait step fails with an actionable message when the token secret is unset', () => {
  const { status, output, curlCalls } = waitStep(['200|{"status":"finished"}'], FAST_WAIT_ENV.DEPLOYMENT_ATTEMPTS, '');
  assert.notEqual(status, 0, 'an empty COOLIFY_API_TOKEN must fail the step');
  assert.match(output, /::error/);
  assert.match(output, /COOLIFY_API_TOKEN/);
  assert.equal(curlCalls.length, 0, 'no poll may be attempted without a token');
});

test('wait step does not sleep after its final attempt', () => {
  const { status, output, sleeps } = waitStep(['200|{"status":"in_progress"}'], '3');
  assert.notEqual(status, 0, 'a deployment that never finishes must not be reported as success');
  assert.match(output, /::error/);
  assert.match(output, /did not reach 'finished'/);
  assert.equal(sleeps.length, 2, `three attempts must sleep twice, not ${sleeps.length} times`);
});

test('the job timeout leaves headroom above the worst-case poll budget', () => {
  const timeout = Number(workflow.match(/timeout-minutes:\s*(\d+)/)?.[1]);
  const attempts = Number(workflow.match(/DEPLOYMENT_ATTEMPTS:\s*"(\d+)"/)?.[1]);
  const wait = Number(workflow.match(/DEPLOYMENT_WAIT_SECONDS:\s*"(\d+)"/)?.[1]);
  assert.ok(
    Number.isFinite(timeout) && Number.isFinite(attempts) && Number.isFinite(wait),
    'the job timeout and the poll budget must be declared in the workflow',
  );
  // The final attempt no longer sleeps, so the worst case is (attempts - 1) sleeps.
  const budgetSeconds = (attempts - 1) * wait;
  assert.ok(
    timeout * 60 >= budgetSeconds + 600,
    `timeout-minutes: ${timeout} must exceed the ${budgetSeconds}s poll budget by at least 10 min of curl overhead`,
  );
});

test('trigger step refuses to publish a uuid outside [A-Za-z0-9._-]', () => {
  // The uuid is written to $GITHUB_OUTPUT, so an unexpected payload must not be able
  // to publish a line of its own (kanban t_2b136b43, item 3).
  const bodies = [
    '{"deployments":[{"deployment_uuid":"bad uuid"}]}',
    '{"deployments":[{"deployment_uuid":"a;b"}]}',
    '{"deployments":[{"deployment_uuid":"evil\\nmy_output=1"}]}',
  ];
  for (const body of bodies) {
    const { status, output, githubOutput } = runStep(TRIGGER_STEP, { responses: [`200|${body}`] });
    assert.notEqual(status, 0, `200 with ${body} must fail the step, got exit ${status}\n${output}`);
    assert.match(output, /::error/);
    assert.doesNotMatch(githubOutput, /deployment_uuid=/, 'no uuid may be published for an unexpected payload');
  }
});

test('the Coolify API base and app uuid can be overridden per repository', () => {
  // Item 5 of kanban t_2b136b43: repo variables win over the fleet defaults, so one
  // workflow body can serve the whole fleet without losing this repo's own values.
  const base = 'https://coolify.example.test/api/v1';
  const trigger = runStep(TRIGGER_STEP, {
    responses: [`200|${QUEUED}`],
    env: { COOLIFY_API_BASE: base, COOLIFY_APP_UUID: 'overridden-app-uuid' },
  });
  assert.equal(trigger.status, 0, trigger.output);
  assert.match(trigger.curlCalls.join(' '), new RegExp(`${escapeRegExp(base)}/deploy`));
  assert.match(trigger.curlCalls.join(' '), /overridden-app-uuid/);

  const wait = runStep(WAIT_STEP, {
    responses: ['200|{"status":"finished"}'],
    env: { ...FAST_WAIT_ENV, DEPLOYMENT_UUID: QUEUED_UUID, COOLIFY_API_BASE: base },
  });
  assert.equal(wait.status, 0, wait.output);
  assert.match(wait.curlCalls.join(' '), new RegExp(`${escapeRegExp(base)}/deployments/${QUEUED_UUID}`));
});

test('deploy workflow deploys on push to main, can be re-run by hand and is bounded', () => {
  assert.match(workflow, /push:\s*\n\s*branches:\s*\[\s*main\s*\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /timeout-minutes:\s*\d+/, 'the job must be bounded by a timeout');
});

test('deploy workflow targets the rubenbarels.nl Coolify application', () => {
  assert.match(workflow, new RegExp(APP_UUID), 'the workflow must target the rubenbarels.nl Coolify app');
});

// Kanban t_0838bbdf. GitHub parses a step's stdout for workflow commands, so text
// that came from Coolify must never reach a log line with its line breaks intact: a
// body (or a `status` value carrying an escaped \n) whose second line is
// `::error title=forged::` would otherwise forge an annotation in the run an operator
// is reading. Fixtures spell a real newline __NL__ (see the curl stub).
const hostileBody = '{"message":"Bad Gateway"}__NL__::error title=forged::pwned';
const forgedLines = (output) =>
  output.split('\n').filter((line) => line.startsWith('::error title=forged'));

test('a multi-line Coolify body cannot forge an annotation from the trigger step', () => {
  for (const fixture of [`200|${hostileBody}`, `401|${hostileBody}`]) {
    const { status, output } = runStep(TRIGGER_STEP, { responses: [fixture] });
    assert.notEqual(status, 0, `${fixture} must fail the step`);
    assert.deepEqual(forgedLines(output), [], `the body forged a workflow command:\n${output}`);

    const annotation = output.split('\n').find((line) => line.startsWith('::error title=Coolify '));
    assert.ok(annotation, `the real annotation must still be emitted:\n${output}`);
    assert.ok(annotation.includes('Bad Gateway'), 'the annotation must still quote the body');
    assert.ok(
      annotation.includes('::error title=forged::pwned'),
      'the annotation must still quote the body, on one line',
    );
  }
});

test('a status carrying an escaped newline cannot forge a line in the wait step', () => {
  const { status, output } = waitStep(['200|{"status":"pending\\n::error title=forged::pwned"}'], '2');
  assert.notEqual(status, 0, 'a deployment that never reaches a terminal status must fail');
  assert.deepEqual(forgedLines(output), [], `the status forged a workflow command:\n${output}`);
  assert.match(output, /status pending ::error title=forged::pwned/, 'the status must be logged on one line');
  assert.match(
    output,
    /last status: pending ::error title=forged::pwned/,
    'the timeout annotation must quote the status on one line',
  );
});
