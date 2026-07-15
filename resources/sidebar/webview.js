(function () {
  const vscode = acquireVsCodeApi();

  function post(command, extra) {
    vscode.postMessage(Object.assign({ command: command }, extra || {}));
  }

  function onSettingChange(key, value) {
    post("settings:set", { key: key, value: value });
  }

  function switchTab(tabId) {
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
      post("chats:listLocal");
      post("chats:listImports");
      post("chats:listBundles");
    } else if (tabId === "settings-pane") {
      post("settings:get");
    }
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function relTime(iso) {
    var diffMs = Date.now() - new Date(iso).getTime();
    if (diffMs < 0) return "just now";
    var s = Math.floor(diffMs / 1000);
    if (s < 60) return "just now";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    var d = Math.floor(h / 24);
    if (d < 30) return d + "d ago";
    return new Date(iso).toLocaleDateString();
  }

  function fmtBytes(b) {
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return Math.round(b / 1024) + " KB";
    return (b / (1024 * 1024)).toFixed(1) + " MB";
  }

  var groupedChatsState = {
    groups: [],
    expanded: {},
    pageByGroup: {},
    loadingGroups: {},
    openingConversationId: null,
    pageSize: 10,
  };

  function isGroupExpanded(projectKey) {
    return Boolean(groupedChatsState.expanded[projectKey]);
  }

  function rowShowsFilesButton(r) {
    return (r.jsonlCount || 0) > 0 || Boolean(r.hasStore);
  }

  function tierBadgeClass(tier) {
    if (tier === "full") return "chat-tier-full";
    if (tier === "resume") return "chat-tier-resume";
    if (tier === "partial") return "chat-tier-partial";
    return "chat-tier-archive";
  }

  function renderChatRow(r, groupProjectKey) {
    var wsAttr = r.workspaceKey
      ? ' data-workspace-key="' + escHtml(r.workspaceKey) + '"'
      : "";
    var projKey = r.projectKey || groupProjectKey || "";
    var projAttr = projKey
      ? ' data-project-key="' + escHtml(projKey) + '"'
      : "";
    var isOpening = groupedChatsState.openingConversationId === r.conversationId;
    var openBtnClass = "chat-action-btn" + (isOpening ? " is-loading" : "");
    var openDisabled = isOpening ? " disabled" : "";
    var openLabel = isOpening ? "Opening\u2026" : "Open";
    var tierAttr = r.backupTier
      ? ' data-backup-tier="' + escHtml(r.backupTier) + '"'
      : "";
    return (
      '<div class="chat-row">' +
      '<div class="chat-row-info">' +
      '<div class="chat-row-title">' +
      escHtml(r.label || r.conversationId) +
      (r.backupTierLabel
        ? '<span class="chat-tier-badge ' +
          tierBadgeClass(r.backupTier) +
          '">' +
          escHtml(r.backupTierLabel) +
          "</span>"
        : "") +
      "</div>" +
      '<div class="chat-row-meta" title="' +
      escHtml((r.fidelityWarnings || []).join(" ")) +
      '">' +
      escHtml(r.detail || "") +
      "</div>" +
      "</div>" +
      '<div class="chat-row-actions">' +
      '<button type="button" class="' +
      openBtnClass +
      '" data-command="chats:open" data-conversation-id="' +
      escHtml(r.conversationId) +
      '"' +
      wsAttr +
      projAttr +
      tierAttr +
      openDisabled +
      ">" +
      openLabel +
      "</button>" +
      (rowShowsFilesButton(r)
        ? '<button type="button" class="chat-action-btn" data-command="chats:revealFiles" data-conversation-id="' +
          escHtml(r.conversationId) +
          '"' +
          wsAttr +
          projAttr +
          ">Files</button>"
        : "") +
      "</div>" +
      "</div>"
    );
  }

  function renderGroupedChats() {
    var el = document.getElementById("chats-grouped");
    if (!el) return;
    var groups = groupedChatsState.groups || [];
    if (groups.length === 0) {
      el.innerHTML = '<div class="empty-state">No local chats found</div>';
      return;
    }
    var htmlParts = groups
      .map(function (g) {
        var expanded = isGroupExpanded(g.projectKey);
        var page = groupedChatsState.pageByGroup[g.projectKey] || 0;
        var rows = g.rows || [];
        var pageSize = groupedChatsState.pageSize;
        var totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
        if (page >= totalPages) page = totalPages - 1;
        if (page < 0) page = 0;
        groupedChatsState.pageByGroup[g.projectKey] = page;
        var start = page * pageSize;
        var pageRows = rows.slice(start, start + pageSize);
        var currentClass = g.isCurrentWorkspace ? " current" : "";
        var bodyClass = expanded ? "chat-group-body" : "chat-group-body collapsed";
        var chevron = expanded ? "\u25BE" : "\u25B8";
        var groupLabel = g.label || g.projectKey || "Unknown project";
        var labelLine = groupLabel;
        if (g.pathHint && g.pathHint !== groupLabel) {
          labelLine = groupLabel + " \u00b7 " + g.pathHint;
        }
        var isLoading = Boolean(groupedChatsState.loadingGroups[g.projectKey]);
        var rowsHtml = isLoading
          ? '<div class="chat-group-loading">Loading chats\u2026</div>'
          : pageRows.map(function (r) {
              return renderChatRow(r, g.projectKey);
            }).join("");
        if (!isLoading && expanded && rows.length === 0 && (g.conversationCount || 0) > 0) {
          rowsHtml = '<div class="chat-group-loading">Loading chats\u2026</div>';
        }
        var pagerHtml =
          rows.length > pageSize
            ? '<div class="chat-group-pager">' +
              '<div class="chats-pager">' +
              '<button type="button" class="pager-btn" data-command="chats:groupPrev" data-project-key="' +
              escHtml(g.projectKey) +
              '"' +
              (page <= 0 ? " disabled" : "") +
              ">Prev</button>" +
              '<span class="pager-label">' +
              (page + 1) +
              " / " +
              totalPages +
              "</span>" +
              '<button type="button" class="pager-btn" data-command="chats:groupNext" data-project-key="' +
              escHtml(g.projectKey) +
              '"' +
              (page >= totalPages - 1 ? " disabled" : "") +
              ">Next</button>" +
              "</div></div>"
            : "";
        return (
          '<div class="chat-group" data-project-key="' +
          escHtml(g.projectKey) +
          '">' +
          '<div class="chat-group-header' +
          currentClass +
          '" data-command="chats:toggleGroup" data-project-key="' +
          escHtml(g.projectKey) +
          '" title="' +
          escHtml(labelLine) +
          '">' +
          '<span class="chat-group-chevron" aria-hidden="true">' +
          chevron +
          "</span>" +
          '<span class="chat-group-label">' +
          escHtml(labelLine) +
          "</span>" +
          '<span class="chat-group-count">' +
          (g.conversationCount || rows.length) +
          " chats</span>" +
          "</div>" +
          '<div class="' +
          bodyClass +
          '">' +
          rowsHtml +
          pagerHtml +
          "</div>" +
          "</div>"
        );
      });
    el.innerHTML = htmlParts.join("");
  }

  document.addEventListener("click", function (ev) {
    var t = ev.target;
    var el = t && t.nodeType === 1 ? t : t && t.parentElement;
    var tabBtn = el && el.closest ? el.closest(".tab-btn[data-tab]") : null;
    if (tabBtn) {
      switchTab(tabBtn.getAttribute("data-tab"));
      return;
    }
    var actionBtn =
      el && el.closest
        ? el.closest(".chat-action-btn[data-command]")
        : null;
    if (actionBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      var actionCmd = actionBtn.getAttribute("data-command");
      if (!actionCmd || actionBtn.disabled) return;
      var actionExtra = {};
      var actionConversationId = actionBtn.getAttribute("data-conversation-id");
      if (actionConversationId) actionExtra.conversationId = actionConversationId;
      var actionWorkspaceKey = actionBtn.getAttribute("data-workspace-key");
      if (actionWorkspaceKey) actionExtra.workspaceKey = actionWorkspaceKey;
      var actionProjectKey = actionBtn.getAttribute("data-project-key");
      if (actionProjectKey) actionExtra.projectKey = actionProjectKey;
      var actionBackupTier = actionBtn.getAttribute("data-backup-tier");
      if (actionBackupTier) actionExtra.backupTier = actionBackupTier;
      if (actionCmd === "chats:open" && actionConversationId) {
        groupedChatsState.openingConversationId = actionConversationId;
        renderGroupedChats();
      }
      post(actionCmd, actionExtra);
      return;
    }
    var cmdBtn = el && el.closest ? el.closest("[data-command]") : null;
    if (!cmdBtn) return;
    if (cmdBtn.disabled) return;
    var cmd = cmdBtn.getAttribute("data-command");
    if (!cmd) return;
    var extra = {};
    var conversationId = cmdBtn.getAttribute("data-conversation-id");
    if (conversationId) extra.conversationId = conversationId;
    var workspaceKey = cmdBtn.getAttribute("data-workspace-key");
    if (workspaceKey) extra.workspaceKey = workspaceKey;
    var projectKey = cmdBtn.getAttribute("data-project-key");
    if (projectKey) extra.projectKey = projectKey;
    var bundlePath = cmdBtn.getAttribute("data-bundle-path");
    if (bundlePath) extra.bundlePath = bundlePath;
    if (cmd === "chats:toggleGroup" && projectKey) {
      var currently = isGroupExpanded(projectKey);
      if (!currently) {
        groupedChatsState.expanded = {};
      }
      groupedChatsState.expanded[projectKey] = !currently;
      if (!currently) {
        var group = groupedChatsState.groups.find(function (g) {
          return g.projectKey === projectKey;
        });
        if (
          group &&
          (!group.rows || group.rows.length === 0) &&
          (group.conversationCount || 0) > 0
        ) {
          groupedChatsState.loadingGroups[projectKey] = true;
          renderGroupedChats();
          post("chats:loadGroup", { projectKey: projectKey });
          return;
        }
      }
      renderGroupedChats();
      return;
    }
    if (cmd === "chats:groupPrev" && projectKey) {
      groupedChatsState.pageByGroup[projectKey] =
        (groupedChatsState.pageByGroup[projectKey] || 0) - 1;
      renderGroupedChats();
      return;
    }
    if (cmd === "chats:groupNext" && projectKey) {
      groupedChatsState.pageByGroup[projectKey] =
        (groupedChatsState.pageByGroup[projectKey] || 0) + 1;
      renderGroupedChats();
      return;
    }
    post(cmd, extra);
  });

  document.addEventListener("change", function (ev) {
    var el = ev.target;
    if (!el || !el.getAttribute) return;
    var key = el.getAttribute("data-setting-key");
    if (!key) return;
    var value =
      el.type === "checkbox"
        ? el.checked
        : el.type === "number"
          ? Number(el.value)
          : el.value;
    onSettingChange(key, value);
  });

  window.addEventListener("message", function (ev) {
    var msg = ev.data;
    if (!msg || !msg.type) return;

    if (msg.type === "sync:update") {
      var syncPane = document.getElementById("sync-pane");
      if (syncPane && msg.html) {
        var activeBtn = document.querySelector(".tab-btn.active");
        var activeTab = activeBtn ? activeBtn.getAttribute("data-tab") : "sync-pane";
        syncPane.outerHTML = msg.html;
        if (activeTab !== "sync-pane") {
          var newSync = document.getElementById("sync-pane");
          if (newSync) newSync.style.display = "none";
        }
      }
      return;
    }

    if (msg.type === "chats:grouped") {
      groupedChatsState.groups = msg.groups || [];
      groupedChatsState.pageByGroup = {};
      groupedChatsState.loadingGroups = {};
      renderGroupedChats();
    }

    if (msg.type === "chats:groupRows") {
      var pk = msg.projectKey;
      if (pk) {
        var target = groupedChatsState.groups.find(function (g) {
          return g.projectKey === pk;
        });
        if (target) {
          target.rows = msg.rows || [];
        }
        delete groupedChatsState.loadingGroups[pk];
        renderGroupedChats();
      }
    }

    if (msg.type === "chats:openComplete") {
      if (
        msg.conversationId &&
        groupedChatsState.openingConversationId === msg.conversationId
      ) {
        groupedChatsState.openingConversationId = null;
        renderGroupedChats();
      }
    }

    if (msg.type === "chats:imports") {
      var el2 = document.getElementById("chats-imports");
      if (!el2) return;
      if (!msg.rows || msg.rows.length === 0) {
        el2.innerHTML = '<div class="empty-state">No import history</div>';
        return;
      }
      el2.innerHTML = msg.rows
        .map(function (r) {
          var warnings =
            r.warnings > 0 ? " \u00b7 " + r.warnings + " warn" : "";
          var fidelity =
            typeof r.schemaVersion === "number"
              ? " \u00b7 v" + r.schemaVersion
              : "";
          var tools =
            typeof r.toolBubbleCount === "number"
              ? " \u00b7 " + r.toolBubbleCount + " tool bubbles"
              : "";
          var layer4 = r.textOnlyLayer4
            ? ' <span class="fidelity-warn">text-only L4</span>'
            : "";
          return (
            '<div class="chat-row">' +
            '<div class="chat-row-info">' +
            '<div class="chat-row-title">' +
            escHtml(r.conversationId) +
            "</div>" +
            '<div class="chat-row-meta">' +
            relTime(r.timestamp) +
            " \u00b7 " +
            r.transcriptsWritten +
            " transcripts" +
            fidelity +
            tools +
            layer4 +
            warnings +
            "</div>" +
            "</div>" +
            "</div>"
          );
        })
        .join("");
    }

    if (msg.type === "chats:bundles") {
      var el3 = document.getElementById("chats-bundles");
      if (!el3) return;
      if (!msg.entries || msg.entries.length === 0) {
        el3.innerHTML = '<div class="empty-state">No bundle files found</div>';
        return;
      }
      el3.innerHTML = msg.entries
        .map(function (e) {
          var name = e.bundlePath.split("/").pop() || e.bundlePath;
          return (
            '<div class="chat-row">' +
            '<div class="chat-row-info">' +
            '<div class="chat-row-title">' +
            escHtml(name) +
            "</div>" +
            '<div class="chat-row-meta">' +
            fmtBytes(e.bytes) +
            " \u00b7 " +
            relTime(e.modifiedAt) +
            " \u00b7 " +
            e.source +
            "</div>" +
            "</div>" +
            '<div class="chat-row-actions">' +
            '<button class="chat-action-btn" data-command="chats:importBundle" data-bundle-path="' +
            escHtml(e.bundlePath) +
            '">Import</button>' +
            "</div>" +
            "</div>"
          );
        })
        .join("");
    }

    if (msg.type === "chats:progress") {
      var section = document.getElementById("chats-active-section");
      var el4 = document.getElementById("chats-active");
      if (!section || !el4) return;
      var ev2 = msg.event;
      if (ev2.done) {
        section.style.display = "none";
        el4.innerHTML = "";
      } else {
        section.style.display = "";
        var pct = typeof ev2.increment === "number" ? ev2.increment : 0;
        var stepLabel = ev2.step || ev2.message || "";
        var detail = ev2.detail || "";
        if (ev2.fidelity && ev2.fidelity.textOnlyLayer4) {
          detail =
            detail ||
            "text-only Layer 4 (no diskKvSnapshot); tool/MCP UI may not match source";
        }
        var warnClass =
          ev2.fidelity && ev2.fidelity.textOnlyLayer4 ? " fidelity-warn" : "";
        el4.innerHTML =
          '<div class="progress-card' +
          warnClass +
          '">' +
          '<div class="progress-phase">' +
          escHtml("Phase " + (ev2.phase || "") + (stepLabel ? " · " + stepLabel : "")) +
          "</div>" +
          '<div class="progress-message">' +
          escHtml(detail) +
          "</div>" +
          (pct > 0
            ? '<div class="progress-bar-track"><div class="progress-bar-fill" style="width:' +
              Math.min(100, pct) +
              '%"></div></div>'
            : "") +
          "</div>";
      }
    }

    if (msg.type === "chats:history-cleared") {
      var el5 = document.getElementById("chats-imports");
      if (el5) el5.innerHTML = '<div class="empty-state">No import history</div>';
    }

    if (msg.type === "settings:current") {
      var vals = msg.values;
      if (!vals) return;
      Object.keys(vals).forEach(function (key) {
        var el6 = document.getElementById(key);
        if (!el6) return;
        if (el6.type === "checkbox") el6.checked = Boolean(vals[key]);
        else el6.value = vals[key];
      });
    }
  });
})();
