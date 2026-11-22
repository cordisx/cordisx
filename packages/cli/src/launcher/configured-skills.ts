import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { collectSkillFiles, CORDISX_SKILL_MARKER_FILE, digestSkillFiles } from './builtin-skill.js'

const git = promisify(execFile)
const markerContract = 'cordisx.configured-skill/v1'

export interface SkillSource {
  readonly repository: string
  readonly ref?: string
  readonly selector?: string
}

/** DYAI-compatible Git URL[#ref][@skill], including git@host SSH URLs. */
export function parseSkillSource(input: string): SkillSource {
  const value = input.trim()
  const hash = value.indexOf('#')
  const repositoryPart = hash < 0 ? value : value.slice(0, hash)
  const suffix = hash < 0 ? '' : value.slice(hash + 1)
  const gitEnd = repositoryPart.toLowerCase().lastIndexOf('.git')
  const at = hash >= 0 ? suffix.lastIndexOf('@') : gitEnd >= 0 ? repositoryPart.indexOf('@', gitEnd + 4) : -1
  const repository = hash >= 0 ? repositoryPart : at < 0 ? repositoryPart : repositoryPart.slice(0, at)
  const ref = hash < 0 ? undefined : (at < 0 ? suffix : suffix.slice(0, at))
  const selector = at < 0 ? undefined : (hash < 0 ? repositoryPart.slice(at + 1) : suffix.slice(at + 1))
  if (
    !/^(https:\/\/|ssh:\/\/|git@|file:\/\/)/u.test(repository) || /[\s\u0000-\u001f]/u.test(repository)
    || (hash >= 0 && !ref) || (at >= 0 && !selector)
    || (ref && (ref.startsWith('-') || /[\s\u0000-\u001f]/u.test(ref)))
    || (selector && (!/^[a-zA-Z0-9._/-]+$/u.test(selector)
      || selector.split('/').some(part => !part || part === '.' || part === '..')))
  ) {
    throw new Error('Invalid Git Skill source; expected URL[#ref][@skill]')
  }
  if (
    /^https:\/\/[^/]*@/u.test(repository) || /[?]/u.test(repository)
    || /^ssh:\/\/[^/]*:[^/]*@/u.test(repository)
  ) {
    throw new Error('Git Skill URLs must not embed credentials or query parameters')
  }
  return { repository, ...(ref ? { ref } : {}), ...(selector ? { selector } : {}) }
}

function identity(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

async function exists(target: string): Promise<boolean> {
  return await lstat(target).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
}

async function withLock<T>(lock: string, operation: () => Promise<T>): Promise<T> {
  const until = Date.now() + 10_000
  for (;;) {
    try {
      await mkdir(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= until) {
        throw new Error(`Skill installation lock unavailable: ${lock}`, { cause: error })
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  try {
    return await operation()
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

async function findSkills(root: string, selector?: string): Promise<string[]> {
  const found: string[] = []
  async function visit(dir: string, relative: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    if (entries.some(entry => entry.name === 'SKILL.md' && entry.isFile())) {
      const content = selector ? await readFile(path.join(dir, 'SKILL.md'), 'utf8') : ''
      const declaredName = /^name:\s*["']?([a-zA-Z0-9._-]+)["']?\s*$/mu.exec(content)?.[1]
      if (
        !selector || relative === selector || path.posix.basename(relative) === selector || declaredName === selector
      ) found.push(relative)
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') {
        await visit(path.join(dir, entry.name), relative ? `${relative}/${entry.name}` : entry.name)
      }
    }
  }
  await visit(root, '')
  if (!found.length) throw new Error('No matching SKILL.md found in Git source')
  if (selector && found.length !== 1) {
    throw new Error('Skill selector matches multiple directories; use its relative path')
  }
  return found
}

async function deploy(source: string, skillsDir: string, sourceId: string, name: string): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(name)) throw new Error('Invalid Skill directory name')
  const files = await collectSkillFiles(source, false)
  if (files.some(file => file.relativePath === CORDISX_SKILL_MARKER_FILE)) {
    throw new Error('Source contains a management marker')
  }
  const digest = digestSkillFiles(files)
  await mkdir(skillsDir, { recursive: true })
  const target = path.join(skillsDir, name)
  return await withLock(path.join(skillsDir, `.${name}.deployment-lock`), async () => {
    let previousDigest: string | undefined
    let previousMarker: string | undefined
    if (await exists(target)) {
      const metadata = await lstat(target)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Skill target is user-owned: ${target}`)
      let marker: { contract?: string; sourceId?: string; digest?: string }
      try {
        const markerPath = path.join(target, CORDISX_SKILL_MARKER_FILE)
        const markerStat = await lstat(markerPath)
        if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error('invalid marker')
        previousMarker = await readFile(markerPath, 'utf8')
        marker = JSON.parse(previousMarker)
      } catch {
        throw new Error(`Skill target is user-owned: ${target}`)
      }
      if (marker.contract !== markerContract || marker.sourceId !== sourceId || typeof marker.digest !== 'string') {
        throw new Error(`Skill target belongs to another source or user: ${target}`)
      }
      previousDigest = digestSkillFiles(await collectSkillFiles(target, true))
      if (previousDigest !== marker.digest) throw new Error(`Skill target was modified by the user: ${target}`)
      if (previousDigest === digest) return `unchanged: ${target}`
    }
    const stage = await mkdtemp(path.join(skillsDir, `.${name}.stage-`))
    const backup = path.join(skillsDir, `.${name}.backup-${randomUUID()}`)
    let backedUp = false
    try {
      await cp(source, stage, { recursive: true, dereference: false, errorOnExist: false })
      await writeFile(
        path.join(stage, CORDISX_SKILL_MARKER_FILE),
        JSON.stringify({ contract: markerContract, sourceId, digest }),
      )
      if (digestSkillFiles(await collectSkillFiles(stage, true)) !== digest) {
        throw new Error('Skill copy verification failed')
      }
      if (previousDigest) {
        await rename(target, backup)
        backedUp = true
        const markerPath = path.join(backup, CORDISX_SKILL_MARKER_FILE)
        const markerStat = await lstat(markerPath)
        if (
          !markerStat.isFile() || markerStat.isSymbolicLink()
          || await readFile(markerPath, 'utf8') !== previousMarker
          || digestSkillFiles(await collectSkillFiles(backup, true)) !== previousDigest
        ) {
          throw new Error(`Skill target changed during update: ${target}`)
        }
      }
      await rename(stage, target)
      if (backedUp) {
        await rm(backup, { recursive: true, force: true })
        backedUp = false
      }
      return `${previousDigest ? 'updated' : 'installed'}: ${target}`
    } catch (error) {
      if (backedUp && !await exists(target)) {
        await rename(backup, target)
        backedUp = false
      }
      if (backedUp) throw new Error(`Skill update failed; previous copy retained at ${backup}`, { cause: error })
      throw error
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  })
}

export interface InstallConfiguredSkillsOptions {
  readonly sources: readonly string[]
  readonly cacheDir: string
  readonly skillsDir: string
  readonly update?: boolean
  readonly report: (message: string) => void
  readonly env?: NodeJS.ProcessEnv
}

/** Install cached copies, fetching on first use or explicit update. Failures are reported per source. */
export async function installConfiguredSkills(options: InstallConfiguredSkillsOptions): Promise<number> {
  if (!options.sources.length) return 0
  await mkdir(options.cacheDir, { recursive: true, mode: 0o700 })
  let failures = 0
  for (const [index, input] of options.sources.entries()) {
    try {
      const source = parseSkillSource(input)
      const sourceId = identity(JSON.stringify(source))
      const cache = path.join(options.cacheDir, sourceId)
      await withLock(`${cache}.lock`, async () => {
        if (options.update || !await exists(cache)) {
          const stage = await mkdtemp(path.join(options.cacheDir, '.fetch-'))
          try {
            await git('git', ['clone', '--quiet', '--no-checkout', '--', source.repository, stage], {
              timeout: 60_000,
              env: { ...options.env ?? process.env, GIT_TERMINAL_PROMPT: '0' },
            })
            await git('git', ['-C', stage, 'checkout', '--quiet', '--detach', source.ref ?? 'HEAD'], {
              timeout: 60_000,
            })
            await rm(path.join(stage, '.git'), { recursive: true, force: true })
            await findSkills(stage, source.selector)
            const old = `${cache}.old-${randomUUID()}`
            if (await exists(cache)) await rename(cache, old)
            try {
              await rename(stage, cache)
            } catch (error) {
              if (await exists(old)) await rename(old, cache)
              throw error
            }
            await rm(old, { recursive: true, force: true })
          } catch {
            if (!await exists(cache)) {
              throw new Error(
                'Git fetch or Skill selection failed and no cached copy is available; check access and selector, then retry',
              )
            }
            options.report('[cordisx] Skill fetch or selection failed; using cached copy')
            failures++
          } finally {
            await rm(stage, { recursive: true, force: true })
          }
        }
        for (const relative of await findSkills(cache, source.selector)) {
          options.report(
            `[cordisx] Skill ${await deploy(
              path.join(cache, relative),
              options.skillsDir,
              `${sourceId}:${relative}`,
              relative
                ? path.basename(relative)
                : source.selector ?? path.basename(source.repository).replace(/\.git$/u, ''),
            )}`,
          )
        }
      })
    } catch (error) {
      failures++
      options.report(
        `[cordisx] Skill source ${index + 1} installation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  return failures
}
