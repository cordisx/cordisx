import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function read(relative: string): Promise<string> {
  return await readFile(path.join(projectRoot, relative), 'utf8')
}

describe('CordisX brand assets', () => {
  it('publishes transparent light and dark SVGs with the same spherical geometry', async () => {
    const [light, dark] = await Promise.all([
      read('packages/cli/assets/brand/cordisx-mark-light.svg'),
      read('packages/cli/assets/brand/cordisx-mark-dark.svg'),
    ])

    for (const source of [light, dark]) {
      expect(source).toContain('viewBox="0 0 1024 1024"')
      expect(source).toContain('<g fill="none" stroke-linecap="round">')
      expect(source).not.toMatch(/<rect\b|<image\b|background(?:-color)?=/i)
      expect(source.match(/<line\b/g)?.length).toBe(1440)
    }
    expect(light).toContain('for light backgrounds')
    expect(light).toContain('stroke="#030303"')
    expect(dark).toContain('for dark backgrounds')
    expect(dark).toContain('stroke="#fcfcfc"')
  })

  it('uses the same theme-aware assets in the repository README', async () => {
    const readme = await read('README.md')
    expect(readme).toContain('<source media="(prefers-color-scheme: dark)" srcset="./packages/cli/assets/brand/cordisx-mark-dark.svg">')
    expect(readme).toContain('<source media="(prefers-color-scheme: light)" srcset="./packages/cli/assets/brand/cordisx-mark-light.svg">')
    expect(readme).toContain('<img alt="CordisX three-ring spherical mark" src="./packages/cli/assets/brand/cordisx-mark-light.svg" width="180">')
  })
})
