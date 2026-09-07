import {
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V10,
  type CordisXHostExtensionPointCatalogV10,
  type CordisXLocaleCatalog,
} from '../contracts.js'

const namespace = 'cordisx-composer-visuals'
const en = {
  'primary.title': 'Composer primary action visual',
  'primary.description': 'Replace the inner visual while the native button retains its action and accessibility.',
  'overlay.title': 'Composer frame overlay',
  'overlay.description': 'Bounded pointer-inert SVG decoration with separately authorized pointer observation.',
}
const zh = {
  'primary.title': '输入框主操作视觉',
  'primary.description': '替换内部视觉，原生按钮保留操作和无障碍语义。',
  'overlay.title': '输入框覆盖视觉',
  'overlay.description': '限定范围内的 SVG 装饰，点击穿透；指针观察需单独授权。',
}
export const COMPOSER_VISUAL_LOCALES: readonly CordisXLocaleCatalog[] = [
  { namespace, locale: 'en', default: true, messages: en },
  { namespace, locale: 'zh-CN', messages: zh },
]
export const COMPOSER_VISUAL_CATALOG: CordisXHostExtensionPointCatalogV10 = {
  $schema: CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V10,
  schemaVersion: 10,
  points: (['composer.primary-action.visual', 'composer.frame.overlay'] as const).map((id, index) => {
    const key = index === 0 ? 'primary' : 'overlay'
    return {
      id,
      kind: 'surface',
      payloadFamily: 'extension-point-visual-v1',
      maturity: 'experimental',
      adapterSupport: 'supported',
      icon: 'host:sparkles',
      events: ['pointer.observe'],
      title: { namespace, key: `${key}.title`, fallback: en[`${key}.title`] },
      description: { namespace, key: `${key}.description`, fallback: en[`${key}.description`] },
    }
  }),
}
