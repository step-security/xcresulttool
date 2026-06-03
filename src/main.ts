import {DefaultArtifactClient} from '@actions/artifact'
import * as core from '@actions/core'
import * as github from '@actions/github'
import axios, {isAxiosError} from 'axios'
import * as path from 'path'
import {Formatter} from './formatter'
import {Octokit} from '@octokit/action'
import {combineReports} from './report'
import {glob} from 'glob'
import * as fs from 'fs'
const {stat} = fs.promises

async function validateSubscription(): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH
  let repoPrivate: boolean | undefined

  if (eventPath && fs.existsSync(eventPath)) {
    const eventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'))
    repoPrivate = eventData?.repository?.private
  }

  const upstream = 'kishikawakatsumi/xcresulttool'
  const action = process.env.GITHUB_ACTION_REPOSITORY
  const docsUrl =
    'https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions'

  core.info('')
  core.info('\u001b[1;36mStepSecurity Maintained Action\u001b[0m')
  core.info(`Secure drop-in replacement for ${upstream}`)
  if (repoPrivate === false)
    core.info('\u001b[32m✓ Free for public repositories\u001b[0m')
  core.info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`)
  core.info('')

  if (repoPrivate === false) return

  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com'
  const body: Record<string, string> = {action: action || ''}
  if (serverUrl !== 'https://github.com') body.ghes_server = serverUrl
  try {
    await axios.post(
      `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
      body,
      {timeout: 3000}
    )
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 403) {
      core.error(
        `\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m`
      )
      core.error(
        `\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`
      )
      process.exit(1)
    }
    core.info('Timeout or API not reachable. Continuing to next step.')
  }
}

async function run(): Promise<void> {
  try {
    await validateSubscription()
    const inputPaths = core.getMultilineInput('path')
    const showPassedTests = core.getBooleanInput('show-passed-tests')
    const showCodeCoverage = core.getBooleanInput('show-code-coverage')
    let uploadBundles = core.getInput('upload-bundles').toLowerCase()
    if (uploadBundles === 'true') {
      uploadBundles = 'always'
    } else if (uploadBundles === 'false') {
      uploadBundles = 'never'
    }

    const bundlePaths: string[] = []
    for (const checkPath of inputPaths) {
      try {
        await stat(checkPath)
        bundlePaths.push(checkPath)
      } catch (error) {
        core.error((error as Error).message)
      }
    }
    let report
    if (bundlePaths.length > 1) {
      const reports = []
      for (const p of bundlePaths) {
        const formatter = new Formatter(p)
        reports.push(
          await formatter.format({showPassedTests, showCodeCoverage})
        )
      }
      report = combineReports(reports)
    } else {
      const formatter = new Formatter(bundlePaths[0])
      report = await formatter.format({showPassedTests, showCodeCoverage})
    }

    if (core.getInput('token')) {
      await core.summary.addRaw(report.reportSummary).write()

      const octokit = new Octokit()

      const owner = github.context.repo.owner
      const repo = github.context.repo.repo

      const pr = github.context.payload.pull_request
      const sha = (pr && pr.head.sha) || github.context.sha

      const charactersLimit = 65535
      let title = core.getInput('title')
      if (title.length > charactersLimit) {
        core.warning(
          `The 'title' will be truncated because the character limit (${charactersLimit}) exceeded.`
        )
        title = title.substring(0, charactersLimit)
      }
      let reportSummary = report.reportSummary
      if (reportSummary.length > charactersLimit) {
        core.warning(
          `The 'summary' will be truncated because the character limit (${charactersLimit}) exceeded.`
        )
        reportSummary = reportSummary.substring(0, charactersLimit)
      }
      let reportDetail = report.reportDetail
      if (reportDetail.length > charactersLimit) {
        core.warning(
          `The 'text' will be truncated because the character limit (${charactersLimit}) exceeded.`
        )
        reportDetail = reportDetail.substring(0, charactersLimit)
      }

      if (report.annotations.length > 50) {
        core.warning(
          'Annotations that exceed the limit (50) will be truncated.'
        )
      }
      const annotations = report.annotations.slice(0, 50)
      let output
      if (reportDetail.trim()) {
        output = {
          title: 'Xcode test results',
          summary: reportSummary,
          text: reportDetail,
          annotations
        }
      } else {
        output = {
          title: 'Xcode test results',
          summary: reportSummary,
          annotations
        }
      }
      await octokit.checks.create({
        owner,
        repo,
        name: title,
        head_sha: sha,
        status: 'completed',
        conclusion: report.testStatus,
        output
      })

      if (
        uploadBundles === 'always' ||
        (uploadBundles === 'failure' && report.testStatus === 'failure')
      ) {
        for (const uploadBundlePath of inputPaths) {
          try {
            await stat(uploadBundlePath)
          } catch (error) {
            continue
          }

          const artifactClient = new DefaultArtifactClient()
          const artifactName = path.basename(uploadBundlePath)

          const rootDirectory = uploadBundlePath

          glob(`${uploadBundlePath}/**/*`, async (error, files) => {
            if (error) {
              core.error(error)
            }
            if (files.length) {
              await artifactClient.uploadArtifact(
                artifactName,
                files,
                rootDirectory
              )
            }
          })
        }
      }
    }
  } catch (error) {
    core.setFailed((error as Error).message)
  }
}

run()
