/**
 * PowerShell/C# query adapted from skills-store `windowsLockQueryScript`.
 * Registers files only (a directory path makes Restart Manager return access denied),
 * skips reparse points, and prints one `LOCKS_JSON:` line per batch so a folder
 * larger than one batch is still fully scanned.
 */
export const LOCK_QUERY_MARKER = "LOCKS_JSON:";

export interface LockQueryProcess {
  pid: number;
  name: string;
  path: string;
  appType?: number;
}

/** Merge every `LOCKS_JSON:` line. A broken line is skipped; earlier batches still count. */
export function parseLockQueryStdout(stdout: string): LockQueryProcess[] {
  const merged: LockQueryProcess[] = [];
  const seen = new Set<number>();
  for (const entry of stdout.split(/\r?\n/)) {
    const trimmed = entry.trim();
    if (!trimmed.startsWith(LOCK_QUERY_MARKER)) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed.slice(LOCK_QUERY_MARKER.length));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) {
      continue;
    }
    for (const item of parsed) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const record = item as { pid?: unknown; name?: unknown; path?: unknown; appType?: unknown };
      const pid = Number(record.pid);
      if (!Number.isInteger(pid) || seen.has(pid)) {
        continue;
      }
      seen.add(pid);
      const appType = Number(record.appType);
      merged.push({
        pid,
        name: typeof record.name === "string" ? record.name : "",
        path: typeof record.path === "string" ? record.path : "",
        appType: Number.isInteger(appType) ? appType : undefined,
      });
    }
  }
  return merged;
}

export const LOCK_QUERY_SCRIPT = String.raw`
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$target = $env:CURSOR_SYNC_LOCK_PATH
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class CursorSyncDirectoryLockQuery {
    const int CCH_RM_MAX_APP_NAME = 255;
    const int CCH_RM_MAX_SVC_NAME = 63;
    const int ERROR_MORE_DATA = 234;

    [StructLayout(LayoutKind.Sequential)]
    public struct RM_UNIQUE_PROCESS {
        public int dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    public enum RM_APP_TYPE {
        RmUnknownApp = 0,
        RmMainWindow = 1,
        RmOtherWindow = 2,
        RmService = 3,
        RmExplorer = 4,
        RmConsole = 5,
        RmCritical = 1000
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct RM_PROCESS_INFO {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_APP_NAME + 1)]
        public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_SVC_NAME + 1)]
        public string strServiceShortName;
        public RM_APP_TYPE ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, StringBuilder strSessionKey);

    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint pSessionHandle);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, IntPtr rgApplications, uint nServices, string[] rgsServiceNames);

    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

    public static string ListFiles(string targetPath) {
        try {
            var files = CollectFiles(targetPath);
            files.Sort(StringComparer.OrdinalIgnoreCase);
            return string.Join("\n", files);
        } catch {
            return "";
        }
    }

    public static string QueryFiles(string[] batch) {
        try {
            if (batch == null || batch.Length == 0) {
                return "[]";
            }

            uint handle;
            int start = RmStartSession(out handle, 0, new StringBuilder(64));
            if (start != 0) {
                return "[]";
            }

            try {
                int registered = RmRegisterResources(handle, (uint)batch.Length, batch, 0, IntPtr.Zero, 0, null);
                if (registered != 0) {
                    return "[]";
                }

                uint needed = 0;
                uint count = 0;
                uint reasons = 0;
                int listed = RmGetList(handle, out needed, ref count, null, ref reasons);
                if (listed == 0 || needed == 0) {
                    return "[]";
                }
                if (listed != ERROR_MORE_DATA) {
                    return "[]";
                }

                count = needed;
                var infos = new RM_PROCESS_INFO[needed];
                listed = RmGetList(handle, out needed, ref count, infos, ref reasons);
                if (listed != 0) {
                    return "[]";
                }

                var sb = new StringBuilder();
                sb.Append("[");
                bool first = true;
                var seen = new HashSet<int>();
                for (int i = 0; i < count; i++) {
                    int pid = infos[i].Process.dwProcessId;
                    if (pid <= 0 || !seen.Add(pid)) {
                        continue;
                    }
                    string name = infos[i].strAppName ?? "";
                    string exe = "";
                    try {
                        var proc = Process.GetProcessById(pid);
                        if (!string.IsNullOrEmpty(proc.ProcessName)) {
                            name = proc.ProcessName;
                        }
                        try { exe = proc.MainModule.FileName ?? ""; } catch { }
                    } catch { }

                    if (!first) {
                        sb.Append(",");
                    }
                    first = false;
                    sb.Append("{\"pid\":").Append(pid);
                    sb.Append(",\"name\":\"").Append(Escape(name)).Append("\"");
                    sb.Append(",\"path\":\"").Append(Escape(exe)).Append("\"");
                    sb.Append(",\"appType\":").Append((int)infos[i].ApplicationType).Append("}");
                }
                sb.Append("]");
                return sb.ToString();
            } finally {
                RmEndSession(handle);
            }
        } catch {
            return "[]";
        }
    }

    static List<string> CollectFiles(string targetPath) {
        var files = new List<string>();
        if (File.Exists(targetPath)) {
            var info = new FileInfo(targetPath);
            if ((info.Attributes & FileAttributes.ReparsePoint) == 0) {
                files.Add(info.FullName);
            }
            return files;
        }
        if (!Directory.Exists(targetPath)) {
            return files;
        }
        Walk(new DirectoryInfo(targetPath), files);
        return files;
    }

    static void Walk(DirectoryInfo dir, List<string> files) {
        if ((dir.Attributes & FileAttributes.ReparsePoint) != 0) {
            return;
        }
        FileInfo[] fileInfos;
        try { fileInfos = dir.GetFiles(); } catch { return; }
        foreach (var file in fileInfos) {
            if ((file.Attributes & FileAttributes.ReparsePoint) != 0) {
                continue;
            }
            files.Add(file.FullName);
        }
        DirectoryInfo[] subdirs;
        try { subdirs = dir.GetDirectories(); } catch { return; }
        foreach (var sub in subdirs) {
            Walk(sub, files);
        }
    }

    static string Escape(string value) {
        if (string.IsNullOrEmpty(value)) {
            return "";
        }
        return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }
}
'@ -Language CSharp
$batchSize = 500
if ($env:CURSOR_SYNC_LOCK_BATCH) {
  $parsed = 0
  if ([int]::TryParse($env:CURSOR_SYNC_LOCK_BATCH, [ref]$parsed) -and $parsed -gt 0) {
    $batchSize = $parsed
  }
}
$raw = [CursorSyncDirectoryLockQuery]::ListFiles($target)
$files = @()
if ($raw) {
  $files = @($raw.Split([char]10) | ForEach-Object { $_.TrimEnd([char]13) } | Where-Object { $_ })
}
if ($files.Count -eq 0) {
  Write-Output "LOCKS_JSON:[]"
  return
}
for ($offset = 0; $offset -lt $files.Count; $offset += $batchSize) {
  $take = [Math]::Min($batchSize, $files.Count - $offset)
  $batch = New-Object string[] $take
  for ($i = 0; $i -lt $take; $i++) {
    $batch[$i] = [string]$files[$offset + $i]
  }
  $json = [CursorSyncDirectoryLockQuery]::QueryFiles($batch)
  Write-Output ("LOCKS_JSON:" + $json)
}
`;
