export type CropRect = { x: number; y: number; width: number; height: number };
export type TileKind = "camera" | "screen";
export type DetectedTile = { id: string; label: string; kind: TileKind; selected: boolean };
export type TileSelection = { id: string; label: string; kind: TileKind; mirrored?: boolean };
export type Selection = { tiles: TileSelection[] };
// Loopback WebRTC signaling between the Meet content script (which holds the real participant
// tracks) and the offscreen recorder, relayed by the background worker.
export type TileSignal =
  | { kind: "request" }
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "ice"; candidate: RTCIceCandidateInit }
  | { kind: "error"; message: string }
  | { kind: "close" };
export type Settings = {
  cameraDeviceId: string;
  microphoneDeviceId: string;
  includeSelf: boolean;
  quality: "1080p" | "720p";
  name: string;
  // Where finished files land. Always a path inside the browser's own Downloads folder:
  // an extension cannot write anywhere else, so "elsewhere" means Chrome's download
  // location, or askWhereToSave, which hands each file to Chrome's own Save-as dialog.
  saveFolder: string;
  askWhereToSave: boolean;
};
export type RecordingConfig = Settings & { tabId: number; selection: Selection; width: number; height: number; fps: number; folder: string; meeting: { title: string; url: string } };
export type RecorderState = {
  phase: "idle" | "starting" | "recording" | "paused" | "stopping";
  tabId?: number;
  elapsedMs: number;
  warning?: string;
};
export type SavedRecording = {
  id: string;
  filename: string;
  folder?: string;
  createdAt: number;
  mimeType: string;
  kind?: string;
  label?: string;
  saveAs?: boolean;
  width?: number;
  height?: number;
  bytes: number;
  chunks: number;
  status: "recording" | "ready" | "interrupted";
};
export type Reply<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

// Breakout-box types are not in TypeScript's DOM library yet.
declare global {
  class MediaStreamTrackProcessor {
    constructor(init: { track: MediaStreamTrack });
    readable: ReadableStream<VideoFrame>;
  }
}
