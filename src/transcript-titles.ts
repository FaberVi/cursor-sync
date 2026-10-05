import type { TranscriptSidebarSummary } from "./transcript-bundle.js";

export function summarizeTranscriptForSidebar(
  transcriptContent: string,
  conversationId: string
): TranscriptSidebarSummary {
  const participants = new Set<string>();
  const snippets: string[] = [];
  let messageCount = 0;
  let lastUpdatedAt: string | undefined;

  for (const rawLine of transcriptContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let parsedLine: Record<string, unknown>;
    try {
      parsedLine = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    messageCount += 1;

    if (typeof parsedLine.role === "string" && parsedLine.role.trim().length > 0) {
      participants.add(parsedLine.role.trim());
    }

    const timestamp = getTimestampCandidate(parsedLine);
    if (timestamp) {
      lastUpdatedAt = timestamp;
    }

    for (const snippet of collectTranscriptSnippets(parsedLine)) {
      const normalized = normalizePreviewLine(snippet);
      if (normalized) {
        snippets.push(normalized);
      }
    }
  }

  const title = truncateText(snippets[0] ?? conversationId, 96);
  const previewText = truncateText(
    snippets[snippets.length - 1] ?? snippets[0] ?? conversationId,
    140
  );
  const participantList = [...participants];
  const subtitleParts = [`${messageCount} message${messageCount === 1 ? "" : "s"}`];
  if (participantList.length > 0) {
    subtitleParts.push(participantList.join(", "));
  }

  return {
    title,
    subtitle: subtitleParts.join(" · "),
    previewText,
    messageCount,
    participants: participantList,
    lastUpdatedAt,
  };
}

export const BOILERPLATE_PREFIXES = [
  "The user has manually attached the following skills",
  "<manually_attached_skills>",
  "<EXTREMELY_IMPORTANT>",
  "You have superpowers",
  "Below is the full content of your",
];

export function isTranscriptBoilerplate(text: string): boolean {
  const line = normalizePreviewLine(text);
  if (!line) {
    return true;
  }
  for (const prefix of BOILERPLATE_PREFIXES) {
    if (line.startsWith(prefix)) {
      return true;
    }
  }
  const nonSpace = line.replace(/\s/g, "");
  if (!nonSpace) {
    return true;
  }
  const tagMatches = line.match(/<[^>]+>/g) ?? [];
  const tagChars = tagMatches.join("").replace(/\s/g, "").length;
  if (tagChars / nonSpace.length > 0.5) {
    return true;
  }
  return false;
}

export function firstMeaningfulTranscriptTitle(
  transcriptContent: string,
  conversationId: string
): string | null {
  const userSnippets: string[] = [];
  const anySnippets: string[] = [];

  for (const rawLine of transcriptContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    let parsedLine: Record<string, unknown>;
    try {
      parsedLine = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const role =
      typeof parsedLine.role === "string" ? parsedLine.role.trim().toLowerCase() : "";
    for (const snippet of collectTranscriptSnippets(parsedLine)) {
      const normalized = normalizePreviewLine(snippet);
      if (!normalized || isTranscriptBoilerplate(normalized)) {
        continue;
      }
      anySnippets.push(normalized);
      if (role === "user") {
        userSnippets.push(normalized);
      }
    }
  }

  const first = userSnippets[0] ?? anySnippets[0];
  return first ? truncateText(first, 96) : null;
}

export function resolveConversationDisplayTitle(options: {
  conversationId: string;
  composerName?: string | null;
  transcriptContent?: string | null;
}): string {
  const trimmed = options.composerName?.trim();
  if (trimmed) {
    return trimmed;
  }
  if (options.transcriptContent) {
    const fromTranscript = firstMeaningfulTranscriptTitle(
      options.transcriptContent,
      options.conversationId
    );
    if (fromTranscript) {
      return fromTranscript;
    }
  }
  return options.conversationId;
}

function collectTranscriptSnippets(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTranscriptSnippets(item));
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const prioritizedKeys = [
    "text",
    "content",
    "message",
    "reasoning",
    "input",
    "output",
    "toolName",
    "name",
  ];
  const snippets: string[] = [];

  for (const key of prioritizedKeys) {
    if (key in record) {
      snippets.push(...collectTranscriptSnippets(record[key]));
    }
  }

  return snippets;
}

function getTimestampCandidate(record: Record<string, unknown>): string | undefined {
  const keys = ["timestamp", "createdAt", "updatedAt", "lastUpdatedAt"];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function normalizePreviewLine(value: string): string {
  const collapsed = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^<[^>]+>$/.test(line))
    .join(" ");

  return collapsed.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
