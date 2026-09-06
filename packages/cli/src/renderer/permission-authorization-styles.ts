export const PERMISSION_AUTHORIZATION_STYLES = `
  .cxp-overlay { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 24px; box-sizing: border-box; background: var(--cx-backdrop); color: var(--cx-text); }
  .cxp-dialog { width: min(680px, 100%); max-height: min(760px, calc(100vh - 48px)); overflow: auto; box-sizing: border-box; border: 1px solid var(--cx-border); border-radius: 16px; padding: 20px; background: var(--cx-surface); color: var(--cx-text); box-shadow: 0 24px 80px var(--cx-shadow); }
  .cxp-header { display: flex; gap: 12px; align-items: flex-start; }
  .cxp-icon { display: grid; place-items: center; width: 36px; height: 36px; flex: 0 0 auto; border-radius: 10px; background: var(--cx-hover); color: var(--cx-primary); }
  .cxp-header-copy { min-width: 0; flex: 1; }
  .cxp-title { margin: 0; font-size: 19px; line-height: 1.3; }
  .cxp-plugin-name { margin: 5px 0 0; font-weight: 600; }
  .cxp-plugin-meta { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 3px 10px; margin: 8px 0 0; color: var(--cx-muted); font-size: 12px; }
  .cxp-plugin-meta dt, .cxp-plugin-meta dd { margin: 0; min-width: 0; }
  .cxp-plugin-meta dd { overflow-wrap: anywhere; color: var(--cx-text); }
  .cxp-list { display: grid; margin-top: 18px; }
  .cxp-item { padding: 18px 0; border-top: 1px solid var(--cx-border); }
  .cxp-item:first-child { border-top: 0; }
  .cxp-item-heading { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
  .cxp-item-heading h3 { margin: 0; font-size: 15px; }
  .cxp-badge { border: 1px solid var(--cx-border); border-radius: 999px; padding: 2px 7px; color: var(--cx-muted); font-size: 11px; }
  .cxp-badge[data-risk="high-risk"], .cxp-risk[data-risk="high-risk"] { color: var(--cx-danger); }
  .cxp-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 5px 12px; margin: 12px 0 0; font-size: 13px; line-height: 1.45; }
  .cxp-facts dt, .cxp-facts dd { margin: 0; min-width: 0; }
  .cxp-facts dt { color: var(--cx-muted); }
  .cxp-facts dd { overflow-wrap: anywhere; }
  .cxp-risk { margin: 10px 0 0; color: var(--cx-muted); font-size: 13px; line-height: 1.45; }
  .cxp-availability { margin-top: 10px; color: var(--cx-muted); font-size: 12px; }
  .cxp-rationale { margin-top: 13px; padding: 12px 0 0 12px; border-left: 2px solid var(--cx-border); }
  .cxp-rationale-label { margin: 0 0 7px; color: var(--cx-muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  .cxp-rationale-title { margin: 0; font-size: 13px; font-weight: 600; }
  .cxp-rationale-description { margin: 4px 0 0; color: var(--cx-muted); font-size: 13px; line-height: 1.45; }
  .cxp-rationale dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 10px; margin: 8px 0 0; font-size: 12px; }
  .cxp-rationale dt, .cxp-rationale dd { margin: 0; }
  .cxp-rationale dt { color: var(--cx-muted); }
  .cxp-decisions { min-width: 0; margin: 14px 0 0; padding: 0; border: 0; }
  .cxp-decisions legend { margin-bottom: 7px; padding: 0; font-size: 12px; font-weight: 600; }
  .cxp-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
  .cxp-option { display: flex; gap: 8px; align-items: center; min-width: 0; border: 1px solid var(--cx-border); border-radius: 10px; padding: 9px 10px; background: var(--cx-surface-raised); cursor: pointer; }
  .cxp-option:hover { background: var(--cx-hover); }
  .cxp-option[aria-checked="true"] { border-color: var(--cx-primary); }
  .cxp-option .t-radio__label { overflow-wrap: anywhere; font-size: 13px; }
  .cxp-denial { margin: 8px 0 0; color: var(--cx-danger); font-size: 12px; line-height: 1.4; }
  .cxp-technical { margin-top: 12px; color: var(--cx-muted); font-size: 12px; }
  .cxp-technical summary { width: fit-content; cursor: pointer; color: var(--cx-text); }
  .cxp-technical dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 10px; margin: 8px 0 0; }
  .cxp-technical dt, .cxp-technical dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .cxp-actions { display: flex; align-items: center; gap: 8px; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--cx-border); }
  .cxp-actions .cxp-manage { margin-right: auto; }
  .cxp-button { border: 1px solid var(--cx-border); border-radius: 9px; padding: 8px 12px; background: var(--cx-surface-raised); color: var(--cx-text); font: inherit; cursor: pointer; }
  .cxp-button:hover { background: var(--cx-hover); }
  .cxp-button:active { background: var(--cx-pressed); }
  .cxp-button[data-primary="true"] { border-color: var(--cx-primary); background: var(--cx-primary); color: var(--cx-primary-text); font-weight: 600; }
  .cxp-button:disabled { opacity: var(--cx-disabled); cursor: not-allowed; }
  .cxp-button, .cxp-option, .cxp-option input, .cxp-technical summary { -webkit-app-region: no-drag; }
  .cxp-button:focus-visible, .cxp-option:focus-visible, .cxp-technical summary:focus-visible { outline: 2px solid var(--cx-focus); outline-offset: 2px; }
  @media (max-width: 560px) { .cxp-overlay { padding: 10px; } .cxp-dialog { max-height: calc(100vh - 20px); } .cxp-options { grid-template-columns: 1fr; } .cxp-actions { flex-wrap: wrap; } }
`
