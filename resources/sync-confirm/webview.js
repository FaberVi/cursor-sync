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
