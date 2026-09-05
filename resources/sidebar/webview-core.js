(function (CSW) {
  CSW.vscode = acquireVsCodeApi();

  function readI18n() {
    var el = document.getElementById("ui-i18n");
    if (!el || !el.textContent) return {};
    try {
      return JSON.parse(el.textContent);
    } catch (e) {
      return {};
    }
  }

  CSW.i18n = readI18n();

  CSW.tr = function (key, fallback, vars) {
    var text = CSW.i18n[key] || fallback || key;
    if (vars) {
      Object.keys(vars).forEach(function (name) {
        text = text.replace(new RegExp("\\{" + name + "\\}", "g"), String(vars[name]));
      });
    }
    return text;
  };

  CSW.formatChatsCount = function (n) {
    return CSW.tr("chatsCount", "{n} chats").replace("{n}", String(n));
  };

  CSW.post = function (command, extra) {
    CSW.vscode.postMessage(Object.assign({ command: command }, extra || {}));
  };

  CSW.syncActionsLocked = false;
  CSW.SYNC_ACTION_COMMANDS = {
    syncNow: true,
    push: true,
    pull: true,
    resetToRemote: true,
  };

  CSW.setSyncActionsLocked = function (locked) {
    CSW.syncActionsLocked = Boolean(locked);
    var selectors = [
      '.sync-now-btn[data-command="syncNow"]',
      '.action-btn[data-command="push"]',
      '.action-btn[data-command="pull"]',
      '.action-btn[data-command="resetToRemote"]',
    ];
    selectors.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (btn) {
        btn.disabled = CSW.syncActionsLocked;
        if (CSW.syncActionsLocked) {
          btn.setAttribute("aria-busy", "true");
        } else {
          btn.removeAttribute("aria-busy");
        }
      });
    });
  };

  CSW.onSettingChange = function (key, value) {
    CSW.post("settings:set", { key: key, value: value });
  };

  CSW.switchTab = function (tabId) {
    document.querySelectorAll(".tab-pane").forEach(function (p) {
      p.style.display = "none";
    });
    document.querySelectorAll(".tab-btn").forEach(function (b) {
      b.classList.remove("active");
    });
    var pane = document.getElementById(tabId);
    if (pane) pane.style.display = "";
    document
      .querySelectorAll('.tab-btn[data-tab="' + tabId + '"]')
      .forEach(function (b) {
        b.classList.add("active");
      });
    if (tabId === "chats-pane") {
      CSW.post("chats:listLocal");
      CSW.post("chats:listImports");
      CSW.post("chats:listBundles");
    } else if (tabId === "settings-pane") {
      CSW.post("settings:get");
    }
  };

  CSW.escHtml = function (s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  };

  CSW.setElText = function (el, text) {
    if (!el) return;
    var next = text == null ? "" : String(text);
    if (el.textContent !== next) {
      el.textContent = next;
    }
  };

  CSW.relTime = function (iso) {
    var diffMs = Date.now() - new Date(iso).getTime();
    if (diffMs < 0) return CSW.tr("timeJustNow", "just now");
    var s = Math.floor(diffMs / 1000);
    if (s < 60) return CSW.tr("timeJustNow", "just now");
    var m = Math.floor(s / 60);
    if (m < 60) return CSW.tr("timeMinutesAgo", "{n}m ago", { n: m });
    var h = Math.floor(m / 60);
    if (h < 24) return CSW.tr("timeHoursAgo", "{n}h ago", { n: h });
    var d = Math.floor(h / 24);
    if (d < 30) return CSW.tr("timeDaysAgo", "{n}d ago", { n: d });
    return new Date(iso).toLocaleDateString();
  };

  CSW.fmtBytes = function (b) {
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return Math.round(b / 1024) + " KB";
    return (b / (1024 * 1024)).toFixed(1) + " MB";
  };
})(globalThis.CursorSyncSidebar = globalThis.CursorSyncSidebar || {});
