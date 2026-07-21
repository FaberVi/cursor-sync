/**
 * Pure gate for skipping full chat packaging on push.
 * Fingerprint is discovery metadata; checksums are content hashes from sync state/manifest.
 */
export function shouldSkipChatPackaging(input: {
  remoteChecksum?: string;
  lastLocalChecksum?: string;
  storedFingerprint?: string;
  currentFingerprint: string;
}): boolean {
  const { remoteChecksum, lastLocalChecksum, storedFingerprint, currentFingerprint } =
    input;
  if (!remoteChecksum || !lastLocalChecksum || lastLocalChecksum !== remoteChecksum) {
    return false;
  }
  if (!storedFingerprint) {
    return false;
  }
  return currentFingerprint === storedFingerprint;
}
