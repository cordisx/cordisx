/**
 * Host-owned product copy. Feature catalogs own their bilingual key/value pairs;
 * this entry preserves the resolver API and derives its key type from the data.
 */
import type { CordisXProductLocale, ProductCopyMessages } from './ui-copy/types.js'
import { CHANNEL_COPY } from './ui-copy/channel.js'
import { MARKETPLACE_CATALOG_COPY, MARKETPLACE_SOURCE_COPY, MARKETPLACE_TAB_COPY } from './ui-copy/marketplace.js'
import {
  ACTION_COPY,
  EXTENSION_COPY,
  EXTENSION_TAB_COPY,
  LAUNCHER_COPY,
  MANAGER_NAVIGATION_COPY,
  PERMISSION_COPY,
  ROUTE_COPY,
  STATUS_COPY,
} from './ui-copy/manager.js'
import {
  PLUGIN_COLLECTION_COPY,
  PLUGIN_SHARING_DEMO_COPY,
  PLUGIN_STATUS_COPY,
  PLUGIN_TAB_COPY,
} from './ui-copy/plugins.js'
import { RUNTIME_DETAIL_COPY, RUNTIME_EMPTY_COPY } from './ui-copy/runtime.js'
import { CONSOLE_COPY } from './ui-copy/console.js'
import { FORM_COPY } from './ui-copy/form.js'

export type { CordisXProductLocale } from './ui-copy/types.js'

// Preserve the catalog's existing enumeration order for diagnostics and gates.
const catalog = {
  ...CHANNEL_COPY,
  ...MARKETPLACE_SOURCE_COPY,
  ...MANAGER_NAVIGATION_COPY,
  ...PLUGIN_COLLECTION_COPY,
  ...PLUGIN_STATUS_COPY,
  ...RUNTIME_DETAIL_COPY,
  ...CONSOLE_COPY,
  ...PLUGIN_SHARING_DEMO_COPY,
  ...PLUGIN_TAB_COPY,
  ...EXTENSION_TAB_COPY,
  ...EXTENSION_COPY,
  ...MARKETPLACE_TAB_COPY,
  ...ROUTE_COPY,
  ...MARKETPLACE_CATALOG_COPY,
  ...RUNTIME_EMPTY_COPY,
  ...LAUNCHER_COPY,
  ...ACTION_COPY,
  ...STATUS_COPY,
  ...PERMISSION_COPY,
  ...FORM_COPY,
}

type CopyKey = keyof typeof catalog

const COPY: Readonly<Record<CopyKey, ProductCopyMessages>> = Object.freeze(catalog)

export function productLocale(locale: string): CordisXProductLocale {
  return new Intl.Locale(locale).language === 'zh' ? 'zh-CN' : 'en'
}

export function managerCopy(locale: string, key: CopyKey): string {
  return COPY[key][productLocale(locale)]
}

/** Exposed to the copy gate: every product-copy key must ship both baseline locales. */
export const MANAGER_PRODUCT_COPY = COPY
