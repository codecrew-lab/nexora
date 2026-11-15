/* PULSE universal back navigation */
(() => {
  if (window.__pulseBackNavigationInstalled) return;
  window.__pulseBackNavigationInstalled = true;
  const pageName = () => (location.pathname.split("/").pop() || "index.html").toLowerCase();
  if (pageName() === "index.html") return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pulse-back-button";
  button.setAttribute("aria-label", "Go back to the previous page");
  button.innerHTML = '<span aria-hidden="true">←</span><span>Back</span>';
  button.addEventListener("click", () => {
    if (window.history.length > 1) window.history.back();
    else window.location.href = pageName() === "portals.html" ? "index.html" : "portals.html";
  });
  const style = document.createElement("style");
  style.textContent = `.pulse-back-button{position:fixed;left:max(14px,env(safe-area-inset-left));top:max(12px,env(safe-area-inset-top));z-index:10000;display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:42px;padding:0 15px;border:1px solid rgba(120,130,150,.28);border-radius:999px;background:rgba(255,255,255,.94);color:#182235;box-shadow:0 4px 16px rgba(20,30,50,.13);font:600 14px/1.2 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;-webkit-tap-highlight-color:transparent;backdrop-filter:blur(12px)}.pulse-back-button span:first-child{font-size:20px;line-height:1}.pulse-back-button:focus-visible{outline:3px solid #4f8cff;outline-offset:3px}.pulse-back-button:active{transform:scale(.97)}@media(prefers-color-scheme:dark){.pulse-back-button{background:rgba(30,38,52,.95);color:#f4f6fb;border-color:rgba(190,200,220,.25)}}`;
  document.head.appendChild(style);
  document.body.appendChild(button);
})();