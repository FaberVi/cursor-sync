export function humanWorkspaceLabel(folderName: string): string {
  const parts = folderName.split("-");
  if (parts.length <= 1) return folderName;
  const last = parts[parts.length - 1]!;
  const withoutHash = last.length === 40 || last.length === 8 ? parts.slice(0, -1) : parts;
  return withoutHash.join("-");
}
