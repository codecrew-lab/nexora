/* PULSE floating back navigation — shared by student, teacher and parent pages */
(() => {
  if (window.__pulseFloatingBackInstalled) return;
  window.__pulseFloatingBackInstalled = true;

  const page = (location.pathname.split("/").pop() || "index.html").toLowerCase();
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pulse-floating-back";
  button.setAttribute("aria-label", "Go back to the previous page");
  button.innerHTML = '<span class="pulse-floating-back__arrow" aria-hidden="true">←</span><span>Back</span>';

  button.addEventListener("click", () => {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    window.location.href = page === "portals.html" ? "index.html" : "portals.html";
  });

  const style = document.createElement("style");
  style.textContent = `
    .pulse-floating-back {
      position:fixed;
      right:max(16px, env(safe-area-inset-right));
      bottom:max(16px, env(safe-area-inset-bottom));
      z-index:90;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      gap:8px;
      min-width:88px;
      min-height:46px;
      padding:0 16px;
      border:1px solid var(--border-color, rgba(148,163,184,.28));
      border-radius:999px;
      background:var(--bg-secondary, rgba(25,29,53,.94));
      color:var(--text-primary, #f8fafc);
      box-shadow:0 8px 24px rgba(0,0,0,.22);
      -webkit-backdrop-filter:blur(14px);
      backdrop-filter:blur(14px);
      font:600 14px/1 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      cursor:pointer;
      touch-action:manipulation;
      -webkit-tap-highlight-color:transparent;
    }
    .pulse-floating-back__arrow { font-size:21px; line-height:1; }
    .pulse-floating-back:focus-visible {
      outline:3px solid var(--accent-primary, #8b5cf6);
      outline-offset:3px;
    }
    .pulse-floating-back:active { transform:scale(.97); }
    /* Reserve scroll space so the floating control does not hide the final page content. */
    main, .standalone-wrap {
      padding-bottom:calc(28px + 76px) !important;
    }
    @media (max-width:767px) {
      .pulse-floating-back {
        right:max(14px, env(safe-area-inset-right));
        bottom:max(14px, env(safe-area-inset-bottom));
        min-width:84px;
        min-height:44px;
        padding:0 14px;
      }
    }
    @media (prefers-reduced-motion:reduce) {
      .pulse-floating-back { transition:none; }
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(button);
})();
