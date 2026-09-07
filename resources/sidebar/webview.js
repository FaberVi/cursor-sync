(function (CSW) {
  document.addEventListener("click", CSW.onDocumentClick);
  document.addEventListener("change", CSW.onDocumentChange);
  window.addEventListener("message", CSW.onWindowMessage);
  CSW.applySyncTabBadge();
})(globalThis.CursorSyncSidebar);
