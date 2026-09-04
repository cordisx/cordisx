import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ResolvedLaunchPlan } from '../packages/cli/src/adapters/contracts.js'
import {
  CORDISX_PLUGIN_DEVELOPMENT_SKILL_NAME,
  CORDISX_SKILL_MARKER_FILE,
  CordisXSkillConflictError,
  deployBundledCordisXSkill,
  effectiveHomeForCordisXSkill,
} from '../packages/cli/src/launcher/builtin-skill.js'

async function createSkillSource(root: string, revision: string): Promise<string> {
  const source = path.join(root, 'source-skill')
  await mkdir(path.join(source, 'agents'), { recursive: true })
  await mkdir(path.join(source, 'references'), { recursive: true })
  await writeFile(path.join(source, 'SKILL.md'), `---\nname: cordisx-plugin-development\ndescription: ${revision}\n---\n`)
  await writeFile(path.join(source, 'agents', 'openai.yaml'), 'interface:\n  display_name: "CordisX"\n')
  await writeFile(path.join(source, 'references', 'verification.md'), `${revision}\n`)
  return source
}

function sharedPlan(home: string): ResolvedLaunchPlan {
  return {
    version: 1,
    appId: 'codex',
    appName: 'Codex',
    profileId: 'work',
    dataMode: 'shared',
    executable: process.execPath,
    chromiumProfile: { mode: 'independent', path: path.join(home, '.cordisx-chromium') },
    environment: {},
    sharedDataRoots: [
      { name: 'HOME', path: home, managed: false },
      { name: 'CODEX_HOME', path: path.join(home, '.codex-custom'), managed: false },
    ],
    isolatedDataRoots: [],
  }
}

function isolatedPlan(cordisxProfileRoot: string): ResolvedLaunchPlan {
  const home = path.join(cordisxProfileRoot, 'host-home')
  return {
    version: 1,
    appId: 'codex',
    appName: 'Codex',
    profileId: 'private',
    dataMode: 'host-isolated',
    executable: process.execPath,
    chromiumProfile: { mode: 'independent', path: path.join(cordisxProfileRoot, 'chromium') },
    environment: {
      HOME: home,
      CODEX_HOME: path.join(cordisxProfileRoot, 'codex-home'),
    },
    sharedDataRoots: [],
    isolatedDataRoots: [
      { name: 'HOME', path: home, managed: true },
      { name: 'CODEX_HOME', path: path.join(cordisxProfileRoot, 'codex-home'), managed: true },
    ],
  }
}

function installedSkill(home: string): string {
  return path.join(home, '.agents', 'skills', CORDISX_PLUGIN_DEVELOPMENT_SKILL_NAME)
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('built-in CordisX Skill deployment', () => {
  it('installs the complete Skill into shared HOME without changing another user Skill or cwd', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-builtin-skill-shared-'))
    const home = path.join(root, 'home')
    const source = await createSkillSource(root, 'revision-one')
    const otherSkill = path.join(home, '.agents', 'skills', 'personal-notes', 'SKILL.md')
    await mkdir(path.dirname(otherSkill), { recursive: true })
    await writeFile(otherSkill, 'personal-sentinel\n')
    const cwdBefore = process.cwd()

    const result = await deployBundledCordisXSkill(sharedPlan(home), { sourceDir: source })

    expect(result.status).toBe('installed')
    expect(result.effectiveHome).toBe(home)
    await expect(readFile(path.join(result.targetDir, 'SKILL.md'), 'utf8')).resolves.toContain('revision-one')
    await expect(readFile(path.join(result.targetDir, 'agents', 'openai.yaml'), 'utf8')).resolves.toContain('display_name')
    await expect(readFile(path.join(result.targetDir, 'references', 'verification.md'), 'utf8')).resolves.toBe('revision-one\n')
    await expect(readFile(path.join(result.targetDir, CORDISX_SKILL_MARKER_FILE), 'utf8')).resolves.toContain('sha256:')
    await expect(readFile(otherSkill, 'utf8')).resolves.toBe('personal-sentinel\n')
    expect(process.cwd()).toBe(cwdBefore)
  })

  it('uses the plan private HOME for host-isolated mode and never copies real-HOME Skills', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-builtin-skill-isolated-'))
    const source = await createSkillSource(root, 'isolated-revision')
    const realHome = path.join(root, 'real-home')
    const personalSkill = path.join(realHome, '.agents', 'skills', 'personal-only', 'SKILL.md')
    await mkdir(path.dirname(personalSkill), { recursive: true })
    await writeFile(personalSkill, 'do-not-copy\n')
    const plan = isolatedPlan(path.join(root, 'cordisx-profile'))
    const privateHome = plan.environment.HOME!

    const result = await deployBundledCordisXSkill(plan, {
      sourceDir: source,
      sharedHomeOverride: realHome,
    })

    expect(result.effectiveHome).toBe(privateHome)
    await expect(readFile(path.join(installedSkill(privateHome), 'SKILL.md'), 'utf8')).resolves.toContain('isolated-revision')
    await expect(access(path.join(privateHome, '.agents', 'skills', 'personal-only'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(personalSkill, 'utf8')).resolves.toBe('do-not-copy\n')
  })

  it('is idempotent and replaces only a verified CordisX-managed target on upgrade', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-builtin-skill-upgrade-'))
    const home = path.join(root, 'home')
    const source = await createSkillSource(root, 'revision-one')
    const plan = sharedPlan(home)
    const first = await deployBundledCordisXSkill(plan, { sourceDir: source })
    const markerBefore = await readFile(path.join(first.targetDir, CORDISX_SKILL_MARKER_FILE), 'utf8')

    const second = await deployBundledCordisXSkill(plan, { sourceDir: source })
    expect(second.status).toBe('unchanged')
    await expect(readFile(path.join(first.targetDir, CORDISX_SKILL_MARKER_FILE), 'utf8')).resolves.toBe(markerBefore)

    await rm(path.join(source, 'references', 'verification.md'))
    await writeFile(path.join(source, 'SKILL.md'), '---\nname: cordisx-plugin-development\ndescription: revision-two\n---\n')
    await writeFile(path.join(source, 'references', 'upgrade.md'), 'new-file\n')
    const upgraded = await deployBundledCordisXSkill(plan, { sourceDir: source })

    expect(upgraded.status).toBe('upgraded')
    await expect(readFile(path.join(upgraded.targetDir, 'SKILL.md'), 'utf8')).resolves.toContain('revision-two')
    await expect(readFile(path.join(upgraded.targetDir, 'references', 'upgrade.md'), 'utf8')).resolves.toBe('new-file\n')
    await expect(access(path.join(upgraded.targetDir, 'references', 'verification.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes concurrent launch deployments before inspecting or replacing the target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-builtin-skill-concurrent-'))
    const home = path.join(root, 'home')
    const source = await createSkillSource(root, 'concurrent-revision')
    const firstLocked = deferred()
    const releaseFirst = deferred()
    let secondLocked = false

    const first = deployBundledCordisXSkill(sharedPlan(home), {
      sourceDir: source,
      testHooks: {
        afterLockAcquired: async () => {
          firstLocked.resolve()
          await releaseFirst.promise
        },
      },
    })
    await firstLocked.promise
    const second = deployBundledCordisXSkill(sharedPlan(home), {
      sourceDir: source,
      testHooks: {
        afterLockAcquired: () => {
          secondLocked = true
        },
      },
    })

    await new Promise(resolve => setTimeout(resolve, 60))
    expect(secondLocked).toBe(false)
    releaseFirst.resolve()
    const results = await Promise.all([first, second])

    expect(results.map(result => result.status).sort()).toEqual(['installed', 'unchanged'])
    expect(secondLocked).toBe(true)
    await expect(readFile(path.join(installedSkill(home), 'SKILL.md'), 'utf8'))
      .resolves.toContain('concurrent-revision')
  })

  it('restores and preserves a user edit that lands after the managed target is moved', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-builtin-skill-moved-edit-'))
    const home = path.join(root, 'home')
    const source = await createSkillSource(root, 'revision-one')
    const plan = sharedPlan(home)
    await deployBundledCordisXSkill(plan, { sourceDir: source })
    await writeFile(path.join(source, 'SKILL.md'), '---\nname: cordisx-plugin-development\ndescription: revision-two\n---\n')

    await expect(deployBundledCordisXSkill(plan, {
      sourceDir: source,
      testHooks: {
        afterTargetMovedToBackup: async backupDir => {
          await writeFile(path.join(backupDir, 'SKILL.md'), 'user-race-edit\n')
        },
      },
    })).rejects.toThrow(CordisXSkillConflictError)

    await expect(readFile(path.join(installedSkill(home), 'SKILL.md'), 'utf8')).resolves.toBe('user-race-edit\n')
  })

  it('never deletes a directory created concurrently at the target during rollback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-builtin-skill-target-race-'))
    const home = path.join(root, 'home')
    const source = await createSkillSource(root, 'revision-one')
    const plan = sharedPlan(home)
    await deployBundledCordisXSkill(plan, { sourceDir: source })
    await writeFile(path.join(source, 'SKILL.md'), '---\nname: cordisx-plugin-development\ndescription: revision-two\n---\n')
    const target = installedSkill(home)

    const racedDeployment = deployBundledCordisXSkill(plan, {
      sourceDir: source,
      testHooks: {
        afterTargetMovedToBackup: async () => {
          await mkdir(target)
          await writeFile(path.join(target, 'SKILL.md'), 'concurrent-user-content\n')
        },
      },
    })
    await expect(racedDeployment).rejects.toBeInstanceOf(CordisXSkillConflictError)
    await expect(racedDeployment).rejects.toThrow('previous managed copy remains at')

    await expect(readFile(path.join(target, 'SKILL.md'), 'utf8')).resolves.toBe('concurrent-user-content\n')
    const skillsDir = path.dirname(target)
    const backup = (await readdir(skillsDir)).find(name => name.startsWith('.cordisx-plugin-development.backup-'))
    expect(backup).toBeDefined()
    await expect(readFile(path.join(skillsDir, backup!, 'SKILL.md'), 'utf8')).resolves.toContain('revision-one')
  })

  it('fails safely on an abandoned deployment lock without changing the target or lock contents', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-builtin-skill-stale-lock-'))
    const home = path.join(root, 'home')
    const source = await createSkillSource(root, 'blocked-revision')
    const skillsDir = path.join(home, '.agents', 'skills')
    const lockDir = path.join(skillsDir, '.cordisx-plugin-development.deployment-lock')
    await mkdir(lockDir, { recursive: true })
    await writeFile(path.join(lockDir, 'owner-sentinel'), 'unknown-owner\n')

    await expect(deployBundledCordisXSkill(sharedPlan(home), {
      sourceDir: source,
      testHooks: { deploymentLockTimeoutMs: 0 },
    })).rejects.toThrow(CordisXSkillConflictError)

    await expect(access(installedSkill(home))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(lockDir, 'owner-sentinel'), 'utf8')).resolves.toBe('unknown-owner\n')
  })

  it('adopts an exact unmanaged copy without rewriting its Skill content', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-builtin-skill-adopt-'))
    const home = path.join(root, 'home')
    const source = await createSkillSource(root, 'manual-exact-copy')
    const target = installedSkill(home)
    await mkdir(path.dirname(target), { recursive: true })
    await cp(source, target, { recursive: true, force: false, errorOnExist: true })
    const before = await readFile(path.join(target, 'SKILL.md'), 'utf8')

    const result = await deployBundledCordisXSkill(sharedPlan(home), { sourceDir: source })

    expect(result.status).toBe('unchanged')
    await expect(readFile(path.join(target, 'SKILL.md'), 'utf8')).resolves.toBe(before)
    await expect(readFile(path.join(target, CORDISX_SKILL_MARKER_FILE), 'utf8')).resolves.toContain(result.contentDigest)
  })

  it('preserves a marker that replaces CordisX own marker during unmanaged adoption', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-builtin-skill-adopt-race-'))
    const home = path.join(root, 'home')
    const source = await createSkillSource(root, 'manual-exact-copy')
    const target = installedSkill(home)
    const markerPath = path.join(target, CORDISX_SKILL_MARKER_FILE)
    const replacementPath = path.join(target, '.user-marker-replacement')
    const userMarker = 'user-owned-marker\n'
    await mkdir(path.dirname(target), { recursive: true })
    await cp(source, target, { recursive: true, force: false, errorOnExist: true })

    const racedDeployment = deployBundledCordisXSkill(sharedPlan(home), {
      sourceDir: source,
      testHooks: {
        afterAdoptionMarkerWritten: async () => {
          await writeFile(replacementPath, userMarker)
          await rename(replacementPath, markerPath)
        },
      },
    })
    await expect(racedDeployment).rejects.toBeInstanceOf(CordisXSkillConflictError)
    await expect(racedDeployment).rejects.toThrow('adoption marker changed concurrently')

    await expect(readFile(markerPath, 'utf8')).resolves.toBe(userMarker)
    await expect(readFile(path.join(target, 'SKILL.md'), 'utf8')).resolves.toContain('manual-exact-copy')
  })

  it('removes only its own unchanged marker when unmanaged content changes during adoption', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-builtin-skill-adopt-content-race-'))
    const home = path.join(root, 'home')
    const source = await createSkillSource(root, 'manual-exact-copy')
    const target = installedSkill(home)
    const markerPath = path.join(target, CORDISX_SKILL_MARKER_FILE)
    await mkdir(path.dirname(target), { recursive: true })
    await cp(source, target, { recursive: true, force: false, errorOnExist: true })

    await expect(deployBundledCordisXSkill(sharedPlan(home), {
      sourceDir: source,
      testHooks: {
        afterAdoptionMarkerWritten: async () => {
          await writeFile(path.join(target, 'SKILL.md'), 'user-edit-during-adoption\n')
        },
      },
    })).rejects.toBeInstanceOf(CordisXSkillConflictError)

    await expect(readFile(path.join(target, 'SKILL.md'), 'utf8')).resolves.toBe('user-edit-during-adoption\n')
    await expect(access(markerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves an unmanaged conflicting target and all sibling Skills', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-builtin-skill-conflict-'))
    const home = path.join(root, 'home')
    const source = await createSkillSource(root, 'bundled')
    const target = installedSkill(home)
    const sibling = path.join(home, '.agents', 'skills', 'user-skill', 'SKILL.md')
    await mkdir(target, { recursive: true })
    await mkdir(path.dirname(sibling), { recursive: true })
    await writeFile(path.join(target, 'SKILL.md'), 'user-owned-conflict\n')
    await writeFile(sibling, 'sibling-sentinel\n')

    await expect(deployBundledCordisXSkill(sharedPlan(home), { sourceDir: source }))
      .rejects.toThrow(CordisXSkillConflictError)
    await expect(deployBundledCordisXSkill(sharedPlan(home), { sourceDir: source }))
      .rejects.toThrow('left unchanged')
    await expect(readFile(path.join(target, 'SKILL.md'), 'utf8')).resolves.toBe('user-owned-conflict\n')
    await expect(access(path.join(target, CORDISX_SKILL_MARKER_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(sibling, 'utf8')).resolves.toBe('sibling-sentinel\n')
  })

  it('refuses to overwrite a previously managed target whose content was changed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-builtin-skill-tamper-'))
    const home = path.join(root, 'home')
    const source = await createSkillSource(root, 'original')
    const first = await deployBundledCordisXSkill(sharedPlan(home), { sourceDir: source })
    await writeFile(path.join(first.targetDir, 'SKILL.md'), 'local-edit\n')
    await writeFile(path.join(source, 'SKILL.md'), '---\nname: cordisx-plugin-development\ndescription: upgrade\n---\n')

    await expect(deployBundledCordisXSkill(sharedPlan(home), { sourceDir: source }))
      .rejects.toThrow('was changed after CordisX installed it')
    await expect(readFile(path.join(first.targetDir, 'SKILL.md'), 'utf8')).resolves.toBe('local-edit\n')
  })

  it('keeps CordisX profiles, Chromium profiles, and Codex config roots conceptually separate', () => {
    const root = path.join(path.sep, 'tmp', 'cordisx-profile-separation')
    const shared = sharedPlan(path.join(root, 'real-home'))
    const isolated = isolatedPlan(path.join(root, 'cordisx-home', 'apps', 'codex', 'profiles', 'private'))

    expect(effectiveHomeForCordisXSkill(shared)).toBe(path.join(root, 'real-home'))
    expect(effectiveHomeForCordisXSkill(shared)).not.toBe(shared.chromiumProfile.mode === 'independent'
      ? shared.chromiumProfile.path
      : '')
    expect(effectiveHomeForCordisXSkill(shared)).not.toBe(shared.sharedDataRoots.find(item => item.name === 'CODEX_HOME')?.path)
    expect(effectiveHomeForCordisXSkill(isolated)).toBe(isolated.environment.HOME)
    expect(effectiveHomeForCordisXSkill(isolated)).not.toBe(isolated.environment.CODEX_HOME)
  })
})
