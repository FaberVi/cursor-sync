(function (CSW) {
  CSW.syncFillWidthPct = function (pct) {
    return Math.min(100, Math.max(4, pct));
  };

  CSW.setFillWidth = function (fill, pct, clampMin) {
    if (!fill) return;
    var width =
      (clampMin ? CSW.syncFillWidthPct(pct) : Math.min(100, Math.max(0, pct))) + "%";
    if (fill.style.width !== width) {
      fill.style.width = width;
    }
  };

  CSW.ensureSyncProgressCard = function (el, pct) {
    var card = el.querySelector(".progress-card");
    if (card) return card;
    el.innerHTML =
      '<div class="progress-card">' +
      '<div class="progress-phase-row">' +
      '<div class="progress-phase"></div>' +
      '<button type="button" class="progress-stop-btn" data-command="sync:cancel" title="' +
      CSW.escHtml(CSW.tr("stopSyncHint", "Cancel this run and restore local files changed during the in-flight sync")) +
      '">' +
      CSW.escHtml(CSW.tr("stopSync", "Stop")) +
      "</button></div>" +
      '<div class="progress-message"><span class="progress-message-text"></span><span class="progress-elapsed"></span></div>' +
      '<div class="progress-bar-track"><div class="progress-bar-fill" style="width:' +
      CSW.syncFillWidthPct(pct) +
      '%"></div></div>' +
      "</div>";
    return el.querySelector(".progress-card");
  };

  CSW.ensureChatsProgressCard = function (el) {
    var card = el.querySelector(".progress-card");
    if (card) return card;
    el.innerHTML =
      '<div class="progress-card">' +
      '<div class="progress-phase"></div>' +
      '<div class="progress-message"></div>' +
      "</div>";
    return el.querySelector(".progress-card");
  };

  CSW.ensureChatsProgressFill = function (card, pct) {
    var fill = card.querySelector(".progress-bar-fill");
    if (fill) {
      CSW.setFillWidth(fill, pct, false);
      return;
    }
    if (!(pct > 0)) return;
    var track = document.createElement("div");
    track.className = "progress-bar-track";
    fill = document.createElement("div");
    fill.className = "progress-bar-fill";
    fill.style.width = Math.min(100, pct) + "%";
    track.appendChild(fill);
    card.appendChild(track);
  };

  CSW.handleSyncProgressMessage = function (msg) {
    var syncSection = document.getElementById("sync-active-section");
    var syncEl = document.getElementById("sync-active");
    if (!syncSection || !syncEl) return;
    var sev = msg.event || {};
    if (sev.busy === false || sev.done) {
      CSW.setSyncActionsLocked(false);
    } else {
      CSW.setSyncActionsLocked(true);
    }
    if (sev.done) {
      syncSection.style.display = "none";
      syncEl.innerHTML = "";
      return;
    }
    syncSection.style.display = "";
    var opLabel =
      sev.operation === "pull"
        ? CSW.tr("pull", "Pull")
        : sev.operation === "syncNow"
          ? CSW.tr("syncNow", "Sync Now")
          : CSW.tr("push", "Push");
    var spct = typeof sev.percent === "number" ? sev.percent : 0;
    var syncCard = CSW.ensureSyncProgressCard(syncEl, spct);
    if (!syncCard) return;
    CSW.setElText(syncCard.querySelector(".progress-phase"), opLabel);
    CSW.setElText(
      syncCard.querySelector(".progress-message-text"),
      sev.message || ""
    );
    var elapsedEl = syncCard.querySelector(".progress-elapsed");
    if (elapsedEl) {
      var elapsedLabel = sev.elapsedLabel || "";
      CSW.setElText(elapsedEl, elapsedLabel);
      elapsedEl.style.display = elapsedLabel ? "" : "none";
    }
    CSW.setFillWidth(syncCard.querySelector(".progress-bar-fill"), spct, true);
  };

  CSW.handleChatsProgressMessage = function (msg) {
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
          CSW.tr(
            "textOnlyL4Detail",
            "text-only Layer 4 (no diskKvSnapshot); tool/MCP UI may not match source"
          );
      }
      var chatsCard = CSW.ensureChatsProgressCard(el4);
      if (!chatsCard) return;
      if (ev2.fidelity && ev2.fidelity.textOnlyLayer4) {
        chatsCard.classList.add("fidelity-warn");
      } else {
        chatsCard.classList.remove("fidelity-warn");
      }
      var phaseText = CSW.tr("phasePrefix", "Phase {phase}", { phase: ev2.phase || "" });
      if (stepLabel) {
        phaseText += " \u00b7 " + stepLabel;
      }
      CSW.setElText(chatsCard.querySelector(".progress-phase"), phaseText);
      CSW.setElText(chatsCard.querySelector(".progress-message"), detail);
      CSW.ensureChatsProgressFill(chatsCard, pct);
    }
  };
})(globalThis.CursorSyncSidebar = globalThis.CursorSyncSidebar || {});
