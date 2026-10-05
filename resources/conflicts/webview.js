(function () {
  const vscode = acquireVsCodeApi();

  document.getElementById("conflict-list")?.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const t = ev.target;
    const el = t && t.nodeType === 1 ? t : t && t.parentElement;
    const row = el && el.closest ? el.closest(".conflict-row[data-key]") : null;
    if (!row || (el && el.closest && el.closest(".pick"))) return;
    const key = row.getAttribute("data-key");
    if (!key) return;
    ev.preventDefault();
    vscode.postMessage({ type: "select", key: key });
  });

  document.getElementById("conflict-list")?.addEventListener("click", (ev) => {
    const t = ev.target;
    const el = t && t.nodeType === 1 ? t : t && t.parentElement;
    const row = el && el.closest ? el.closest(".conflict-row[data-key]") : null;
    if (!row) return;
    const key = row.getAttribute("data-key");
    if (!key) return;
    const pick = el && el.closest ? el.closest(".pick[data-side]") : null;
    if (pick) {
      const side = pick.getAttribute("data-side") || "local";
      vscode.postMessage({ type: "choose", key: key, side: side });
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    vscode.postMessage({ type: "select", key: key });
  });

  document.getElementById("keep-all-local")?.addEventListener("click", () => {
    vscode.postMessage({ type: "keepAll", side: "local" });
  });
  document.getElementById("keep-all-remote")?.addEventListener("click", () => {
    vscode.postMessage({ type: "keepAll", side: "remote" });
  });
  document.getElementById("apply")?.addEventListener("click", () => {
    vscode.postMessage({ type: "apply" });
  });
  document.getElementById("cancel-sync")?.addEventListener("click", () => {
    vscode.postMessage({ type: "cancel" });
  });
})();
