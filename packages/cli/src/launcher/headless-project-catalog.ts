import { createHash } from 'node:crypto'
import { access, readdir, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

export interface HeadlessProject {
  projectId: string
  name: string
  cwd: string
  roots: string[]
}

/** A service operator explicitly chooses the workspace; conversation input cannot expand it. */
export class HeadlessProjectCatalog {
  private constructor(private readonly root: string) {}
  static async open(root: string) {
    if (!path.isAbsolute(root)) throw new Error('HEADLESS_WORKSPACE_INVALID')
    const canonical = await realpath(root)
    if (canonical === path.parse(canonical).root) throw new Error('HEADLESS_WORKSPACE_INVALID')
    if (!(await stat(canonical)).isDirectory()) throw new Error('HEADLESS_WORKSPACE_INVALID')
    await access(canonical, constants.R_OK | constants.X_OK)
    return new HeadlessProjectCatalog(canonical)
  }
  private async candidate(directory: string): Promise<HeadlessProject | undefined> {
    try {
      const resolved = await realpath(directory)
      if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) return undefined
      if (!(await stat(resolved)).isDirectory()) return undefined
      await access(resolved, constants.R_OK | constants.X_OK)
      const git = await stat(path.join(resolved, '.git'))
      if (!git.isFile() && !git.isDirectory()) return undefined
      return {
        projectId: `headless-${createHash('sha256').update(resolved).digest('hex').slice(0, 24)}`,
        name: path.basename(resolved),
        cwd: resolved,
        roots: [resolved],
      }
    } catch {
      return undefined
    }
  }
  async projects(): Promise<HeadlessProject[]> {
    const entries = await readdir(this.root, { withFileTypes: true })
    if (entries.length > 2048) throw new Error('HEADLESS_WORKSPACE_TOO_LARGE')
    const projects = await Promise.all([
      this.candidate(this.root),
      ...entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => this.candidate(path.join(this.root, entry.name))),
    ])
    return projects.filter((project): project is HeadlessProject => project !== undefined)
      .sort((left, right) => left.name.localeCompare(right.name))
  }
  async project(id: string, cwd?: string): Promise<HeadlessProject> {
    const project = (await this.projects()).find(item => item.projectId === id)
    if (!project) throw new Error('PROJECT_UNAVAILABLE')
    const selected = await realpath(cwd ?? project.cwd)
    if (selected !== project.cwd && !selected.startsWith(project.cwd + path.sep)) throw new Error('CWD_OUTSIDE_PROJECT')
    if (!(await stat(selected)).isDirectory()) throw new Error('CWD_OUTSIDE_PROJECT')
    return { ...project, cwd: selected }
  }
}
