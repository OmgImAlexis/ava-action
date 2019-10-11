/* eslint-disable camelcase */

const {promisify} = require('util');
const path = require('path');
const core = require('@actions/core');
const {exec} = require('child_process');
const github = require('@actions/github');

const promisifiedExec = promisify(exec);
const workspace = process.env.GITHUB_WORKSPACE;

// Returns results from ava command
const runAva = async options => {
  const binDirPath = path.join(workspace, 'node_modules', '.bin');
  const avaPath = path.join(binDirPath, 'ava');
  const avaTapPath = path.join(binDirPath, 'ava-tap-json-parser');
  const ava = `${avaPath} ${options.join(' ')}`;
  const avaCommand = `${ava} | ${avaTapPath}`;
  const parseStdout = ({stdout}) => JSON.parse(stdout);

  return promisifiedExec(avaCommand, {
    cwd: workspace
  })
    .then(parseStdout)
    .catch(parseStdout);
};

const updateCheck = async ({summary, conclusion, annotations}) => {
  const client = new github.GitHub(process.env.GITHUB_TOKEN);
  const {sha: head_sha, action: title, ref} = github.context;
  const {owner, repo} = github.context.repo;

  const checkRuns = await client.checks
    .listForRef({owner, repo, ref})
    .then(({data}) => data.check_runs);

  // User must provide the check run's name
  // so we can match it up with the correct run
  const checkName = core.getInput('check_name') || 'lint';
  let checkNameRun = checkRuns.find(check => check.name === checkName);

  // Bail if we have more than one check and there's no named run found
  if (checkRuns.length >= 2 && !checkNameRun) {
    core.debug(`Couldn't find a check run matching "${checkName}".`);

    // Create new check run as we couldn't find a matching one.
    await client.checks.create({
      ...github.context.repo,
      name: checkName,
      head_sha,
      started_at: new Date().toISOString()
    });

    const checkRuns = await client.checks
      .listForRef({owner, repo, ref})
      .then(({data}) => data.check_runs);

    checkNameRun = checkRuns.find(check => check.name === checkName);
  }

  const checkRunId = checkRuns.length >= 2 ? checkNameRun.id : checkRuns[0].id;

  await client.checks.update({
    ...github.context.repo,
    check_run_id: checkRunId,
    completed_at: new Date().toISOString(),
    conclusion,
    output: {
      title,
      summary:
        conclusion === 'success'
          ? 'All tests passed!'
          : 'Not all tests passed.',
      text:
        conclusion === 'success'
          ? ':tada: All tests passed!'
          : summary.join('\n'),
      annotations: annotations.slice(0, 49)
    }
  });
};

const run = async () => {
  try {
    const annotations = [];
    const summary = [];

    // Run ava command
    const results = await runAva(['--tap']).catch(error => {
      core.setFailed(error.message);
      return [];
    });

    const errorCount = results.testsFailed;
    const conclusion = errorCount >= 1 ? 'failure' : 'success';

    for (const test of results.failedTests) {
      const {path, startLine, endLine, name} = test;

      annotations.push({
        title: name,
        path,
        start_line: startLine,
        end_line: endLine,
        annotation_level: 'failure',
        message: `\`${test.stackTrace.stackTrace.Difference}\``
        // raw_details: ''
      });
    }

    if (errorCount > 0) {
      summary.push(
        `:x: ${errorCount} test${errorCount === 1 ? '' : 's'} failed.`
      );
    }

    if (process.env.DEBUG) {
      console.info({summary, conclusion, annotations, errorCount, results});
    } else {
      await updateCheck({summary, conclusion, annotations}).catch(error => {
        core.setFailed(error.message);
      });
    }

    if (errorCount > 0) {
      core.setFailed(`:x: Some test${errorCount === 1 ? '' : 's'} failed!`);
      return;
    }

    // Tools.exit.success(':white_check_mark: All tests passed!');
  } catch (error) {
    core.setFailed(error.message);
  }
};

run();
