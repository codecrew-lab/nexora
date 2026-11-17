/* NEXORA universal portal switcher — available on login screens and dashboards. */
(() => {
  const portals = [
    { id: 'student', label: 'Student', short: 'NEXORA', href: 'index.html', icon: '🎓' },
    { id: 'teacher', label: 'Teacher', short: 'NEXORA-T', href: 'teacher.html', icon: '👩‍🏫' },
    { id: 'parent', label: 'Parent', short: 'NEXORA-P', href: 'parent.html', icon: '👨‍👩‍👧' }
  ];

  const currentFile = (location.pathname.split('/').pop() || 'index.html').toLowerCase();

  // The three-portal chooser is the landing page; keep its layout free of the floating switcher.
  if (currentFile === 'portals.html') return;
  const current = currentFile.startsWith('teacher') ? 'teacher'
    : currentFile.startsWith('parent') ? 'parent' : 'student';

  function mount() {
    if (!document.body || document.getElementById('NEXORAPortalSwitcher')) return;
    const root = document.createElement('div');
    root.id = 'NEXORAPortalSwitcher';
    root.innerHTML = `
      <style>
        #NEXORAPortalSwitcher{position:fixed;right:16px;bottom:16px;z-index:11000;font-family:inherit}
        #NEXORAPortalSwitcher *{box-sizing:border-box}
        #NEXORAPortalSwitcher .NEXORA-switch-trigger{display:flex;align-items:center;gap:9px;min-height:46px;padding:10px 15px;border:1px solid rgba(148,163,184,.3);border-radius:14px;background:#171d35;color:#fff;font:inherit;font-size:13px;font-weight:700;box-shadow:0 10px 32px rgba(0,0,0,.3);cursor:pointer}
        #NEXORAPortalSwitcher .NEXORA-switch-trigger:focus-visible,#NEXORAPortalSwitcher a:focus-visible{outline:3px solid #38bdf8;outline-offset:3px}
        #NEXORAPortalSwitcher .NEXORA-switch-trigger .NEXORA-switch-chevron{font-size:11px;opacity:.75}
        #NEXORAPortalSwitcher .NEXORA-switch-menu{position:absolute;right:0;bottom:56px;width:min(260px,calc(100vw - 32px));padding:9px;border:1px solid rgba(148,163,184,.25);border-radius:16px;background:#151b30;box-shadow:0 18px 48px rgba(0,0,0,.38);display:none}
        #NEXORAPortalSwitcher[data-open="true"] .NEXORA-switch-menu{display:grid;gap:5px}
        #NEXORAPortalSwitcher .NEXORA-switch-heading{padding:8px 10px 5px;color:#a8b2c7;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}
        #NEXORAPortalSwitcher .NEXORA-switch-menu a{display:flex;align-items:center;gap:11px;padding:11px 12px;border:1px solid transparent;border-radius:11px;color:#e5e7eb;text-decoration:none;font-size:13px;font-weight:650}
        #NEXORAPortalSwitcher .NEXORA-switch-menu a:hover{background:rgba(148,163,184,.12);border-color:rgba(148,163,184,.2)}
        #NEXORAPortalSwitcher .NEXORA-switch-menu a[aria-current="page"]{background:rgba(99,102,241,.2);border-color:rgba(129,140,248,.4);color:#fff}
        #NEXORAPortalSwitcher .NEXORA-switch-menu small{display:block;margin-top:2px;color:#a8b2c7;font-size:11px;font-weight:500}
        #NEXORAPortalSwitcher .NEXORA-switch-note{padding:8px 10px 5px;color:#a8b2c7;font-size:10px;line-height:1.45}
        @media(max-width:480px){#NEXORAPortalSwitcher{right:12px;bottom:12px}#NEXORAPortalSwitcher .NEXORA-switch-trigger{min-height:44px;padding:9px 12px}}
        @media(prefers-reduced-motion:no-preference){#NEXORAPortalSwitcher .NEXORA-switch-trigger{transition:transform .16s ease,background .16s ease}#NEXORAPortalSwitcher .NEXORA-switch-trigger:active{transform:scale(.98)}}
      </style>
      <button class="NEXORA-switch-trigger" type="button" aria-expanded="false" aria-controls="NEXORAPortalSwitchMenu">
        <span aria-hidden="true">🔄</span><span>Switch portal</span><span class="NEXORA-switch-chevron" aria-hidden="true">▲</span>
      </button>
      <nav class="NEXORA-switch-menu" id="NEXORAPortalSwitchMenu" aria-label="Choose a NEXORA portal">
        <div class="NEXORA-switch-heading">Go to portal</div>
        ${portals.map(portal => `
          <a href="${portal.href}" ${portal.id === current ? 'aria-current="page"' : ''}>
            <span aria-hidden="true">${portal.icon}</span>
            <span>${portal.label}<small>${portal.short}${portal.id === current ? ' · Current portal' : ''}</small></span>
          </a>`).join('')}
        <div class="NEXORA-switch-note">Your next portal will verify its own sign-in. Switching here does not grant access to another role.</div>
      </nav>`;
    document.body.appendChild(root);
    const trigger = root.querySelector('.NEXORA-switch-trigger');
    const close = () => { root.dataset.open = 'false'; trigger.setAttribute('aria-expanded', 'false'); };
    trigger.addEventListener('click', () => {
      const open = root.dataset.open !== 'true';
      root.dataset.open = String(open);
      trigger.setAttribute('aria-expanded', String(open));
    });
    root.querySelectorAll('a').forEach(link => link.addEventListener('click', close));
    document.addEventListener('click', event => { if (!root.contains(event.target)) close(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') { close(); trigger.focus(); } });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();

  // Student auth replaces the body to render its login screen; restore the switcher afterward.
  const observer = new MutationObserver(() => mount());
  const startObserver = () => { if (document.body) observer.observe(document.body, { childList: true }); };
  if (document.body) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver, { once: true });
})();