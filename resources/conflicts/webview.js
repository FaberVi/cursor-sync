(function () {
  const vscode = acquireVsCodeApi();

  function saveListScroll() {
    const list = document.getElementById("conflict-list");
    const prev = vscode.getState() || {};
    vscode.setState({
      ...prev,
      listScrollTop: list ? list.scrollTop : 0,
    });
  }

  function readCollapsedSet() {
    const state = vscode.getState();
    const list =
      state && Array.isArray(state.collapsedPrefixes)
        ? state.collapsedPrefixes
        : [];
    return new Set(list);
  }

  function persistCollapsedSet(set) {
    const prev = vscode.getState() || {};
    vscode.setState({
      ...prev,
      collapsedPrefixes: [...set],
    });
  }

  function restoreListScroll() {
    const state = vscode.getState();
    const top =
      state && typeof state.listScrollTop === "number"
        ? state.listScrollTop
        : null;
    if (top === null) {
      return;
    }
    const apply = () => {
      const list = document.getElementById("conflict-list");
      if (list) {
        list.scrollTop = top;
      }
    };
    apply();
    requestAnimationFrame(() => {
      apply();
      requestAnimationFrame(apply);
    });
  }

  function restoreCollapsedFolders() {
    const collapsed = readCollapsedSet();
    document.querySelectorAll(".conflict-folder[data-prefix]").forEach((folder) => {
      const prefix = folder.getAttribute("data-prefix");
      if (!prefix || !collapsed.has(prefix)) {
        return;
      }
      folder.classList.add("is-collapsed");
      const toggle = folder.querySelector(".folder-toggle");
      if (toggle) {
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  restoreListScroll();
  restoreCollapsedFolders();

  function postAfterSavingScroll(payload) {
    saveListScroll();
    vscode.postMessage(payload);
  }

  document.getElementById("conflict-list")?.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const t = ev.target;
    const el = t && t.nodeType === 1 ? t : t && t.parentElement;
    const row = el && el.closest ? el.closest(".conflict-row[data-key]") : null;
    if (!row || (el && el.closest && el.closest(".pick"))) return;
    const key = row.getAttribute("data-key");
    if (!key) return;
    ev.preventDefault();
    postAfterSavingScroll({ type: "select", key: key });
  });

  document.getElementById("conflict-list")?.addEventListener("click", (ev) => {
    const t = ev.target;
    const el = t && t.nodeType === 1 ? t : t && t.parentElement;

    const toggle = el && el.closest ? el.closest(".folder-toggle") : null;
    if (toggle) {
      const folder =
        toggle.closest && toggle.closest(".conflict-folder[data-prefix]");
      if (folder) {
        const prefix = folder.getAttribute("data-prefix");
        const isCollapsed = folder.classList.toggle("is-collapsed");
        toggle.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
        if (prefix) {
          const set = readCollapsedSet();
          if (isCollapsed) {
            set.add(prefix);
          } else {
            set.delete(prefix);
          }
          persistCollapsedSet(set);
        }
      }
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }

    const folderPick =
      el && el.closest
        ? el.closest(".conflict-folder-head .pick[data-side]")
        : null;
    if (folderPick) {
      const folder =
        folderPick.closest &&
        folderPick.closest(".conflict-folder[data-prefix]");
      const prefix = folder ? folder.getAttribute("data-prefix") : null;
      if (prefix) {
        const side = folderPick.getAttribute("data-side") || "local";
        postAfterSavingScroll({
          type: "chooseFolder",
          prefix: prefix,
          side: side,
        });
        ev.preventDefault();
        ev.stopPropagation();
      }
      return;
    }

    const row = el && el.closest ? el.closest(".conflict-row[data-key]") : null;
    if (!row) return;
    const key = row.getAttribute("data-key");
    if (!key) return;
    const pick = el && el.closest ? el.closest(".pick[data-side]") : null;
    if (pick) {
      const side = pick.getAttribute("data-side") || "local";
      postAfterSavingScroll({ type: "choose", key: key, side: side });
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    postAfterSavingScroll({ type: "select", key: key });
  });

  document.getElementById("keep-all-local")?.addEventListener("click", () => {
    postAfterSavingScroll({ type: "keepAll", side: "local" });
  });
  document.getElementById("keep-all-remote")?.addEventListener("click", () => {
    postAfterSavingScroll({ type: "keepAll", side: "remote" });
  });
  document.getElementById("apply")?.addEventListener("click", () => {
    vscode.postMessage({ type: "apply" });
  });
  document.getElementById("cancel-sync")?.addEventListener("click", () => {
    vscode.postMessage({ type: "cancel" });
  });
})();
