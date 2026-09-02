(function (CSW) {
  CSW.onDocumentClick = function (ev) {
    var t = ev.target;
    var el = t && t.nodeType === 1 ? t : t && t.parentElement;
    var tabBtn = el && el.closest ? el.closest(".tab-btn[data-tab]") : null;
    if (tabBtn) {
      CSW.switchTab(tabBtn.getAttribute("data-tab"));
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
        CSW.groupedChatsState.openingConversationId = actionConversationId;
        CSW.renderGroupedChats();
      }
      CSW.post(actionCmd, actionExtra);
      return;
    }
    var cmdBtn = el && el.closest ? el.closest("[data-command]") : null;
    if (!cmdBtn) return;
    if (cmdBtn.disabled) return;
    var cmd = cmdBtn.getAttribute("data-command");
    if (!cmd) return;
    if (CSW.SYNC_ACTION_COMMANDS[cmd]) {
      CSW.setSyncActionsLocked(true);
    }
    var extra = {};
    var conversationId = cmdBtn.getAttribute("data-conversation-id");
    if (conversationId) extra.conversationId = conversationId;
    var workspaceKey = cmdBtn.getAttribute("data-workspace-key");
    if (workspaceKey) extra.workspaceKey = workspaceKey;
    var projectKey = cmdBtn.getAttribute("data-project-key");
    if (projectKey) extra.projectKey = projectKey;
    var relativeSyncKey = cmdBtn.getAttribute("data-relative-sync-key");
    if (relativeSyncKey) extra.relativeSyncKey = relativeSyncKey;
    var resolution = cmdBtn.getAttribute("data-resolution");
    if (resolution) extra.resolution = resolution;
    var bundlePath = cmdBtn.getAttribute("data-bundle-path");
    if (bundlePath) extra.bundlePath = bundlePath;
    var timestamp = cmdBtn.getAttribute("data-timestamp");
    if (timestamp) extra.timestamp = timestamp;
    if (cmd === "chats:toggleGroup" && projectKey) {
      var currently = CSW.isGroupExpanded(projectKey);
      if (!currently) {
        CSW.groupedChatsState.expanded = {};
      }
      CSW.groupedChatsState.expanded[projectKey] = !currently;
      if (!currently) {
        var group = CSW.groupedChatsState.groups.find(function (g) {
          return g.projectKey === projectKey;
        });
        if (
          group &&
          (!group.rows || group.rows.length === 0) &&
          (group.conversationCount || 0) > 0
        ) {
          CSW.groupedChatsState.loadingGroups[projectKey] = true;
          CSW.renderGroupedChats();
          CSW.post("chats:loadGroup", { projectKey: projectKey });
          return;
        }
      }
      CSW.renderGroupedChats();
      return;
    }
    if (cmd === "chats:groupPrev" && projectKey) {
      CSW.groupedChatsState.pageByGroup[projectKey] =
        (CSW.groupedChatsState.pageByGroup[projectKey] || 0) - 1;
      CSW.renderGroupedChats();
      return;
    }
    if (cmd === "chats:groupNext" && projectKey) {
      CSW.groupedChatsState.pageByGroup[projectKey] =
        (CSW.groupedChatsState.pageByGroup[projectKey] || 0) + 1;
      CSW.renderGroupedChats();
      return;
    }
    if (cmd === "history:prev" || cmd === "history:next") {
      var pager = document.querySelector(".history-pager");
      var list = document.querySelector(".history-list");
      var currentPage = 0;
      if (pager && pager.getAttribute("data-history-page")) {
        currentPage = Number(pager.getAttribute("data-history-page")) || 0;
      } else if (list && list.getAttribute("data-history-page")) {
        currentPage = Number(list.getAttribute("data-history-page")) || 0;
      }
      var nextPage = cmd === "history:next" ? currentPage + 1 : currentPage - 1;
      CSW.post("history:page", { page: nextPage });
      return;
    }
    if (cmd === "configure") {
      function settingValue(id) {
        var input = document.getElementById(id);
        if (!input) return undefined;
        if (input.type === "checkbox") return input.checked;
        if (input.tagName === "SELECT") return input.value;
        return input.value;
      }
      extra.destination = {
        type: settingValue("destination.type"),
        repo: settingValue("destination.repo"),
        branch: settingValue("destination.branch"),
        path: settingValue("destination.path"),
      };
    }
    CSW.post(cmd, extra);
  };

  CSW.onDocumentChange = function (ev) {
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
    if (key === "destination.type") {
      var repoFields = document.getElementById("destination-repo-fields");
      if (repoFields) {
        repoFields.style.display = value === "repo" ? "" : "none";
      }
      var connectBtnLive = document.querySelector(
        ".settings-connect-btn[data-command='configure']"
      );
      if (connectBtnLive) {
        connectBtnLive.innerHTML =
          '<span class="codicon codicon-github-alt"></span> ' +
          (value === "repo"
            ? CSW.tr("connectRepository", "Connect repository")
            : CSW.tr("connectGithub", "Connect GitHub"));
      }
    }
    CSW.onSettingChange(key, value);
  };

  CSW.onWindowMessage = function (ev) {
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
        var conflictCount = document.querySelectorAll(".conflict-row").length;
        var syncTab = document.querySelector('.tab-btn[data-tab="sync-pane"]');
        if (syncTab) {
          var label = CSW.tr("tabSync", "Sync");
          syncTab.innerHTML = conflictCount
            ? label + ' <span class="tab-badge">' + conflictCount + "</span>"
            : label;
        }
        CSW.setSyncActionsLocked(CSW.syncActionsLocked);
      }
      return;
    }

    if (msg.type === "sync:progress") {
      CSW.handleSyncProgressMessage(msg);
      return;
    }

    if (msg.type === "history:update") {
      var historyBody = document.getElementById("history-section-body");
      if (historyBody && msg.html) {
        historyBody.innerHTML = msg.html;
      }
      return;
    }

    if (msg.type === "chats:grouped") {
      CSW.handleChatsGroupedMessage(msg);
    }

    if (msg.type === "chats:groupRows") {
      CSW.handleChatsGroupRowsMessage(msg);
    }

    if (msg.type === "chats:openComplete") {
      CSW.handleChatsOpenCompleteMessage(msg);
    }

    if (msg.type === "chats:imports") {
      CSW.handleChatsImportsMessage(msg);
    }

    if (msg.type === "chats:bundles") {
      CSW.handleChatsBundlesMessage(msg);
    }

    if (msg.type === "chats:progress") {
      CSW.handleChatsProgressMessage(msg);
    }

    if (msg.type === "chats:history-cleared") {
      CSW.handleChatsHistoryClearedMessage();
    }

    if (msg.type === "settings:error") {
      var errText = msg.message ? String(msg.message) : CSW.tr("invalidSetting", "Invalid setting");
      if (typeof console !== "undefined" && console.warn) {
        console.warn("[cursor-sync settings]", errText);
      }
      return;
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
      var repoFields2 = document.getElementById("destination-repo-fields");
      if (repoFields2 && vals["destination.type"]) {
        repoFields2.style.display =
          vals["destination.type"] === "repo" ? "" : "none";
      }
      var connectBtn = document.querySelector(
        ".settings-connect-btn[data-command='configure']"
      );
      if (connectBtn && vals["destination.type"]) {
        var isRepo = vals["destination.type"] === "repo";
        connectBtn.innerHTML =
          '<span class="codicon codicon-github-alt"></span> ' +
          (isRepo
            ? CSW.tr("connectRepository", "Connect repository")
            : CSW.tr("connectGithub", "Connect GitHub"));
      }
    }
  };
})(globalThis.CursorSyncSidebar = globalThis.CursorSyncSidebar || {});
