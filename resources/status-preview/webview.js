(function () {
  const vscode = acquireVsCodeApi();

  function syncKeyFromEvent(ev) {
    const t = ev.target;
    const el = t && t.nodeType === 1 ? t : t && t.parentElement;
    const row = el && el.closest ? el.closest("[data-sync-key]") : null;
    return row ? row.getAttribute("data-sync-key") : null;
  }

  document.addEventListener("click", (ev) => {
    const t = ev.target;
    const el = t && t.nodeType === 1 ? t : t && t.parentElement;
    const refresh = el && el.closest ? el.closest('[data-command="refresh"]') : null;
    if (refresh) {
      if (refresh.disabled) return;
      ev.preventDefault();
      vscode.postMessage({ type: "refresh" });
      return;
    }
    const syncKey = syncKeyFromEvent(ev);
    if (!syncKey) return;
    ev.preventDefault();
    vscode.postMessage({ type: "open", syncKey: syncKey });
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const syncKey = syncKeyFromEvent(ev);
    if (!syncKey) return;
    ev.preventDefault();
    vscode.postMessage({ type: "open", syncKey: syncKey });
  });
})();
