(function () {
  const vscode = acquireVsCodeApi();

  document.getElementById("proceed")?.addEventListener("click", () => {
    vscode.postMessage({ type: "proceed" });
  });
  document.getElementById("cancel-sync")?.addEventListener("click", () => {
    vscode.postMessage({ type: "cancel" });
  });

  let activeFilter = null;

  function sectionFilters(section) {
    const raw = section.getAttribute("data-section-filters") || "";
    return raw.split(/\s+/).filter(Boolean);
  }

  function applyFilter() {
    const sections = document.querySelectorAll(".confirm-section[data-section-filters]");
    sections.forEach((section) => {
      if (!activeFilter) {
        section.classList.remove("is-filtered-out");
        return;
      }
      const match = sectionFilters(section).includes(activeFilter);
      section.classList.toggle("is-filtered-out", !match);
    });
    document.querySelectorAll(".confirm-chip[data-filter]").forEach((chip) => {
      const on = chip.getAttribute("data-filter") === activeFilter;
      chip.classList.toggle("is-active", on);
      chip.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function syncKeyFromEvent(ev) {
    const t = ev.target;
    const el = t && t.nodeType === 1 ? t : t && t.parentElement;
    const row = el && el.closest ? el.closest("[data-sync-key]") : null;
    return row ? row.getAttribute("data-sync-key") : null;
  }

  function postOpen(syncKey) {
    vscode.postMessage({ type: "open", syncKey });
  }

  document.addEventListener("click", (ev) => {
    const syncKey = syncKeyFromEvent(ev);
    if (!syncKey) {
      return;
    }
    ev.preventDefault();
    postOpen(syncKey);
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") {
      return;
    }
    const syncKey = syncKeyFromEvent(ev);
    if (!syncKey) {
      return;
    }
    ev.preventDefault();
    postOpen(syncKey);
  });

  document.querySelector(".confirm-chips")?.addEventListener("click", (ev) => {
    const target = ev.target;
    const el = target && target.nodeType === 1 ? target : target && target.parentElement;
    const chip = el && el.closest ? el.closest(".confirm-chip[data-filter]") : null;
    if (!chip) {
      return;
    }
    ev.preventDefault();
    const next = chip.getAttribute("data-filter");
    activeFilter = activeFilter === next ? null : next;
    applyFilter();
  });
})();
