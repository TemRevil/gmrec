import type { CropRect, Selection, Settings, TileKind, TileSignal } from "./types";

export const defaults: Settings = { cameraDeviceId: "default", microphoneDeviceId: "default", includeSelf: true, quality: "720p", name: "gmrec", saveFolder: "GMRec", askWhereToSave: false };

export function normalizeSettings(value: Partial<Settings> = {}): Settings {
  return {
    cameraDeviceId: typeof value.cameraDeviceId === "string" && value.cameraDeviceId ? value.cameraDeviceId : "default",
    microphoneDeviceId: typeof value.microphoneDeviceId === "string" && value.microphoneDeviceId ? value.microphoneDeviceId : "default",
    includeSelf: value.includeSelf !== false,
    quality: value.quality === "1080p" ? "1080p" : "720p",
    name: safeName(value.name ?? "gmrec"),
    saveFolder: safeFolder(value.saveFolder),
    askWhereToSave: value.askWhereToSave === true,
  };
}
// One folder segment: spaces are fine in a Downloads path, the characters Chrome rejects are
// not, and a leading dot or dash would make the folder awkward to open.
function safeSegment(value: string): string {
  return value.replace(/[^\p{L}\p{N} _-]+/gu, "-").replace(/\s+/g, " ").replace(/^[-.\s]+|[-.\s]+$/g, "").slice(0, 60);
}
// The chosen save location, as a relative path under the browser's Downloads folder. Depth is
// capped so a pasted absolute path cannot turn into a deeply nested tree.
export function safeFolder(value: string | undefined): string {
  return String(value ?? "").split(/[\\/]+/).map(safeSegment).filter(Boolean).slice(0, 4).join("/") || "GMRec";
}
export function safeName(value: string): string {
  return String(value).replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "gmrec";
}
// One folder per meeting session, so a session's files land together instead of scattering
// across Downloads. Two digits of clock time keep repeat meetings on the same day apart.
export function meetingFolder(title: string | undefined, url: string | undefined, when: Date = new Date(), prefix = "", root = "GMRec"): string {
  const code = /meet\.google\.com\/([a-z0-9-]+)/i.exec(url ?? "")?.[1];
  const cleaned = (title ?? "")
    .replace(/^Meet\s*[–-]\s*/i, "")
    .replace(/\s*[–-]\s*Google Meet\s*$/i, "")
    .trim();
  // A bare "Meet" / "Google Meet" title carries no meeting name; prefer the meeting code.
  const named = /^(google\s+)?meet$/i.test(cleaned) ? "" : cleaned;
  const name = safeName(named || code || "meeting");
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  // The default prefix adds nothing to a folder that is already named for the meeting.
  const lead = prefix && safeName(prefix) !== "gmrec" ? `${safeName(prefix)}-` : "";
  return `${safeFolder(root)}/${lead}${name}-${day}-${pad(when.getHours())}${pad(when.getMinutes())}`;
}
// Chrome resolves a download filename relative to Downloads; keep it a safe relative path.
export function safeDownloadPath(path: string): boolean {
  return !!path && !path.startsWith("/") && !path.includes("..") && !/[:*?"<>|]/.test(path) && path.split("/").every(Boolean);
}
export function validTileMeta(value: unknown): value is { id: string; label: string; kind: TileKind; mirrored?: boolean } {
  const t = value as { id?: unknown; label?: unknown; kind?: unknown; mirrored?: unknown } | undefined;
  if (t?.mirrored !== undefined && typeof t.mirrored !== "boolean") return false;
  return typeof t?.id === "string" && !!t.id && typeof t.label === "string" && (t.kind === "camera" || t.kind === "screen");
}
export function validSelection(value: unknown): value is Selection {
  const v = value as Selection | undefined;
  return Array.isArray(v?.tiles) && v.tiles.length > 0 && v.tiles.every(validTileMeta);
}
export function validSignal(value: unknown): value is TileSignal {
  const s = value as { kind?: unknown; sdp?: unknown; candidate?: unknown; message?: unknown } | undefined;
  if (!s) return false;
  if (s.kind === "request" || s.kind === "close") return true;
  if (s.kind === "offer" || s.kind === "answer") return typeof s.sdp === "string";
  if (s.kind === "ice") return typeof s.candidate === "object" && s.candidate !== null;
  if (s.kind === "error") return typeof s.message === "string";
  return false;
}
export function fitRect(sourceWidth: number, sourceHeight: number, width: number, height: number, fit: "contain" | "cover"): CropRect {
  const scale = (fit === "cover" ? Math.max : Math.min)(width / sourceWidth, height / sourceHeight);
  return { x: (width - sourceWidth * scale) / 2, y: (height - sourceHeight * scale) / 2, width: sourceWidth * scale, height: sourceHeight * scale };
}
export function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, "0")).join(":");
}
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "NotAllowedError") return "Camera or microphone permission was denied. Open Device setup, allow access, then return to Meet.";
    if (error.name === "NotFoundError") return "A camera or microphone was not found. Check your devices or record the participant only.";
    if (error.name === "NotReadableError") return "A device could not be opened. Close other camera tests, check OS permissions, and try again.";
    if (error.name === "OverconstrainedError") return "The selected device is unavailable. Choose another device in setup.";
    return error.message;
  }
  return String(error);
}
