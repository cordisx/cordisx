import path from 'node:path'
import { exportFeedbackBundle, inspectFeedbackArchive, inspectFeedbackBundle } from '../feedback/archive.js'
import { collectFeedback } from '../feedback/collector.js'
import { type FeedbackResult } from '../feedback/contracts.js'
import { type CordisXFeedbackInvocation } from './parse.js'
import { type CordisXCliRuntime } from './run-support.js'

const FEEDBACK_HELP = `Usage:
  cordisx feedback collect [app] [profile] [--recent] [--since 15m | --from ISO --until ISO] [--description-file path] [--output directory] [--max-bytes bytes] [--json]
  cordisx feedback inspect <bundle-directory> [--json]
  cordisx feedback export <bundle-directory> [--output archive.zip] [--format zip] [--json]`

function summary(manifest: Awaited<ReturnType<typeof inspectFeedbackBundle>>): FeedbackResult['summary'] {
  return {
    launches: manifest.selection.launchId === null ? 0 : 1,
    includedArtifacts: manifest.artifacts.length,
    excludedCategories: manifest.exclusions.length,
    missingSources: manifest.missing.length,
    redactions: manifest.redactions.total,
    bytes: manifest.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
  }
}

function output(runtime: CordisXCliRuntime, json: boolean, value: unknown): void {
  const source = JSON.stringify(value)
  ;(runtime.stdout ?? console.log)(json ? source : typeof value === 'string' ? value : source)
}

export async function runFeedbackCommand(
  invocation: CordisXFeedbackInvocation,
  runtime: CordisXCliRuntime,
): Promise<void> {
  if (invocation.feedbackAction === 'help') {
    output(runtime, false, FEEDBACK_HELP)
    return
  }
  if (invocation.feedbackAction === 'collect') {
    output(runtime, invocation.json, await collectFeedback(invocation, runtime))
    return
  }
  const bundlePath = path.resolve(invocation.input!)
  const manifest = path.extname(bundlePath) === '.zip'
    ? await inspectFeedbackArchive(bundlePath)
    : await inspectFeedbackBundle(bundlePath)
  if (invocation.feedbackAction === 'inspect') {
    output(runtime, invocation.json, {
      status: 'inspected',
      bundlePath,
      manifestPath: path.join(bundlePath, 'manifest.json'),
      bundleId: manifest.bundleId,
      summary: summary(manifest),
    })
    return
  }
  const archivePath = invocation.output === undefined ? `${bundlePath}.zip` : path.resolve(invocation.output)
  const archive = await exportFeedbackBundle(bundlePath, archivePath)
  output(runtime, invocation.json, {
    status: 'exported',
    bundlePath,
    manifestPath: path.join(bundlePath, 'manifest.json'),
    bundleId: manifest.bundleId,
    archivePath,
    summary: summary(manifest),
    archive,
  })
}
