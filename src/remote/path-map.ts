/** Re-export path mapping used for both Gist and repo flat file names. */
export {
  syncKeyToGistFileName as syncKeyToRemoteFileName,
  gistFileNameToSyncKey as remoteFileNameToSyncKey,
} from "../paths.js";

export function joinRemotePath(basePath: string, fileName: string): string {
  const base = basePath.replace(/^\/+|\/+$/g, "");
  const name = fileName.replace(/^\/+/, "");
  return base ? `${base}/${name}` : name;
}

export function stripRemotePath(basePath: string, fullPath: string): string | undefined {
  const base = basePath.replace(/^\/+|\/+$/g, "");
  const normalized = fullPath.replace(/^\/+/, "");
  if (!base) {
    return normalized;
  }
  const prefix = `${base}/`;
  if (!normalized.startsWith(prefix)) {
    return undefined;
  }
  return normalized.slice(prefix.length);
}
