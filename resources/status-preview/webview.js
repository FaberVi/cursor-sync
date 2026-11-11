(function () {
  var vscode = acquireVsCodeApi();

  function readCollapsedSet() {
    var state = vscode.getState();
    var list =
      state && Array.isArray(state.collapsedPrefixes) ? state.collapsedPrefixes : [];
    return new Set(list);
  }

  function persistCollapsedSet(set) {
    var prev = vscode.getState() || {};
    vscode.setState(Object.assign({}, prev, { collapsedPrefixes: Array.from(set) }));
  }

  function restoreCollapsedFolders() {
    var collapsed = readCollapsedSet();
    document.querySelectorAll(".preview-folder[data-prefix]").forEach(function (folder) {
      var prefix = folder.getAttribute("data-prefix");
      if (!prefix || !collapsed.has(prefix)) {
        return;
      }
      folder.classList.add("is-collapsed");
      var toggle = folder.querySelector(".folder-toggle");
      if (toggle) {
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

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
    restoreCollapsedFolders();
  }

  window.addEventListener("message", function (ev) {
    var msg = ev.data;
    if (!msg || msg.type !== "render") return;
    applyRender(msg);
  });

  function elementFromEvent(ev) {
    var target = ev.target;
    return target && target.nodeType === 1 ? target : target && target.parentElement;
  }

  function syncKeyFromEvent(ev) {
    var el = elementFromEvent(ev);
    var row = el && el.closest ? el.closest("[data-sync-key]") : null;
    return row ? row.getAttribute("data-sync-key") : null;
  }

  function toggleFromEvent(ev) {
    var el = elementFromEvent(ev);
    return el && el.closest ? el.closest(".folder-toggle") : null;
  }

  function toggleFolder(toggle, ev) {
    var folder = toggle.closest ? toggle.closest(".preview-folder[data-prefix]") : null;
    if (!folder) return;
    var prefix = folder.getAttribute("data-prefix");
    if (!prefix) return;
    ev.preventDefault();
    ev.stopPropagation();
    var collapsed = folder.classList.toggle("is-collapsed");
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    var set = readCollapsedSet();
    if (collapsed) {
      set.add(prefix);
    } else {
      set.delete(prefix);
    }
    persistCollapsedSet(set);
  }

  document.addEventListener("click", function (ev) {
    var toggle = toggleFromEvent(ev);
    if (toggle) {
      toggleFolder(toggle, ev);
      return;
    }
    var el = elementFromEvent(ev);
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
    if (toggleFromEvent(ev)) return;
    var syncKey = syncKeyFromEvent(ev);
    if (!syncKey) return;
    ev.preventDefault();
    vscode.postMessage({ type: "open", syncKey: syncKey });
  });

  restoreCollapsedFolders();
  vscode.postMessage({ type: "ready" });
})();
