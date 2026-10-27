(function () {
  var vscode = acquireVsCodeApi();

  function applyRender(msg) {
    var heading = document.getElementById("preview-heading");
    if (heading && typeof msg.heading === "string") {
      heading.textContent = msg.heading;
    }
    var counts = document.getElementById("preview-counts");
    if (counts) {
      counts.innerHTML = typeof msg.countsHtml === "string" ? msg.countsHtml : "";
    }
    var main = document.getElementById("preview-main");
    if (main && typeof msg.bodyHtml === "string") {
      main.innerHTML = msg.bodyHtml;
    }
    var refresh = document.getElementById("preview-refresh");
    if (refresh) {
      refresh.disabled = msg.refreshDisabled === true;
    }
  }

  window.addEventListener("message", function (ev) {
    var msg = ev.data;
    if (!msg || msg.type !== "render") return;
    applyRender(msg);
  });

  function syncKeyFromEvent(ev) {
    var t = ev.target;
    var el = t && t.nodeType === 1 ? t : t && t.parentElement;
    var row = el && el.closest ? el.closest("[data-sync-key]") : null;
    return row ? row.getAttribute("data-sync-key") : null;
  }

  document.addEventListener("click", function (ev) {
    var t = ev.target;
    var el = t && t.nodeType === 1 ? t : t && t.parentElement;
    var refresh = el && el.closest ? el.closest('[data-command="refresh"]') : null;
    if (refresh) {
      if (refresh.disabled) return;
      ev.preventDefault();
      vscode.postMessage({ type: "refresh" });
      return;
    }
    var syncKey = syncKeyFromEvent(ev);
    if (!syncKey) return;
    ev.preventDefault();
    vscode.postMessage({ type: "open", syncKey: syncKey });
  });

  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    var syncKey = syncKeyFromEvent(ev);
    if (!syncKey) return;
    ev.preventDefault();
    vscode.postMessage({ type: "open", syncKey: syncKey });
  });

  vscode.postMessage({ type: "ready" });
})();
