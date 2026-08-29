import type { Context } from '@deepseek-ai/cordis'
import { CORDISX_PAGE_SCHEMA_V3, CORDISX_ROUTE_SCHEMA_V2, type CordisXNavigationCollectionSnapshot } from 'cordisx/contracts'

const message = (key: string, fallback: string) => ({ namespace: 'navigation-collection', key, fallback } as const)

let snapshot: CordisXNavigationCollectionSnapshot = {
  revision: 1,
  items: [
    { id: 'latest', label: message('room.latest', 'Latest room'), route: { id: 'room', params: { roomId: 'latest' } }, order: 0 },
    { id: 'older', label: message('room.older', 'Older room'), route: { id: 'room', params: { roomId: 'older' } }, order: 10 },
  ],
}
const listeners = new Set<() => void>()

export const inject = ['i18n', 'pages', 'routes', 'slots']

export function apply(ctx: Context): void {
  const scope = globalThis as typeof globalThis & {
    __cordisxNavigationCollectionFixture?: { replace(next: CordisXNavigationCollectionSnapshot): void }
  }
  scope.__cordisxNavigationCollectionFixture = {
    replace(next) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
  ctx.i18n.define({
    namespace: 'navigation-collection', locale: 'en', default: true,
    messages: {
      'navigation.new': 'New room', 'navigation.rooms': 'Rooms',
      'room.latest': 'Latest room', 'room.older': 'Older room',
      'page.new.title': 'Start a room', 'page.new.description': 'Composes the first message for a new room.',
      'page.room.title': 'Room conversation', 'page.room.description': 'Shows one selected room conversation.',
      'route.new.title': 'New room', 'route.new.description': 'Open a new room.',
      'route.room.title': 'Open room', 'route.room.description': 'Open an existing room.',
    },
  })
  ctx.i18n.define({
    namespace: 'navigation-collection', locale: 'zh-CN',
    messages: {
      'navigation.new': '新建房间', 'navigation.rooms': '房间',
      'room.latest': '最新房间', 'room.older': '较早房间',
      'page.new.title': '开始新房间', 'page.new.description': '为新房间编写第一条消息。',
      'page.room.title': '房间会话', 'page.room.description': '显示当前选中的房间会话。',
      'route.new.title': '新建房间', 'route.new.description': '打开一个新房间。',
      'route.room.title': '打开房间', 'route.room.description': '打开已有房间。',
    },
  })
  ctx.pages.register({
    $schema: CORDISX_PAGE_SCHEMA_V3,
    schemaVersion: 3,
    id: 'new-room',
    title: message('page.new.title', 'Start a room'),
    description: message('page.new.description', 'Composes the first message for a new room.'),
    chrome: 'standard',
  }, ({ container }) => {
    container.textContent = 'New room'
    return () => { container.textContent = '' }
  })
  ctx.pages.register({
    $schema: CORDISX_PAGE_SCHEMA_V3,
    schemaVersion: 3,
    id: 'room',
    title: message('page.room.title', 'Room conversation'),
    description: message('page.room.description', 'Shows one selected room conversation.'),
    chrome: 'standard',
  }, ({ container, params }) => {
    container.textContent = `Room ${String(params.roomId ?? 'new')}`
    return () => { container.textContent = '' }
  })
  ctx.routes.register({
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: 'new-room',
    path: '/main/rooms/new',
    outlet: 'main',
    page: 'new-room',
    title: message('route.new.title', 'New room'),
    description: message('route.new.description', 'Open a new room.'),
  })
  ctx.routes.register({
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: 'room',
    path: '/main/rooms/:roomId',
    outlet: 'main',
    page: 'room',
    title: message('route.room.title', 'Open room'),
    description: message('route.room.description', 'Open an existing room.'),
  })
  ctx.slots.register({ name: 'sidebar.navigation.items', id: 'new-room', group: 'primary', order: 0 }, {
    label: message('navigation.new', 'New room'),
    route: { id: 'new-room' },
  })
  ctx.slots.registerCollection({
    name: 'sidebar.navigation.items', id: 'rooms',
    group: { id: 'rooms', label: message('navigation.rooms', 'Rooms'), order: 20 },
  }, {
    snapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  })
  ctx.effect(() => () => {
    delete scope.__cordisxNavigationCollectionFixture
    listeners.clear()
  }, 'navigation collection fixture cleanup')
}
