/** Host-owned page chrome and bounded scrolling shared by schema and configuration forms. */
export const HOST_FORM_PAGE_STYLES = String.raw`
  .cxf-form-page-stack, .cxf-form-page-root, .cxf-form-page-layer, .cxf-form-subpage { display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; overflow: hidden; }
  :is(.cxf-form-page-root,.cxf-form-page-layer)[hidden] { display: none; }
  .cxf-form-subpage-header { display: grid; min-width: 0; grid-template-columns: 32px minmax(0,1fr); flex: none; align-items: center; gap: 8px; border-bottom: 1px solid var(--cx-border,#353a42); padding: 4px 0 12px; }
  .cxf-form-subpage-header-seat { display: grid; width: 32px; height: 32px; place-items: center; }
  .cxf-form-subpage-header-seat > .t-button { width: 32px; height: 32px; padding: 0; }
  .cxf-form-subpage-header-seat > .t-button :is(.t-icon,.cordisx-host-icon) { width: 16px; height: 16px; color: var(--cx-muted,#9ca5b5); font-size: 16px !important; }
  .cxf-form-surface, .cxf-react-form-shell { display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; }
  .cxf-form-page { display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; }
  .cxf-form-page-scroll { min-width: 0; min-height: 0; }
  .cxf-form-page[data-form-page-layout="fill"] > .cxf-form-page-scroll { flex: 1; overflow: auto; }
  .cxf-form-page-root > form { display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; }
  .cxf-form-page-footer { flex: none; border-top: 1px solid var(--cx-border,#353a42); padding: 12px 0; background: var(--cx-surface,#17191d); }
  .cxf-form-subpage-body { min-width: 0; padding: 16px 0; }
`
