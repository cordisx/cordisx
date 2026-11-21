import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { loadHomeConfig } from '../config/home-config.js'
import { prepareApprovalReviewCatalog } from './approval-review-catalog.js'
import { resolveBundledCodexCliPath } from './native-submission-composition.js'

/** Review policy must be prepared before launching the App's native app-server. */
export async function prepareDesktopReviewCatalog(input: {
  configPath: string
  profileId: string
  executable: string
  environment: NodeJS.ProcessEnv
}) {
  const settings = (await loadHomeConfig(input.configPath)).apps.codex?.profiles[input.profileId]?.approvalReview
    ?.settings
  if (!settings) return undefined
  const cli = await resolveBundledCodexCliPath(path.dirname(path.dirname(input.executable)))
  const version = await promisify(execFile)(cli, ['--version'], {
    env: input.environment,
    timeout: 5000,
    maxBuffer: 4096,
  })
  return prepareApprovalReviewCatalog({
    settings,
    configPath: input.configPath,
    nativeVersion: version.stdout.trim().replace(/^codex-cli\s+/u, ''),
  })
}
