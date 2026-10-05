export {
  readDestinationSettings,
  normalizeSyncStateDestination,
  hasRemoteDestination,
  remoteUrlForState,
  syncStateIdentity,
  parseOwnerRepo,
  isRepoDestinationConfigured,
  destinationFromSettings,
  persistDestinationSettings,
  applyRepoSettingsToSyncState,
  normalizeBasePath,
  DEFAULT_REPO_BASE_PATH,
  DEFAULT_REPO_BRANCH,
  isLegacyGistConfigured,
  cloneIdentityKey,
  buildRepoSyncState,
} from "./destination.js";
export type { DestinationSettings, DestinationSettingsPatch } from "./destination.js";
export {
  syncKeyToRemoteFileName,
  remoteFileNameToSyncKey,
  remoteNameToGitRelative,
  gitRelativeToRemoteName,
  repoGitPath,
} from "./path-map.js";
