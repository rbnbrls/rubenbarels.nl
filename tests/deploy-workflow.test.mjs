// Guards the honesty of `.github/workflows/deploy.yml`.
//
// The deploy workflow is the only automatic path from `main` to production for this
// repository, so a green run has to mean "Coolify was asked to build and the build
// finished". Issue #6 was the opposite: the trigger step piped `curl -s` into a
// `python3 -c ... || echo "unknown"` fallback, so Coolify answering
// `{"message":"Unauthenticated."}` produced `deployment_uuid=unknown` and a green job
// while production kept serving the 2026-08-15 build.
//
// These tests execute the real `run:` blocks of the workflow (extracted from the YAML,
// not copied, so they cannot drift) under `bash -e` with a stubbed `curl` on PATH:
// every Coolify answer is played back from a fixture and the step's exit status,
// annotations and `$GITHUB_OUTPUT` are checked.
//
// Run with `npm test` (node --test).

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

const FAKE_TOKEN = 'fake-coolify-token-value-1234567890';
const UNAUTHENTICATED = '{"message":"Unauthenticated."}';
const QUEUED =
  '{"deployments":[{"message":"Application rubenbarels.nl deployment queued.",' +
  '"resource_uuid":"fs3s4diz3zx892uwcjze7hv9","deployment_uuid":"2koexlt0snkfsw5nnxbzz2ly"}]}';
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

// The trigger step resolves its deployment target from Coolify by application
// *name* and only skips that lookup when an explicit `COOLIFY_APP_UUID` is set, so
// the tests that exercise the POST itself pin the uuid and the tests that exercise
// the resolution leave it unset.
const PINNED_ENV = { COOLIFY_APP_UUID: 'pinned-app-uuid' };
const triggerStep = (responses, env = {}) => runStep(TRIGGER_STEP, { responses, env: { ...PINNED_ENV, ...env } });

// Two applications of the live instance, so a name match is a real match and not
// "the only entry in the list".
const applications = (entries) => JSON.stringify(entries);
const LIVE_DEVELOPMENT_APP = {
  uuid: 'wtla19czfxc56jw1zetpww6q',
  name: 'rubenbarels-nl-development',
  fqdn: 'https://slimverlof-nl.7rb.nl',
  git_repository: 'rbnbrls/rubenbarels.nl.git',
};
const LIVE_PRODUCTION_APP = {
  uuid: 'zqwpbdg7mu8dneqnsf1ftahd',
  name: 'rubenbarels-nl-production',
  fqdn: 'https://rubenbarels.nl',
  git_repository: 'rbnbrls/rubenbarels.nl.git',
};

test('trigger step goes green only when Coolify queued a deployment', () => {
  const { status, githubOutput } = triggerStep([`200|${QUEUED}`]);
  assert.equal(status, 0, 'a 200 with a deployment uuid must succeed');
  assert.match(githubOutput, new RegExp(`^deployment_uuid=${QUEUED_UUID}$`, 'm'));
});

test('trigger step fails on the 401 {"message":"Unauthenticated."} body from issue #6', () => {
  const { status, output, githubOutput } = runStep(TRIGGER_STEP, { responses: [`401|${UNAUTHENTICATED}`] });
  assert.notEqual(status, 0, `401 must fail the step, got exit ${status}\n${output}`);
  assert.match(output, /::error/);
  assert.match(output, /Unauthenticated/);
  assert.doesNotMatch(githubOutput, /deployment_uuid=/, 'no uuid may be published on failure');
});

test('trigger step fails when a 2xx body carries no deployments[] entry', () => {
  const bodies = ['{"message":"Application rubenbarels.nl deployment queued."}', '{}', 'null', '[]', '{"deployments":[]}', '{"deployments":[{"message":"queued"}]}'];
  for (const body of bodies) {
    const { status, output, githubOutput } = triggerStep([`200|${body}`]);
    assert.notEqual(status, 0, `200 with ${body} must fail the step, got exit ${status}\n${output}`);
    assert.match(output, /::error/);
    assert.doesNotMatch(githubOutput, /deployment_uuid=/);
  }
});

test('trigger step fails on a non-JSON body', () => {
  const { status, output } = triggerStep(['200|<html>502 Bad Gateway</html>']);
  assert.notEqual(status, 0, 'a non-JSON 200 body must fail the step');
  assert.match(output, /::error/);
});

test('trigger step fails on transport errors and 5xx responses', () => {
  for (const fixture of ['000|', '500|{"message":"Server Error"}', '404|{"message":"No resources found."}']) {
    const { status, output } = triggerStep([fixture]);
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
  const { output } = triggerStep([`200|${QUEUED}`]);
  assert.doesNotMatch(output, new RegExp(FAKE_TOKEN), 'the token must never reach the log');
});

test('trigger step no longer contains the `|| echo unknown` fallback', () => {
  assert.doesNotMatch(stepRun(TRIGGER_STEP), /\|\| echo "unknown"/);
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
    const { status, output, githubOutput } = triggerStep([`200|${body}`]);
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
  assert.equal(trigger.curlCalls.length, 1, 'an explicit uuid must be used as-is, without a lookup');

  const wait = runStep(WAIT_STEP, {
    responses: ['200|{"status":"finished"}'],
    env: { ...FAST_WAIT_ENV, DEPLOYMENT_UUID: QUEUED_UUID, COOLIFY_API_BASE: base },
  });
  assert.equal(wait.status, 0, wait.output);
  assert.match(wait.curlCalls.join(' '), new RegExp(`${escapeRegExp(base)}/deployments/${QUEUED_UUID}`));
});

// Issue #14 (workflow run #12, and #11 before it). The trigger step used to POST an
// application uuid hardcoded in this file, and Coolify answered
// `404 {"message":"No resources found."}` because that application no longer exists:
// the app had been re-created (2026-09-25) and the new record has a different uuid.
// A uuid belongs to one application record, so the step now resolves its target from
// the provider by application *name* — which survives a re-creation — and only
// trusts an explicit `COOLIFY_APP_UUID` override.
test('trigger step resolves the Coolify application by name and deploys it', () => {
  const { status, output, githubOutput, curlCalls } = runStep(TRIGGER_STEP, {
    responses: [`200|${applications([LIVE_DEVELOPMENT_APP, LIVE_PRODUCTION_APP])}`, `200|${QUEUED}`],
  });
  assert.equal(status, 0, `the resolved application must be deployed\n${output}`);
  assert.match(curlCalls[0], /\/applications(\s|$)/, `the first call must read the application list: ${curlCalls[0]}`);
  assert.doesNotMatch(curlCalls[0], /-X POST/, 'the lookup must be a GET');
  assert.match(curlCalls[1], /\/deploy(\s|$)/, `the second call must trigger the deploy: ${curlCalls[1]}`);
  assert.match(
    curlCalls[1],
    new RegExp(escapeRegExp(LIVE_PRODUCTION_APP.uuid)),
    'the uuids must be resolved, not guessed: the deploy must name the production application',
  );
  assert.doesNotMatch(curlCalls[1], new RegExp(escapeRegExp(LIVE_DEVELOPMENT_APP.uuid)), 'the development app must not be deployed');
  assert.match(githubOutput, new RegExp(`^deployment_uuid=${QUEUED_UUID}$`, 'm'));
});

test('the deploy workflow no longer ships an application uuid that can go stale', () => {
  const run = stepRun(TRIGGER_STEP);
  assert.doesNotMatch(run, /fs3s4diz3zx892uwcjze7hv9/, 'the dead application uuid must not come back');
  assert.match(run, /COOLIFY_APP_NAME/, 'the target application must be selected by name');
  assert.match(workflow, /COOLIFY_APP_NAME: \$\{\{ vars\.COOLIFY_APP_NAME \}\}/, 'the name must be overridable per repository');
});

test('trigger step fails closed when no application carries the target name', () => {
  for (const body of [`${applications([LIVE_DEVELOPMENT_APP])}`, '[]']) {
    const { status, output, curlCalls } = runStep(TRIGGER_STEP, { responses: [`200|${body}`] });
    assert.notEqual(status, 0, `an unresolvable target must fail the step\n${output}`);
    const annotation = output.split('\n').find((line) => line.startsWith('::error title=Coolify application not found'));
    assert.ok(annotation, `the missing application must be annotated:\n${output}`);
    assert.ok(annotation.includes('rubenbarels-nl-production'), 'the annotation must name the target that did not resolve');
    assert.equal(curlCalls.length, 1, 'nothing may be deployed when the target does not resolve');
  }
});

test('trigger step fails closed when the target name is ambiguous', () => {
  const twin = { ...LIVE_PRODUCTION_APP, uuid: 'cdyz1bhejvd3swgvvk0cpv9a' };
  const { status, output, curlCalls } = runStep(TRIGGER_STEP, {
    responses: [`200|${applications([LIVE_PRODUCTION_APP, twin])}`],
  });
  assert.notEqual(status, 0, `an ambiguous target must fail the step\n${output}`);
  const annotation = output.split('\n').find((line) => line.startsWith('::error title=Coolify application name is ambiguous'));
  assert.ok(annotation, `the ambiguity must be annotated:\n${output}`);
  assert.ok(annotation.includes(LIVE_PRODUCTION_APP.uuid), 'the annotation must list the candidates');
  assert.ok(annotation.includes(twin.uuid), 'the annotation must list the candidates');
  assert.equal(curlCalls.length, 1, 'nothing may be deployed from an ambiguous match');
});

test('trigger step fails when the application lookup is rejected', () => {
  const { status, output, curlCalls } = runStep(TRIGGER_STEP, { responses: [`401|${UNAUTHENTICATED}`] });
  assert.notEqual(status, 0, 'a rejected lookup must fail the step');
  const annotation = output.split('\n').find((line) => line.startsWith('::error title=Coolify application lookup failed'));
  assert.ok(annotation, `the rejected lookup must be annotated:\n${output}`);
  assert.ok(annotation.includes('Unauthenticated'), 'the annotation must quote the body');
  assert.ok(annotation.includes('COOLIFY_API_TOKEN'), 'a 401 still points at the token secret');
  assert.equal(curlCalls.length, 1, 'no deploy may be attempted without a resolved target');
});

test('trigger step fails when the application lookup answer is unusable', () => {
  for (const body of ['{}', 'null', '"rubenbarels-nl-production"', '<html>502 Bad Gateway</html>']) {
    const { status, output, curlCalls } = runStep(TRIGGER_STEP, { responses: [`200|${body}`] });
    assert.notEqual(status, 0, `200 with ${body} must fail the step, got exit ${status}\n${output}`);
    const annotation = output.split('\n').find((line) => line.startsWith('::error title=Coolify application list is unusable'));
    assert.ok(annotation, `an unusable lookup answer must be annotated as such:\n${output}`);
    assert.equal(curlCalls.length, 1, 'an unusable lookup answer must not be retried or deployed through');
  }
});

test('a resolved application uuid outside [A-Za-z0-9._-] is never deployed', () => {
  const { status, output, curlCalls } = runStep(TRIGGER_STEP, {
    responses: [`200|${applications([{ ...LIVE_PRODUCTION_APP, uuid: 'not a uuid' }])}`, `200|${QUEUED}`],
  });
  assert.notEqual(status, 0, `an unusable uuid must fail the step\n${output}`);
  assert.match(output, /::error title=Coolify returned an unusable application uuid/);
  assert.equal(curlCalls.length, 1, 'the uuid is interpolated into the request body, so it must not be sent');
});

test('a 404 No resources found. names the missing application instead of blaming the token', () => {
  const { status, output } = triggerStep(['404|{"message":"No resources found."}']);
  assert.notEqual(status, 0, 'HTTP 404 must fail the step');
  const annotation = output.split('\n').find((line) => line.startsWith('::error title=Coolify application not found'));
  assert.ok(annotation, `the 404 must be reported as a missing application:\n${output}`);
  assert.ok(annotation.includes('No resources found.'), 'the annotation must quote the body');
  assert.ok(annotation.includes('pinned-app-uuid'), 'the annotation must name the target it used');
  assert.ok(!annotation.includes('rotate'), 'the 404 is not a token problem and must not suggest rotating the secret');
});

test('a multi-line lookup body cannot forge an annotation either', () => {
  const injected = '{"message":"Bad Gateway"}__NL__::error title=forged::pwned';
  const { status, output } = runStep(TRIGGER_STEP, { responses: [`401|${injected}`] });
  assert.notEqual(status, 0, 'a rejected lookup must fail the step');
  assert.ok(
    output.split('\n').some((line) => line.startsWith('::error title=Coolify application lookup failed')),
    `the rejected lookup must be annotated:\n${output}`,
  );
  assert.deepEqual(
    output.split('\n').filter((line) => line.startsWith('::error title=forged')),
    [],
    `the body forged a workflow command:\n${output}`,
  );
  assert.match(output, /Bad Gateway/, 'the annotation must still quote the body');
});

const FAST_WAIT_ENV = { DEPLOYMENT_ATTEMPTS: '2', DEPLOYMENT_WAIT_SECONDS: '0' };
const waitStep = (responses, attempts = FAST_WAIT_ENV.DEPLOYMENT_ATTEMPTS) =>
  runStep(WAIT_STEP, {
    responses,
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

// Kanban t_2b136b43. The poll used to run its whole 60 × 20s budget for every failure
// mode (a token revoked mid-run, a 404 body, a transport error, a 2xx body without a
// status) and then fail with a timeout that hid the real reason. Those tests pin the
// fail-fast behaviour: stop at the first unusable answer, quote the HTTP code and body.
const FULL_BUDGET = '60';

test('wait step fails fast when the token dies mid-run (401 on a later poll)', () => {
  const { status, output, curlCalls } = waitStep(['200|{"status":"building"}', `401|${UNAUTHENTICATED}`], FULL_BUDGET);
  assert.notEqual(status, 0, `a mid-run 401 must fail the step, got exit ${status}\n${output}`);
  assert.match(output, /::error/);
  assert.match(output, /HTTP 401/);
  assert.match(output, /Unauthenticated/);
  assert.match(output, /COOLIFY_API_TOKEN/);
  assert.doesNotMatch(output, /did not reach 'finished'/, 'the timeout message must not mask the 401');
  assert.equal(curlCalls.length, 2, `the loop must stop at the first rejected poll, not keep polling (${curlCalls.length} polls)`);
});

test('wait step fails fast on every other non-2xx poll, quoting the code and the body', () => {
  for (const [code, body] of [
    ['503', '{"message":"Server Error"}'],
    ['404', '{"message":"Deployment not found."}'],
    ['429', '{"message":"Too Many Requests"}'],
  ]) {
    const { status, output, curlCalls } = waitStep(['200|{"status":"in_progress"}', `${code}|${body}`], FULL_BUDGET);
    assert.notEqual(status, 0, `HTTP ${code} must fail the step, got exit ${status}\n${output}`);
    assert.match(output, /::error/);
    assert.match(output, new RegExp(`HTTP ${code}`), 'the annotation must quote the HTTP code');
    assert.ok(output.includes(body), `the annotation must quote the body: ${body}`);
    assert.doesNotMatch(output, /did not reach 'finished'/);
    assert.equal(curlCalls.length, 2, `HTTP ${code} must stop the loop`);
  }
});

test('wait step fails fast when the poll reports no usable HTTP status', () => {
  // `000` makes the stub behave like a transport error (no code on stdout at all);
  // `abc` mimics a curl that printed something non-numeric. Both used to reach
  // `[ "${HTTP_CODE}" -lt 200 ]` and die with "integer expression expected".
  for (const fixture of ['000|', 'abc|']) {
    const { status, output, curlCalls } = waitStep([fixture, '200|{"status":"finished"}'], FULL_BUDGET);
    assert.notEqual(status, 0, `${fixture} must fail the step, got exit ${status}\n${output}`);
    assert.match(output, /::error/);
    assert.match(output, /HTTP 000/, 'a missing status code must be reported as 000');
    assert.doesNotMatch(output, /integer expression expected/, 'a missing code must not surface as an arithmetic error');
    assert.doesNotMatch(output, /did not reach 'finished'/);
    assert.equal(curlCalls.length, 1, 'an unusable answer must not be retried');
  }
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
    const { status, output, curlCalls } = waitStep([`200|${body}`], FULL_BUDGET);
    assert.notEqual(status, 0, `200 with ${body} must fail the step, got exit ${status}\n${output}`);
    assert.match(output, /::error/);
    assert.match(output, /HTTP 200/);
    assert.ok(output.includes(body), `the annotation must quote the body: ${body}`);
    assert.doesNotMatch(output, /did not reach 'finished'/, 'an unusable body must not be retried for the full budget');
    assert.equal(curlCalls.length, 1);
  }
});

test('wait step fails before polling at all when the token secret is unset', () => {
  const { status, output, curlCalls } = runStep(WAIT_STEP, {
    responses: ['200|{"status":"finished"}'],
    token: '',
    env: { ...FAST_WAIT_ENV, DEPLOYMENT_UUID: QUEUED_UUID },
  });
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

test('wait step fails when the trigger step produced no uuid', () => {
  const { status, output } = runStep(WAIT_STEP, { responses: ['200|{"status":"finished"}'], env: FAST_WAIT_ENV });
  assert.notEqual(status, 0, 'a missing uuid must not be treated as success');
  assert.match(output, /::error/);
});

test('deploy workflow deploys on push to main and can be re-run by hand', () => {
  assert.match(workflow, /push:\s*\n\s*branches:\s*\[\s*main\s*\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /timeout-minutes:\s*\d+/, 'the job must be bounded by a timeout');
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
    const { status, output } = triggerStep([fixture]);
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
