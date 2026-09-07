(function () {
  const vscode = acquireVsCodeApi();

  document.getElementById("proceed")?.addEventListener("click", () => {
    vscode.postMessage({ type: "proceed" });
  });
  document.getElementById("cancel-sync")?.addEventListener("click", () => {
    vscode.postMessage({ type: "cancel" });
  });
})();
