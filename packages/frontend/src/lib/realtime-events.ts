// The realtime server sends every event as one JSON envelope:
//   { event, data, projectId? | workspaceId? | channelId? }
// The scope field names the subscription the event was broadcast to; events
// pushed to a single user carry none. Frames are untrusted input, so they are
// validated here once and consumers only ever see a well-formed envelope.

export type RealtimeData = Record<string, unknown>;

export interface RealtimeEnvelope {
  event: string;
  data: RealtimeData;
  projectId?: string;
  workspaceId?: string;
  channelId?: string;
}

const SCOPES = ["projectId", "workspaceId", "channelId"] as const;
const MAX_ID_LENGTH = 128;

function isRecord(value: unknown): value is RealtimeData {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH
  );
}

/** Returns the envelope in a text frame, or null if the frame is not one. */
export function parseRealtimeEnvelope(raw: unknown): RealtimeEnvelope | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;

  const { event, data } = value;
  if (typeof event !== "string" || event.length === 0) return null;
  if (data !== undefined && !isRecord(data)) return null;

  const envelope: RealtimeEnvelope = { event, data: data ?? {} };
  for (const scope of SCOPES) {
    const id = value[scope];
    if (id === undefined) continue;
    if (!isId(id)) return null;
    envelope[scope] = id;
  }
  return envelope;
}

/** An entity ID field of an event payload, if present and well-formed. */
export function readId(source: unknown, key: string): string | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[key];
  return isId(value) ? value : undefined;
}

/** A nested object of an event payload (e.g. `data.page`), if present. */
export function readRecord(
  source: unknown,
  key: string,
): RealtimeData | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[key];
  return isRecord(value) ? value : undefined;
}

/** A non-empty text field of an event payload, if present. */
export function readText(source: unknown, key: string): string | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}
