import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createDefaultHomeConfig, loadHomeConfig } from '../packages/cli/src/config/home-config.js'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'
import { installConfiguredSkills, parseSkillSource } from '../packages/cli/src/launcher/configured-skills.js'

function git(cwd: string, ...args: string[]) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' })
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-configured-skills-'))
  const repo = path.join(root, 'source.git')
  await mkdir(path.join(repo, 'skills', 'example'), { recursive: true })
  await writeFile(path.join(repo, 'skills', 'example', 'SKILL.md'), 'first')
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'test@example.invalid')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'first')
  const source = `${pathToFileURL(repo).href}#HEAD@example`
  return { root, repo, source }
}

describe('configured Git skills', () => {
  it('parses refs and selectors without confusing SSH usernames', () => {
    expect(parseSkillSource('git@example.invalid:team/repo.git#branch/name@skills/example')).toEqual({
      repository: 'git@example.invalid:team/repo.git',
      ref: 'branch/name',
      selector: 'skills/example',
    })
    expect(parseSkillSource('https://example.invalid/repo.git@example').selector).toBe('example')
    expect(() => parseSkillSource('https://user:secret@example.invalid/repo.git@x')).toThrow()
    expect(() => parseSkillSource('https://example.invalid/repo.git@../x')).toThrow()
  })

  it('installs, updates, falls back offline, and protects user edits and unmanaged targets', async () => {
    const { root, repo, source } = await fixture()
    try {
      const messages: string[] = []
      const options = {
        sources: [source],
        cacheDir: path.join(root, 'cache'),
        skillsDir: path.join(root, 'dest'),
        report: (s: string) => messages.push(s),
      }
      const installed = path.join(options.skillsDir, 'example', 'SKILL.md')
      expect(await installConfiguredSkills(options)).toBe(0)
      expect(await readFile(installed, 'utf8')).toBe('first')
      await writeFile(path.join(repo, 'skills', 'example', 'SKILL.md'), 'second')
      git(repo, 'add', '.')
      git(repo, 'commit', '-qm', 'second')
      expect(await installConfiguredSkills(options)).toBe(0)
      expect(await readFile(installed, 'utf8')).toBe('first')
      expect(await installConfiguredSkills({ ...options, update: true })).toBe(0)
      expect(await readFile(installed, 'utf8')).toBe('second')
      await rename(repo, `${repo}.offline`)
      expect(await installConfiguredSkills({ ...options, update: true })).toBe(1)
      expect(messages.join('\n')).toContain('using cached copy')
      await writeFile(installed, 'my edits')
      expect(await installConfiguredSkills(options)).toBe(1)
      expect(await readFile(installed, 'utf8')).toBe('my edits')
      const unmanaged = path.join(root, 'unmanaged', 'example')
      await mkdir(unmanaged, { recursive: true })
      await writeFile(path.join(unmanaged, 'SKILL.md'), 'mine')
      expect(await installConfiguredSkills({ ...options, skillsDir: path.dirname(unmanaged) })).toBe(1)
      expect(await readFile(path.join(unmanaged, 'SKILL.md'), 'utf8')).toBe('mine')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('selects a root Skill by its declared name without copying Git metadata', async () => {
    const { root, repo } = await fixture()
    try {
      await writeFile(path.join(repo, 'SKILL.md'), '---\nname: root-skill\n---\nBody')
      git(repo, 'add', '.')
      git(repo, 'commit', '-qm', 'root skill')
      const skillsDir = path.join(root, 'dest')
      expect(
        await installConfiguredSkills({
          sources: [`${pathToFileURL(repo).href}@root-skill`],
          cacheDir: path.join(root, 'cache'),
          skillsDir,
          report: () => {},
        }),
      ).toBe(0)
      expect(await readFile(path.join(skillsDir, 'root-skill', 'SKILL.md'), 'utf8')).toContain('root-skill')
      await expect(readFile(path.join(skillsDir, 'root-skill', '.git', 'config'))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads the isolated configuration and installs into both official client directories', async () => {
    const { root, source } = await fixture()
    try {
      const cordisxHome = path.join(root, 'cordisx')
      await mkdir(cordisxHome)
      const configPath = path.join(cordisxHome, 'config.json')
      await writeFile(configPath, JSON.stringify({ ...createDefaultHomeConfig(), skills: [source] }))
      expect((await loadHomeConfig(configPath)).skills).toEqual([source])
      await runCordisXCli(['skills', 'install'], {
        homedir: root,
        env: { CORDISX_HOME: cordisxHome },
        stdout: () => {},
      })
      for (const dir of ['.agents', '.claude']) {
        expect(await readFile(path.join(root, dir, 'skills', 'example', 'SKILL.md'), 'utf8')).toBe('first')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
