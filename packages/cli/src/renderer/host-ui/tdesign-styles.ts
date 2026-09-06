import tdesignReactCss from 'tdesign-react/dist/tdesign.css'

/** Official styles stay within Host roots; authoritative theme attributes outrank upstream token selectors. */
export const HOST_TDESIGN_REACT_STYLES = `@scope (.cxh-tdesign-root) {
${
  tdesignReactCss
    .replaceAll(':root.dark', ":scope[data-cordisx-app-theme='dark']")
    .replaceAll(":root[theme-mode='dark']", ":scope[data-cordisx-app-theme='dark']")
    .replaceAll(':root', ':scope')
}

}
.cxh-tdesign-root[data-cordisx-app-theme][data-cordisx-theme-source] {
  --td-brand-color: var(--cx-primary);
  --td-brand-color-hover: color-mix(in srgb, var(--cx-primary) 88%, var(--cx-text));
  --td-brand-color-active: color-mix(in srgb, var(--cx-primary) 78%, var(--cx-text));
  --td-brand-color-disabled: color-mix(in srgb, var(--cx-primary) 45%, var(--cx-surface));
  --td-brand-color-light: color-mix(in srgb, var(--cx-primary) 12%, var(--cx-surface));
  --td-brand-color-light-hover: color-mix(in srgb, var(--cx-primary) 20%, var(--cx-surface));
  --td-brand-color-focus: color-mix(in srgb, var(--cx-focus) 26%, transparent);
  --td-text-color-primary: var(--cx-text);
  --td-text-color-secondary: var(--cx-muted);
  --td-text-color-placeholder: color-mix(in srgb, var(--cx-muted) 78%, transparent);
  --td-text-color-disabled: color-mix(in srgb, var(--cx-text) 68%, var(--cx-surface));
  --td-text-color-anti: var(--cx-primary-text);
  --td-bg-color-container: var(--cx-surface);
  --td-bg-color-container-hover: var(--cx-hover);
  --td-bg-color-container-active: var(--cx-pressed);
  --td-bg-color-container-select: var(--cx-pressed);
  --td-bg-color-secondarycontainer: var(--cx-surface-raised);
  --td-bg-color-secondarycontainer-hover: var(--cx-hover);
  --td-bg-color-secondarycontainer-active: var(--cx-pressed);
  --td-bg-color-component: var(--cx-surface-raised);
  --td-bg-color-specialcomponent: var(--cx-surface-raised);
  --td-bg-color-component-hover: var(--cx-hover);
  --td-bg-color-component-active: var(--cx-pressed);
  --td-bg-color-component-disabled: color-mix(in srgb, var(--cx-surface-raised) 70%, var(--cx-muted));
  --td-border-level-2-color: var(--cx-border);
  --td-error-color: var(--cx-danger);
  color-scheme: light;
}
.cxh-tdesign-root[data-cordisx-app-theme="dark"] { color-scheme: dark; }
`
