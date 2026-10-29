import { diagnostic, diagnosticError, diagnosticId, withDiagnostics } from '../diagnostics/context.js'
import { journalDirectory, LocalJournal } from '../diagnostics/journal.js'
import { resolveOwningPackageVersion } from '../launcher/package-version.js'
import { readCodexAppVersion } from '../launcher/process.js'
import { prepareCliCommand, type PreparedRunCommand } from './run-command-dispatch.js'
import { type CordisXCliRuntime, rootFromConfigPath } from './run-support.js'

/** The command owns this sink; no process-wide singleton leaks correlation across concurrent runs. */
export async function runWithLaunchDiagnostics(
  argv: readonly string[],
  runtime: CordisXCliRuntime,
  run: (prepared: PreparedRunCommand, runtime: CordisXCliRuntime) => Promise<void>,
): Promise<void> {
  const prepared = await prepareCliCommand(argv, runtime)
  if (prepared === undefined) return
  const journal = new LocalJournal({
    directory: journalDirectory(rootFromConfigPath(prepared.configPath), prepared.appId, prepared.selection.profileId),
    version: await resolveOwningPackageVersion(import.meta.url, 'cordisx'),
    launchId: /^[a-f0-9-]{36}$/u.test(prepared.environment.CORDISX_DIAGNOSTIC_LAUNCH_ID ?? '')
      ? prepared.environment.CORDISX_DIAGNOSTIC_LAUNCH_ID!
      : diagnosticId(),
  })
  try {
    await withDiagnostics(journal, async () => {
      try {
        await run(prepared, runtime)
      } catch (error) {
        diagnostic({ event: 'launch-failed', ...diagnosticError(error) })
        throw error
      }
    })
  } finally {
    await journal.close()
  }
}
export async function recordRuntimeGeneration(generation: string, executable?: string): Promise<void> {
  // Missing version information is a diagnostic gap, never a launch failure.
  const hostVersion = await readCodexAppVersion(executable).catch(() => undefined)
  diagnostic({ event: 'runtime-generation', generation, hostVersion: hostVersion ?? 'unknown' })
}
