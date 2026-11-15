/* PULSE universal back navigation */
(() => {
  if (window.__pulseBackNavigationInstalled) return;
  window.__pulseBackNavigationInstalled = true;

  const pageName = () => (location.pathname.split("/").pop() || "index.html").toLowerCase();

  const button = document.createElement("button");
  button.type = "button";
  button.className = "pulse-back-button";
  button.setAttribute("aria-label", "Go back to the previous page");
  button.innerHTML = '<span aria-hidden="true">←</span><span>Back</span>';
  button.addEventListener("click", () => {
    if (window.history.length > 1) window.history.back();
    else window.location.href = pageName() === "portals.html" || pageName() === "index.html"
      ? "portals.html"
      : "portals.html";
  });

  const style = document.createElement("style");
  style.textContent = `
    .pulse-back-button {
      display:inline-flex; align-items:center; justify-content:center; gap:7px;
      min-height:38px; padding:0 13px; margin:0 0 16px;
      border:1px solid var(--border-color, rgba(120,130,150,.28));
      border-radius:11px; background:var(--bg-card, rgba(255,255,255,.08));
      color:var(--text-primary, inherit); box-shadow:0 3px 12px rgba(20,30,50,.10);
      font:600 14px/1.2 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      cursor:pointer; touch-action:manipulation; -webkit-tap-highlight-color:transparent;
    }
    .pulse-back-button span:first-child { font-size:19px; line-height:1; }
    .pulse-back-button:focus-visible { outline:3px solid var(--accent-primary, #4f8cff); outline-offset:3px; }
    .pulse-back-button:active { transform:scale(.98); }
    @media (max-width:767px) { .pulse-back-button { min-height:40px; } }
  `;
  document.head.appendChild(style);

  // Keep the control in normal document flow, below the fixed menu and outside the logo/sidebar.
  const content = document.querySelector("main") || document.querySelector(".standalone-wrap") || document.body;
  content.insertBefore(button, content.firstChild);
})();
