import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  ensureManager,
  managerEntry,
  managerLink,
  managerStatus,
  serveManager,
  stopManager,
} from './manager-supervisor.js'

const execute = promisify(execFile)

export async function openManagerBrowser(
  entry: string,
  platform: NodeJS.Platform = process.platform,
  launch: (command: string, args: readonly string[]) => Promise<unknown> = async (command, args) =>
    await execute(command, [...args], { timeout: 10_000, windowsHide: true }),
): Promise<void> {
  const opener = platform === 'darwin' ? 'open' : platform === 'linux' ? 'xdg-open' : undefined
  if (!opener) throw new Error('BROWSER_OPEN_UNAVAILABLE')
  try {
    await launch(opener, [entry])
  } catch {
    throw new Error('BROWSER_OPEN_UNAVAILABLE')
  }
}

/** The manager sidecar is separate from, and never stops or replaces, the profile owner. */
export async function runManagerCommand(args: readonly string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: cordisx manager [open|start|status|stop] [--profile <id>] [--print-url]')
    console.log('Open or control the independent manager for an existing running profile owner.')
    console.log('--print-url prints a private one-time URL locally instead of opening the browser.')
    return
  }
  let action = 'open'
  let offset = 0
  if (args[0] && !args[0].startsWith('-')) {
    action = args[0]
    offset = 1
  }
  if (!['open', 'start', 'status', 'stop', '__serve'].includes(action)) throw new Error('INVALID_MANAGER_ARGUMENTS')
  let profile: string | undefined
  let printUrl = false
  for (let i = offset; i < args.length; i++) {
    if (args[i] === '--print-url' && !printUrl) printUrl = true
    else if (args[i] === '--profile' && profile === undefined && args[i + 1]) profile = args[++i]
    else throw new Error('INVALID_MANAGER_ARGUMENTS')
  }
  if (printUrl && action !== 'open') throw new Error('INVALID_MANAGER_ARGUMENTS')
  if (action === '__serve') {
    if (!profile) throw new Error('MANAGER_CHILD_NOT_AUTHORIZED')
    return await serveManager(profile)
  }
  if (action === 'status') {
    console.log(JSON.stringify(await managerStatus(profile)))
    return
  }
  if (action === 'stop') {
    console.log(JSON.stringify({ status: await stopManager(profile) ? 'stopped' : 'already-stopped' }))
    return
  }
  if (action === 'start') {
    const { state } = await ensureManager(profile)
    console.log(JSON.stringify({ status: 'running', profile: state.profileId }))
    return
  }
  if (printUrl) {
    const link = await managerLink(profile)
    console.log(`Private one-time manager URL (do not share): ${link}`)
    return
  }
  const entry = await managerEntry(profile)
  await openManagerBrowser(entry)
  console.log('Requested the default browser to open CordisX manager.')
}
