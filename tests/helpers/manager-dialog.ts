import type { CdpClient } from '../fixtures/native-browser-cdp.js'

interface BrowserNode {
  readonly backendNodeId: number
  readonly nodeName: string
  readonly attributes?: string[]
  readonly children?: BrowserNode[]
  readonly shadowRoots?: BrowserNode[]
}

/** The Host dialog uses a closed shadow root, so deliver an actual browser click through CDP. */
export async function findDialogAction(page: CdpClient, action: string): Promise<BrowserNode | undefined> {
  const tree = await page.send('DOM.getDocument', { depth: -1, pierce: true }) as { root: BrowserNode }
  const visit = (node: BrowserNode): BrowserNode | undefined => {
    const attributes = node.attributes ?? []
    const index = attributes.indexOf('data-action')
    if (node.nodeName === 'BUTTON' && index >= 0 && attributes[index + 1] === action) return node
    for (const child of [...node.children ?? [], ...node.shadowRoots ?? []]) {
      const found = visit(child)
      if (found) return found
    }
    return undefined
  }
  return visit(tree.root)
}

export async function clickDialogAction(page: CdpClient, node: BrowserNode): Promise<void> {
  await page.send('Page.bringToFront')
  await page.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendNodeId })
  const result = await page.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }) as {
    model: { content: number[] }
  }
  const quad = result.model.content
  const point = { x: (quad[0]! + quad[2]!) / 2, y: (quad[1]! + quad[5]!) / 2 }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', {
      type,
      ...point,
      ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }),
    })
  }
}
