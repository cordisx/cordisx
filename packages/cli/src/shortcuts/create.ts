import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, lstat, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { CordisXManagedInvocation } from '../cli/parse.js'
import { resolveHostAdapter } from '../adapters/registry.js'
import { inspectBundle, nativeOperation, requireShortcutHelper, shortcutHelper } from './native.js'
import {
  legacyShortcutKey,
  shortcutArgv,
  shortcutKey,
  type ShortcutLaunchIdentity,
  type ShortcutOutputOptions,
  type ShortcutRecord,
  validRecord,
} from './model.js'
import { entryLock, isMissing, privateDirectory, readPrivateJson, registryFor, writePrivateJson } from './store.js'
const run = promisify(execFile)
const brandDark = fileURLToPath(new URL('../../assets/brand/cordisx-mark-dark.svg', import.meta.url))
const brandLight = fileURLToPath(new URL('../../assets/brand/cordisx-mark-light.svg', import.meta.url))
export async function preflightShortcut(invocation: CordisXManagedInvocation, cwd: string): Promise<void> {
  await requireShortcutHelper()
  shortcutArgv(
    invocation,
    invocation.app ?? 'codex',
    invocation.profile ?? 'default',
    cwd,
    invocation.dataMode ?? 'shared',
  )
  if (fileURLToPath(import.meta.url).includes(`${path.sep}_npx${path.sep}`)) {
    throw new Error('Install CordisX in a stable location before creating a shortcut')
  }
}
export async function createShortcut(input: {
  invocation: CordisXManagedInvocation
  appId: string
  profileId: string
  dataMode: 'shared' | 'host-isolated'
  home: string
  cwd: string
  env: NodeJS.ProcessEnv
  output?: ShortcutOutputOptions
  avatar?: string
  launchIdentity?: ShortcutLaunchIdentity
}): Promise<{ path: string; iconSource: ShortcutRecord['iconSource']; updated: boolean }> {
  const home = await realpath(input.home)
  const registry = input.output?.registry ?? registryFor(os.homedir())
  const directory = input.output?.directory ?? path.join(os.homedir(), 'Desktop')
  await privateDirectory(registry)
  const id = shortcutKey(home, input.appId, input.profileId, input.dataMode)
  const recordPath = path.join(registry, `${id}.json`)
  const legacyId = legacyShortcutKey(home, input.appId, input.profileId)
  const legacyRecordPath = path.join(registry, `${legacyId}.json`)
  // Serialise first-time migration across the two data modes as well.
  const releaseLegacy = await entryLock(legacyRecordPath)
  const release = await entryLock(recordPath).catch(async error => {
    await releaseLegacy()
    throw error
  })
  let stage: string | undefined, backup: string | undefined, published: string | undefined
  let displacedPath: string | undefined, previousRecordPath = recordPath, recordWritten = false
  let previous: ShortcutRecord | undefined
  try {
    try {
      const value = await readPrivateJson(recordPath)
      if (!validRecord(value) || value.entryId !== id) {
        throw new Error('Invalid shortcut record; restore it before updating')
      }
      previous = value
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    if (!previous) {
      try {
        const value = await readPrivateJson(legacyRecordPath)
        if (
          !validRecord(value) || value.entryId !== legacyId || value.cordisxHome !== home
          || value.appId !== input.appId || value.profileId !== input.profileId
        ) {
          throw new Error('Invalid legacy shortcut record; restore it before migration')
        }
        const modeIndex = value.argv.indexOf('--data')
        const legacyMode = value.dataMode ?? (modeIndex < 0 ? input.dataMode : value.argv[modeIndex + 1])
        if (legacyMode === input.dataMode) {
          previous = value
          previousRecordPath = legacyRecordPath
        }
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    const migrating = previousRecordPath !== recordPath
    const plan = await resolveHostAdapter(input.appId).resolveLaunchPlan({
      cordisxHomeDir: home,
      profileId: input.profileId,
      dataMode: input.dataMode,
      ...(input.invocation.options.executable
        ? { executable: path.resolve(input.cwd, input.invocation.options.executable) }
        : {}),
    })
    const name = `CordisX · ${plan.appName} · ${input.profileId} · ${
      input.dataMode === 'shared' ? 'Shared' : 'Isolated'
    }`
    let bundlePath = previous?.bundlePath ?? path.join(directory, `${name}.app`)
    if (previous) {
      const resolved = await nativeOperation<{ path: string }>({ operation: 'resolve', bookmark: previous.bookmark })
        .catch(() => undefined)
      if (resolved) bundlePath = resolved.path
      if (bundlePath.includes('/.Trash/') || bundlePath.includes('/.Trashes/')) {
        throw new Error('Shortcut is in Trash; restore it before updating')
      }
      await access(bundlePath).catch(() => {
        throw new Error(
          'Shortcut moved or deleted. Restore the original entry, or remove its private record to explicitly create it again: '
            + recordPath,
        )
      })
      const existing = await inspectBundle(bundlePath)
      if (existing.entryId !== previous.entryId || existing.recordPath !== previousRecordPath) {
        throw new Error('Shortcut identity conflict; refusing to overwrite')
      }
    } else {
      try {
        await lstat(bundlePath)
        throw new Error('An unrelated file already exists at ' + bundlePath)
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    const sourceBundlePath = bundlePath
    const legacyDefault = path.join(directory, `${plan.appName} · ${input.profileId}.app`)
    if (migrating && await realpath(legacyDefault).catch(() => undefined) === await realpath(sourceBundlePath)) {
      bundlePath = path.join(directory, `${name}.app`)
      try {
        await lstat(bundlePath)
        throw new Error('An unrelated file already exists at ' + bundlePath)
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    const inspection = previous ? await inspectBundle(sourceBundlePath) : undefined
    const custom = inspection?.customIcon === true
    const runtimePath = path.join(
      registry,
      `runtime-${
        createHash('sha256').update(await realpath(fileURLToPath(new URL('../../..', import.meta.url)))).digest('hex')
          .slice(0, 16)
      }.json`,
    )
    await writePrivateJson(runtimePath, {
      schemaVersion: 1,
      node: await realpath(process.execPath),
      cli: fileURLToPath(new URL('../cli.js', import.meta.url)),
      entryScript: fileURLToPath(new URL('../cli/shortcut-entry.js', import.meta.url)),
    })
    stage = await mkdtemp(path.join(path.dirname(bundlePath), '.cordisx-shortcut-'))
    const icon = path.join(stage, 'icon.icns')
    const lightIcon = path.join(stage, 'light.icns')
    const defaultIcon = path.join(stage, 'default.icns')
    const dockMain = path.join(stage, 'dock-main-dark.icns')
    const dockLightMain = path.join(stage, 'dock-main-light.icns')
    const dockDefaultMain = path.join(stage, 'dock-main-default.icns')
    const dockBadges = path.join(stage, 'dock-badges-dark.png')
    const dockLightBadges = path.join(stage, 'dock-badges-light.png')
    const dockDefaultBadges = path.join(stage, 'dock-badges-default.png')
    await nativeOperation({
      operation: 'icon',
      executable: plan.executable,
      brandDark,
      brandLight,
      output: icon,
      runtimeMain: dockMain,
      runtimeBadges: dockBadges,
      ...(input.avatar ? { avatar: input.avatar } : {}),
    })
    await nativeOperation({
      operation: 'icon',
      executable: plan.executable,
      brandDark,
      brandLight,
      output: lightIcon,
      runtimeMain: dockLightMain,
      runtimeBadges: dockLightBadges,
      appearance: 'light',
      ...(input.avatar ? { avatar: input.avatar } : {}),
    })
    await nativeOperation({
      operation: 'icon',
      executable: plan.executable,
      brandDark,
      brandLight,
      output: defaultIcon,
      runtimeMain: dockDefaultMain,
      runtimeBadges: dockDefaultBadges,
      appearance: 'default',
      ...(input.avatar ? { avatar: input.avatar } : {}),
    })
    // A Host update can change just one appearance; any variant must refresh
    // the same saved entry and its running Dock projection.
    const digest = createHash('sha256')
      .update(await readFile(icon))
      .update(await readFile(lightIcon))
      .update(await readFile(defaultIcon))
      .update(await readFile(dockMain))
      .update(await readFile(dockLightMain))
      .update(await readFile(dockDefaultMain))
      .update(await readFile(dockBadges))
      .update(await readFile(dockLightBadges))
      .update(await readFile(dockDefaultBadges))
      .digest('hex')
    const helperDigest = createHash('sha256').update(await readFile(shortcutHelper)).digest('hex')
    const changed = !previous || migrating
      || (!custom
        && (previous.iconSource === 'user' || digest !== previous.iconDigest || helperDigest !== previous.helperDigest))
    if (changed) {
      const stagedBundle = path.join(stage, path.basename(bundlePath))
      await nativeOperation({
        operation: 'assemble',
        path: stagedBundle,
        helper: shortcutHelper,
        icon,
        lightIcon,
        defaultIcon,
        dockMain,
        dockLightMain,
        dockDefaultMain,
        dockBadges,
        dockLightBadges,
        dockDefaultBadges,
        entryId: id,
        name: path.basename(bundlePath, '.app'),
        recordPath,
      })
      await run('/usr/bin/codesign', ['--force', '--sign', '-', stagedBundle])
      await run('/usr/bin/codesign', ['--verify', '--strict', stagedBundle])
      if (previous) {
        // Preserve a Finder edit that races icon generation rather than replacing its bundle.
        if ((await inspectBundle(sourceBundlePath)).customIcon !== custom) {
          throw new Error('The icon changed during update; retry to preserve it')
        }
        if (custom) {
          await nativeOperation({ operation: 'copy-custom-icon', source: sourceBundlePath, destination: stagedBundle })
        }
        backup = path.join(stage, 'previous.app')
        displacedPath = sourceBundlePath
        await rename(sourceBundlePath, backup)
      }
      await rename(stagedBundle, bundlePath)
      published = bundlePath
    }
    const final = await inspectBundle(bundlePath)
    const record: ShortcutRecord = {
      schemaVersion: 1,
      entryId: id,
      appId: input.appId,
      profileId: input.profileId,
      dataMode: input.dataMode,
      cordisxHome: home,
      runtimePath,
      argv: shortcutArgv(input.invocation, input.appId, input.profileId, input.cwd, input.dataMode),
      cwd: input.cwd,
      ...(input.env.CODEX_HOME ? { codexHome: path.resolve(input.cwd, input.env.CODEX_HOME) } : {}),
      bundlePath,
      bookmark: final.bookmark,
      helperDigest: custom ? previous!.helperDigest ?? helperDigest : helperDigest,
      iconDigest: custom ? previous!.iconDigest : digest,
      iconSource: custom ? 'user' : input.avatar ? 'cordisx-avatar' : 'cordisx-default',
      ...(input.launchIdentity ? { launchIdentity: input.launchIdentity } : {}),
    }
    await writePrivateJson(recordPath, record)
    recordWritten = true
    if (migrating) await rm(legacyRecordPath)
    return { path: bundlePath, iconSource: record.iconSource, updated: previous !== undefined }
  } catch (error) {
    if (recordWritten && previousRecordPath !== recordPath) await rm(recordPath, { force: true })
    if (published) await rm(published, { recursive: true, force: true })
    if (backup && displacedPath) await rename(backup, displacedPath)
    throw error
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true })
    await release()
    await releaseLegacy()
  }
}

export async function reuseShortcut(input: {
  invocation: CordisXManagedInvocation
  appId: string
  profileId: string
  dataMode: 'shared' | 'host-isolated'
  home: string
  cwd: string
  env: NodeJS.ProcessEnv
  output?: ShortcutOutputOptions
  launchIdentity: ShortcutLaunchIdentity
}): Promise<{ path: string; iconSource: ShortcutRecord['iconSource']; updated: true } | undefined> {
  const home = await realpath(input.home)
  const registry = input.output?.registry ?? registryFor(os.homedir())
  const id = shortcutKey(home, input.appId, input.profileId, input.dataMode)
  const recordPath = path.join(registry, `${id}.json`)
  let record: ShortcutRecord
  try {
    const value = await readPrivateJson(recordPath)
    if (!validRecord(value) || value.entryId !== id) {
      throw new Error('Invalid shortcut record; restore it before updating')
    }
    record = value
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  const codexHome = input.env.CODEX_HOME ? path.resolve(input.cwd, input.env.CODEX_HOME) : undefined
  const helperDigest = createHash('sha256').update(await readFile(shortcutHelper)).digest('hex')
  if (
    record.cordisxHome !== home || record.appId !== input.appId || record.profileId !== input.profileId
    || record.dataMode !== input.dataMode || record.cwd !== input.cwd || record.codexHome !== codexHome
    || JSON.stringify(record.argv) !== JSON.stringify(shortcutArgv(
        input.invocation,
        input.appId,
        input.profileId,
        input.cwd,
        input.dataMode,
      ))
    || record.helperDigest !== helperDigest || record.iconSource !== 'cordisx-avatar'
    || JSON.stringify(record.launchIdentity) !== JSON.stringify(input.launchIdentity)
  ) return undefined
  const resolved = await nativeOperation<{ path: string }>({ operation: 'resolve', bookmark: record.bookmark })
    .catch(() => undefined)
  const bundlePath = resolved?.path ?? record.bundlePath
  await access(bundlePath).catch(() => undefined)
  const inspection = await inspectBundle(bundlePath).catch(() => undefined)
  if (!inspection || inspection.customIcon || inspection.entryId !== id || inspection.recordPath !== recordPath) {
    return undefined
  }
  return { path: bundlePath, iconSource: record.iconSource, updated: true }
}
