(function (CSW) {
  CSW.groupedChatsState = {
    groups: [],
    expanded: {},
    pageByGroup: {},
    loadingGroups: {},
    openingConversationId: null,
    pageSize: 10,
  };

  CSW.isGroupExpanded = function (projectKey) {
    return Boolean(CSW.groupedChatsState.expanded[projectKey]);
  };

  CSW.rowShowsFilesButton = function (r) {
    return (r.jsonlCount || 0) > 0 || Boolean(r.hasStore);
  };

  CSW.tierBadgeClass = function (tier) {
    if (tier === "full") return "chat-tier-full";
    if (tier === "resume") return "chat-tier-resume";
    if (tier === "partial") return "chat-tier-partial";
    return "chat-tier-archive";
  };

  CSW.renderChatRow = function (r, groupProjectKey) {
    var wsAttr = r.workspaceKey
      ? ' data-workspace-key="' + CSW.escHtml(r.workspaceKey) + '"'
      : "";
    var projKey = r.projectKey || groupProjectKey || "";
    var projAttr = projKey
      ? ' data-project-key="' + CSW.escHtml(projKey) + '"'
      : "";
    var isOpening = CSW.groupedChatsState.openingConversationId === r.conversationId;
    var openBtnClass = "chat-action-btn" + (isOpening ? " is-loading" : "");
    var openDisabled = isOpening ? " disabled" : "";
    var openLabel = isOpening ? CSW.tr("opening", "Opening\u2026") : CSW.tr("open", "Open");
    var tierAttr = r.backupTier
      ? ' data-backup-tier="' + CSW.escHtml(r.backupTier) + '"'
      : "";
    return (
      '<div class="chat-row">' +
      '<div class="chat-row-info">' +
      '<div class="chat-row-title">' +
      CSW.escHtml(r.label || r.conversationId) +
      (r.backupTierLabel
        ? '<span class="chat-tier-badge ' +
          CSW.tierBadgeClass(r.backupTier) +
          '">' +
          CSW.escHtml(r.backupTierLabel) +
          "</span>"
        : "") +
      "</div>" +
      '<div class="chat-row-meta" title="' +
      CSW.escHtml((r.fidelityWarnings || []).join(" ")) +
      '">' +
      CSW.escHtml(r.detail || "") +
      "</div>" +
      "</div>" +
      '<div class="chat-row-actions">' +
      '<button type="button" class="' +
      openBtnClass +
      '" data-command="chats:open" data-conversation-id="' +
      CSW.escHtml(r.conversationId) +
      '"' +
      wsAttr +
      projAttr +
      tierAttr +
      openDisabled +
      ' title="' +
      CSW.escHtml(CSW.tr("openChatHint", "Open this conversation in Composer")) +
      '">' +
      openLabel +
      "</button>" +
      (CSW.rowShowsFilesButton(r)
        ? '<button type="button" class="chat-action-btn" data-command="chats:revealFiles" data-conversation-id="' +
          CSW.escHtml(r.conversationId) +
          '"' +
          wsAttr +
          projAttr +
          ' title="' +
          CSW.escHtml(CSW.tr("revealFilesHint", "Reveal transcript and store files in the explorer")) +
          '">' +
          CSW.escHtml(CSW.tr("files", "Files")) +
          "</button>"
        : "") +
      "</div>" +
      "</div>"
    );
  };

  CSW.renderGroupedChats = function () {
    var el = document.getElementById("chats-grouped");
    if (!el) return;
    var groups = CSW.groupedChatsState.groups || [];
    if (groups.length === 0) {
      el.innerHTML = '<div class="empty-state">' + CSW.escHtml(CSW.tr("noLocalChats", "No local chats found")) + '</div>';
      return;
    }
    var htmlParts = groups
      .map(function (g) {
        var expanded = CSW.isGroupExpanded(g.projectKey);
        var page = CSW.groupedChatsState.pageByGroup[g.projectKey] || 0;
        var rows = g.rows || [];
        var pageSize = CSW.groupedChatsState.pageSize;
        var totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
        if (page >= totalPages) page = totalPages - 1;
        if (page < 0) page = 0;
        CSW.groupedChatsState.pageByGroup[g.projectKey] = page;
        var start = page * pageSize;
        var pageRows = rows.slice(start, start + pageSize);
        var currentClass = g.isCurrentWorkspace ? " current" : "";
        var bodyClass = expanded ? "chat-group-body" : "chat-group-body collapsed";
        var chevron = expanded ? "\u25BE" : "\u25B8";
        var groupLabel = g.label || g.projectKey || CSW.tr("unknownProject", "Unknown project");
        var labelLine = groupLabel;
        if (g.pathHint && g.pathHint !== groupLabel) {
          labelLine = groupLabel + " \u00b7 " + g.pathHint;
        }
        var isLoading = Boolean(CSW.groupedChatsState.loadingGroups[g.projectKey]);
        var rowsHtml = isLoading
          ? '<div class="chat-group-loading">' + CSW.escHtml(CSW.tr("loading", "Loading…")) + '</div>'
          : pageRows.map(function (r) {
              return CSW.renderChatRow(r, g.projectKey);
            }).join("");
        if (!isLoading && expanded && rows.length === 0 && (g.conversationCount || 0) > 0) {
          rowsHtml =
            '<div class="empty-state">' +
            CSW.escHtml(CSW.tr("groupLoadEmpty", "No chats could be loaded for this project.")) +
            "</div>";
        }
        var pagerHtml =
          rows.length > pageSize
            ? '<div class="chat-group-pager">' +
              '<div class="chats-pager">' +
              '<button type="button" class="pager-btn" data-command="chats:groupPrev" data-project-key="' +
              CSW.escHtml(g.projectKey) +
              '" title="' +
              CSW.escHtml(CSW.tr("prevHint", "Previous page")) +
              '"' +
              (page <= 0 ? " disabled" : "") +
              ">" +
              CSW.escHtml(CSW.tr("prev", "Prev")) +
              "</button>" +
              '<span class="pager-label">' +
              (page + 1) +
              " / " +
              totalPages +
              "</span>" +
              '<button type="button" class="pager-btn" data-command="chats:groupNext" data-project-key="' +
              CSW.escHtml(g.projectKey) +
              '" title="' +
              CSW.escHtml(CSW.tr("nextHint", "Next page")) +
              '"' +
              (page >= totalPages - 1 ? " disabled" : "") +
              ">" +
              CSW.escHtml(CSW.tr("next", "Next")) +
              "</button>" +
              "</div></div>"
            : "";
        return (
          '<div class="chat-group" data-project-key="' +
          CSW.escHtml(g.projectKey) +
          '">' +
          '<div class="chat-group-header' +
          currentClass +
          '" data-command="chats:toggleGroup" data-project-key="' +
          CSW.escHtml(g.projectKey) +
          '" title="' +
          CSW.escHtml(labelLine) +
          '">' +
          '<span class="chat-group-chevron" aria-hidden="true">' +
          chevron +
          "</span>" +
          '<span class="chat-group-label">' +
          CSW.escHtml(labelLine) +
          "</span>" +
          '<span class="chat-group-count">' +
          CSW.escHtml(CSW.formatChatsCount(g.conversationCount || rows.length)) +
          "</span>" +
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
  };

  CSW.handleChatsGroupedMessage = function (msg) {
    CSW.groupedChatsState.groups = msg.groups || [];
    CSW.groupedChatsState.pageByGroup = {};
    CSW.groupedChatsState.loadingGroups = {};
    CSW.renderGroupedChats();
  };

  CSW.handleChatsGroupRowsMessage = function (msg) {
    var pk = msg.projectKey;
    if (pk) {
      var target = CSW.groupedChatsState.groups.find(function (g) {
        return g.projectKey === pk;
      });
      if (target) {
        target.rows = msg.rows || [];
      }
      delete CSW.groupedChatsState.loadingGroups[pk];
      CSW.renderGroupedChats();
    }
  };

  CSW.handleChatsOpenCompleteMessage = function (msg) {
    if (
      msg.conversationId &&
      CSW.groupedChatsState.openingConversationId === msg.conversationId
    ) {
      CSW.groupedChatsState.openingConversationId = null;
      CSW.renderGroupedChats();
    }
  };

  CSW.handleChatsImportsMessage = function (msg) {
    var el2 = document.getElementById("chats-imports");
    if (!el2) return;
    if (!msg.rows || msg.rows.length === 0) {
      el2.innerHTML = '<div class="empty-state">' + CSW.escHtml(CSW.tr("noImportHistory", "No import history")) + '</div>';
      return;
    }
    el2.innerHTML = msg.rows
      .map(function (r) {
        var warnings =
          r.warnings > 0
            ? " \u00b7 " + CSW.tr("warnCount", "{n} warn", { n: r.warnings })
            : "";
        var fidelity =
          typeof r.schemaVersion === "number"
            ? " \u00b7 v" + r.schemaVersion
            : "";
        var tools =
          typeof r.toolBubbleCount === "number"
            ? " \u00b7 " + CSW.tr("toolBubblesCount", "{n} tool bubbles", { n: r.toolBubbleCount })
            : "";
        var layer4 = r.textOnlyLayer4
          ? ' <span class="fidelity-warn">' + CSW.escHtml(CSW.tr("textOnlyL4Badge", "text-only L4")) + "</span>"
          : "";
        return (
          '<div class="chat-row">' +
          '<div class="chat-row-info">' +
          '<div class="chat-row-title">' +
          CSW.escHtml(r.conversationId) +
          "</div>" +
          '<div class="chat-row-meta">' +
          CSW.relTime(r.timestamp) +
          " \u00b7 " +
          CSW.tr("transcriptsWritten", "{n} transcripts", { n: r.transcriptsWritten }) +
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
  };

  CSW.handleChatsBundlesMessage = function (msg) {
    var el3 = document.getElementById("chats-bundles");
    if (!el3) return;
    if (!msg.entries || msg.entries.length === 0) {
      el3.innerHTML = '<div class="empty-state">' + CSW.escHtml(CSW.tr("noBundleFiles", "No bundle files found")) + '</div>';
      return;
    }
    el3.innerHTML = msg.entries
      .map(function (e) {
        var name = e.bundlePath.split("/").pop() || e.bundlePath;
        return (
          '<div class="chat-row">' +
          '<div class="chat-row-info">' +
          '<div class="chat-row-title">' +
          CSW.escHtml(name) +
          "</div>" +
          '<div class="chat-row-meta">' +
          CSW.fmtBytes(e.bytes) +
          " \u00b7 " +
          CSW.relTime(e.modifiedAt) +
          " \u00b7 " +
          e.source +
          "</div>" +
          "</div>" +
          '<div class="chat-row-actions">' +
          '<button class="chat-action-btn" data-command="chats:importBundle" data-bundle-path="' +
          CSW.escHtml(e.bundlePath) +
          '" title="' +
          CSW.escHtml(CSW.tr("importBundleHint", "Import this chat bundle file into the current workspace")) +
          '">' +
          CSW.escHtml(CSW.tr("import", "Import")) +
          "</button>" +
          "</div>" +
          "</div>"
        );
      })
      .join("");
  };

  CSW.handleChatsHistoryClearedMessage = function () {
    var el5 = document.getElementById("chats-imports");
    if (el5) el5.innerHTML = '<div class="empty-state">' + CSW.escHtml(CSW.tr("noImportHistory", "No import history")) + '</div>';
  };
})(globalThis.CursorSyncSidebar = globalThis.CursorSyncSidebar || {});
