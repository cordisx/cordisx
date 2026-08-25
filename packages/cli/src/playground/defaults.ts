import { fileURLToPath } from 'node:url'

/** The normal `dev:ui` composition: broad local UI coverage without credentials or external providers. */
export const defaultUiPlaygroundConfig = fileURLToPath(new URL('../../../../cordisx.config.playground.json', import.meta.url))
