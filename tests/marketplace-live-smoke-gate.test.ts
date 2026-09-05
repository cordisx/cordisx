import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('Marketplace real app smoke gate', () => {
  it('asserts the stacked list badges, Official-only ordering, detail boundary, and correct Marketplace detail route', async () => {
    const source = await readFile(path.join(root, 'packages/cli/scripts/live-smoke.mjs'), 'utf8')

    expect(source).toContain("? '[data-marketplace-detail-tab]'")
    expect(source).toContain("rankingOfficialPriority: row.getAttribute('data-marketplace-ranking-official-priority')")
    expect(source).not.toContain("rankingTrustBoost: row.getAttribute('data-marketplace-ranking-trust-boost')")
    expect(source).toContain("row.rankingOfficialPriority !== '1'")
    expect(source).toContain("'official,certified'")
    expect(source).toContain("'trust.official,trust.certified'")
    expect(source).toContain('Marketplace trust detail assertions failed')
    expect(source).toContain('/interface capabilities|界面能力/iu')
    expect(source).toContain(
      "const requestedView = managerPlugin === undefined ? (managerMarketplaceView ?? 'discovery') : 'detail'",
    )
  })
})
