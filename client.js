window.__ModuleLoader__.load({
  id: '@oheco/dsh-service-tier',
  factory(require) {
    const React = require('react'), { createPortal } = require('react-dom'), h = React.createElement;
    const NS = 'oheco.serviceTier';
    const dicts = {
      zh: { default: '标准', fast: '快速', ultrafast: '超快速', label: '处理速度', hint: '从下一次请求生效。快速和超快速可能采用更高价格；中转站或模型不支持时，请切回标准或其他支持的模式。', reload: '重新加载', error: '处理速度加载失败' },
      en: { default: 'Standard', fast: 'Fast', ultrafast: 'Ultrafast', label: 'Processing speed', hint: 'Applies to the next request. Fast and Ultrafast may cost more; select Standard or a supported mode if the gateway or model rejects it.', reload: 'Reload', error: 'Unable to load processing mode' },
    };
    // DSH ModelSelect/MenuSurface layout (MIT), using plugin-prefixed classes.
    const css = `
.ost-root{position:relative;display:flex;align-items:center;min-width:0;font:inherit}
.ost-trigger{border-radius:8px;height:28px;min-width:0;color:var(--dsw-alias-label-secondary);cursor:pointer;background:transparent;border:none;outline:none;display:flex;align-items:center;gap:4px;padding:0 4px 0 8px;font:inherit;font-size:13px;font-weight:400;line-height:20px}
.ost-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.ost-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary)}.ost-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.ost-chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s}.ost-chevron-open{transform:rotate(180deg)}
.ost-menu{z-index:1100;position:fixed;isolation:isolate;display:flex;flex-direction:column;width:240px;max-width:calc(100vw - 32px);max-height:calc(100vh - 96px);padding:4px;border:0;border-radius:16px;color:var(--dsw-alias-label-primary);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);font:inherit;overflow:hidden}
.ost-material{position:absolute;inset:0;z-index:-1;border-radius:inherit;background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-layer-2));backdrop-filter:var(--dsw-menu-backdrop-filter);pointer-events:none}
.ost-option{appearance:none;display:flex;align-items:center;gap:8px;width:100%;min-height:36px;border:0;border-radius:12px;padding:8px 12px;background:transparent;color:inherit;text-align:left;font:inherit;font-size:14px;line-height:20px;cursor:pointer;outline:none}.ost-option:hover:enabled,.ost-option:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}.ost-option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.ost-option-label{flex:1}.ost-check{flex:none;color:var(--dsw-alias-state-business-primary)}.ost-hint{padding:8px 12px 6px;color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}
.ost-error{color:var(--dsw-alias-state-error-primary);font-size:12px}.ost-reload{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;padding:4px}
`;
    const icon = (path, className) => h('svg', { className, width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': true }, h('path', { d: path, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dicts));
        const listeners = new Set(), notify = () => { for (const refresh of listeners) refresh(); };
        ctx.on('connection/reset', notify); ctx.on('settings/document-updated', notify); ctx.on('llm/adapters-updated', notify);
        async function rpc(action, input) {
          const result = await ctx.connection.rpc.call('/api', `oheco-service-tier/${action}`, input);
          if (!result.ok) throw new Error(result.error.message);
          return result.value;
        }
        function TierControl(props) {
          const { t, sessionId } = props, projection = props.useProjection('modelSelection');
          const removed = props.useSession(state => state.removed);
          const [fallback, setFallback] = React.useState(null);
          const selection = projection === undefined ? undefined : projection.next ?? fallback;
          const [state, setState] = React.useState(null), [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false), [open, setOpen] = React.useState(false);
          const [position, setPosition] = React.useState({ left: 16, top: 16, visibility: 'hidden' });
          const trigger = React.useRef(null), menu = React.useRef(null), identity = React.useRef(''), generation = React.useRef(0), id = React.useId();
          const key = JSON.stringify([sessionId, selection?.provider, selection?.model]); identity.current = key;
          React.useEffect(() => {
            const controller = new AbortController();
            const refreshDefault = () => {
              if (projection?.next !== null) return;
              ctx.connection.rpc.call('/api', 'session/modelCatalog', { args: {} }, controller.signal).then(result => { if (!controller.signal.aborted && result.ok) setFallback(result.value.default); }).catch(() => {});
            };
            refreshDefault(); listeners.add(refreshDefault);
            return () => { controller.abort(); listeners.delete(refreshDefault); };
          }, [projection?.next, sessionId]);
          const refresh = React.useCallback(async () => {
            const expected = key, serial = ++generation.current;
            if (!selection || removed) return;
            try {
              const result = await rpc('describe', { sessionId, provider: selection.provider, model: selection.model });
              if (identity.current === expected && generation.current === serial) { setState(result); setError(''); }
            } catch (err) { if (identity.current === expected && generation.current === serial) setError(err.message); }
          }, [key, removed]);
          React.useEffect(() => {
            setState(null); setError(''); setOpen(false); setBusy(false); refresh(); listeners.add(refresh);
            return () => { listeners.delete(refresh); generation.current++; };
          }, [refresh]);
          const close = React.useCallback((restore = false) => { setOpen(false); if (restore) trigger.current?.focus(); }, []);
          React.useLayoutEffect(() => {
            if (!open) return;
            const place = () => {
              const anchor = trigger.current?.getBoundingClientRect(), panel = menu.current?.getBoundingClientRect();
              if (!anchor || !panel) return;
              setPosition({ left: Math.max(16, Math.min(anchor.right - panel.width, window.innerWidth - panel.width - 16)), top: anchor.top >= panel.height + 24 ? anchor.top - panel.height - 8 : Math.max(16, Math.min(anchor.bottom + 8, window.innerHeight - panel.height - 16)), visibility: 'visible' });
            };
            place(); (menu.current?.querySelector('[aria-checked="true"]') ?? menu.current?.querySelector('[role="menuitemradio"]'))?.focus();
            const outside = event => { if (!menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) close(); };
            document.addEventListener('pointerdown', outside, true); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
            return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
          }, [open, close]);
          async function choose(tier) {
            if (busy) return;
            close(true); if (tier === state.tier) return;
            const expected = key; generation.current++; setBusy(true); setError('');
            try {
              const result = await rpc('set-session', { sessionId, provider: selection.provider, model: selection.model, tier, revision: state.revision });
              if (identity.current === expected) setState(current => ({ ...current, ...result }));
            } catch (err) { if (identity.current === expected) { await refresh(); setError(err.message); } }
            finally { if (identity.current === expected) setBusy(false); }
          }
          function menuKey(event) {
            const rows = [...menu.current.querySelectorAll('[role="menuitemradio"]:not(:disabled)')], current = rows.indexOf(document.activeElement);
            if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); close(true); }
            else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length; rows[next]?.focus();
            }
          }
          if (removed || !selection || (state && !state.supported) || (!state && !error)) return null;
          return h('div', { className: 'ost-root' }, h('style', null, css),
            state ? h('button', { ref: trigger, className: 'ost-trigger', type: 'button', disabled: busy, title: t('hint'), 'aria-label': `${t('label')}: ${t(state.tier)}`, 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-controls': open ? id : undefined, 'aria-busy': busy,
              onClick: () => { if (open) close(true); else { setOpen(true); refresh(); } }, onKeyDown: event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } } }, h('span', null, t(state.tier)), icon('m7 10 5 5 5-5', `ost-chevron${open ? ' ost-chevron-open' : ''}`)) : null,
            error ? h('span', { className: 'ost-error', role: 'alert', title: error }, state ? '!' : t('error'), h('button', { className: 'ost-reload', type: 'button', onClick: refresh }, t('reload'))) : null,
            open && state ? createPortal(h('div', { ref: menu, id, className: 'ost-menu', style: position, role: 'menu', 'aria-label': t('label'), onKeyDown: menuKey, onBlur: event => { if (event.relatedTarget && !menu.current?.contains(event.relatedTarget) && !trigger.current?.contains(event.relatedTarget)) close(); } },
              h('div', { className: 'ost-material', 'data-menu-material': true }),
              ...(state.tiers ?? ['default', 'fast']).map(tier => h('button', { key: tier, className: 'ost-option', type: 'button', role: 'menuitemradio', 'aria-checked': state.tier === tier, disabled: busy, onClick: () => choose(tier) }, h('span', { className: 'ost-option-label' }, t(tier)), state.tier === tier ? icon('m5 12 4 4L19 6', 'ost-check') : null)), h('div', { className: 'ost-hint' }, t('hint'))), document.body) : null);
        }
        ctx.slots.inject('conversation.input.right', () => {
          const dispose = ctx.slots.register({ name: 'conversation.input.right', id: 'oheco-service-tier', order: 30, locale: NS }, TierControl);
          rpc('client-ready', { slot: 'conversation.input.right', registered: true }).catch(() => {});
          return dispose;
        });
      },
    };
  },
});
