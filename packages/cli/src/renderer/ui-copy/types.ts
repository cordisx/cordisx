export type CordisXProductLocale = 'en' | 'zh-CN'

export type ProductCopyMessages = Readonly<Record<CordisXProductLocale, string>>

/** Each feature owns its keys and must supply both baseline locales. */
export type ProductCopyCatalog<Namespace extends string> = Readonly<
  Record<`${Namespace}.${string}`, ProductCopyMessages>
>
