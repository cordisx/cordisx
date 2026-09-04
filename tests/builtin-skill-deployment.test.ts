import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
