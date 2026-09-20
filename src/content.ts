import type { DetectedTile, RecorderState, Selection, TileKind, TileSignal } from "./types";
import { type Adapter, adapterFor, deepClosest, deepLeaves, deepQueryAll, deepText, deepVideos } from "./adapters";
import { errorMessage, fitRect, formatTime, meetingFolder, safeName } from "./shared";

// executeScript may be used after an extension update; never attach duplicate listeners.
const scope = globalThis as typeof globalThis & { __gmrecDispose?: () => void };
scope.__gmrecDispose?.();

type Tracked = {
  video: HTMLVideoElement;
  id: string;
  ordinal: number;
  kind: TileKind;
  selected: boolean;
  mirrored: boolean;
  key: string | null;
  missingSince?: number;
  label: string;
  source: unknown;
  overlayBox?: HTMLDivElement;
  overlayCanvas?: HTMLCanvasElement;
};
// One loopback RTCPeerConnection per tile being recorded: the real participant track is cloned
// and streamed to the offscreen recorder, which encodes it at native quality.
type Loopback = { pc: RTCPeerConnection; sender: RTCRtpSender; sourceTrack: MediaStreamTrack; clone: MediaStreamTrack; audioClone?: MediaStreamTrack; pending: RTCIceCandidateInit[]; remoteSet: boolean; kind: TileKind };
const tracked = new Map<HTMLVideoElement, Tracked>();
const loopbacks = new Map<string, Loopback>();
const dismissedScreenIds = new Set<string>();
let idCounter = 0;
let active = false;
let overlayRaf: number | undefined;
let promptForId: string | undefined;
let promptHost: HTMLDivElement | undefined;
const REBIND_GRACE_MS = 15000;
const PREVIEW_MAX_WIDTH = 320;
const PREVIEW_MAX_HEIGHT = 200;

// One design vocabulary for every injected surface. These live in shadow roots, so they cannot
// inherit the popup's stylesheet and carry their own copy of the tokens. Dark only by intent:
// these sit on top of a dark Meet call, and a light panel glares mid-conversation.
const OVERLAY_CSS = `
  :host{
    --surface:oklch(0.215 0.015 245);--raised:oklch(0.265 0.017 245);--line:oklch(0.33 0.018 245);
    --ink:oklch(0.97 0.004 245);--ink-muted:oklch(0.76 0.013 245);
    --accent:oklch(0.8 0.125 195);--accent-ink:oklch(0.2 0.035 220);
    --tally:oklch(0.64 0.215 25);--danger:oklch(0.57 0.2 25);--paused:oklch(0.8 0.145 75);
    --shadow:0 2px 6px oklch(0 0 0/0.5),0 14px 34px oklch(0 0 0/0.45);
    --ease:cubic-bezier(0.22,0.61,0.36,1);
  }
  *{box-sizing:border-box}
  [hidden]{display:none!important}
  .chassis{
    background:var(--surface);border:1px solid var(--line);border-radius:14px;
    box-shadow:var(--shadow);color:var(--ink);
    font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;
  }
  .grip{
    display:grid;place-items:center;cursor:grab;color:var(--ink-muted);
    border-radius:8px;flex-shrink:0;touch-action:none;
  }
  .grip:active{cursor:grabbing}
  .grip:hover{color:var(--ink)}
  .grip svg{width:14px;height:14px;display:block}
  button{
    display:inline-flex;align-items:center;justify-content:center;gap:7px;
    min-height:34px;padding:0 13px;border-radius:999px;border:1px solid var(--line);
    background:var(--raised);color:var(--ink);cursor:pointer;
    font:550 13px/1 system-ui,-apple-system,"Segoe UI",sans-serif;white-space:nowrap;
    transition:background 140ms var(--ease),border-color 140ms var(--ease),filter 140ms var(--ease);
  }
  button:hover:not(:disabled){border-color:var(--accent)}
  button:disabled{opacity:.45;cursor:not-allowed}
  button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  button svg{width:14px;height:14px;flex-shrink:0}
  .primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
  .primary:hover:not(:disabled){filter:brightness(1.08)}
  .danger{background:var(--danger);border-color:var(--danger);color:var(--ink)}
  .danger:hover:not(:disabled){filter:brightness(1.08)}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--tally);flex-shrink:0}
  @media (prefers-reduced-motion:reduce){
    *{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
  }
`;
const GRIP_SVG = `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="6" cy="3" r="1.4"/><circle cx="10" cy="3" r="1.4"/><circle cx="6" cy="8" r="1.4"/><circle cx="10" cy="8" r="1.4"/><circle cx="6" cy="13" r="1.4"/><circle cx="10" cy="13" r="1.4"/></svg>`;
const STOP_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>`;
const PAUSE_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="3.6" height="14" rx="1.6"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.6"/></svg>`;
const PLAY_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.6v12.8a1 1 0 0 0 1.53.85l10-6.4a1 1 0 0 0 0-1.7l-10-6.4A1 1 0 0 0 8 5.6Z"/></svg>`;
const SHOT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3.2"/></svg>`;

function clamp(value: number, min: number, max: number): number { return Math.min(Math.max(value, min), max); }
// Lets the user drag a fixed-position overlay (by its grip element) to wherever suits their
// layout, remembering the chosen spot across reloads. Mouse/touch only, by design.
function makeDraggable(handle: HTMLElement, host: HTMLDivElement, storageKey: string) {
  let dragging = false, pointerId = -1, startX = 0, startY = 0, originLeft = 0, originTop = 0;
  handle.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    dragging = true; pointerId = event.pointerId;
    try { handle.setPointerCapture(pointerId); } catch { /* ignore */ }
    const rect = host.getBoundingClientRect();
    startX = event.clientX; startY = event.clientY; originLeft = rect.left; originTop = rect.top;
    event.preventDefault();
  });
  handle.addEventListener("pointermove", event => {
    if (!dragging || event.pointerId !== pointerId) return;
    const left = clamp(originLeft + (event.clientX - startX), 0, Math.max(0, innerWidth - host.offsetWidth));
    const top = clamp(originTop + (event.clientY - startY), 0, Math.max(0, innerHeight - host.offsetHeight));
    host.style.left = `${left}px`; host.style.top = `${top}px`; host.style.right = "auto"; host.style.bottom = "auto";
  });
  const stopDrag = (event: PointerEvent) => {
    if (!dragging || event.pointerId !== pointerId) return;
    dragging = false;
    void chrome.storage.local.set({ [storageKey]: { left: host.style.left, top: host.style.top } }).catch(() => {});
  };
  handle.addEventListener("pointerup", stopDrag);
  handle.addEventListener("pointercancel", stopDrag);
  void chrome.storage.local.get(storageKey).then(stored => {
    const pos = stored[storageKey] as { left?: string; top?: string } | undefined;
    if (pos?.left && pos?.top) { host.style.left = pos.left; host.style.top = pos.top; host.style.right = "auto"; host.style.bottom = "auto"; }
  }).catch(() => {});
}

// Which product this page is. Re-resolved until something more specific than the generic
// adapter matches, because a single-page app often mounts its call UI well after load.
let adapter: Adapter = adapterFor(location.href);
function refreshAdapter() {
  if (adapter.id !== "generic") return;
  const next = adapterFor(location.href);
  if (next.id !== adapter.id) adapter = next;
}
// The tile element wrapping one participant. An adapter names the conventions it knows about;
// otherwise the highest ancestor that still holds exactly this one video is the tile, which is
// what a tile is on any site whether or not it advertises the fact.
function containerOf(video: HTMLVideoElement): Element | null {
  for (const selector of adapter.containers) {
    const hit = deepClosest(video, selector);
    if (hit) return hit;
  }
  let best: Element | null = video.parentElement;
  let current: Element | null = video.parentElement;
  for (let depth = 0; depth < 6 && current; depth++) {
    if (deepVideos(current).length !== 1) break;
    best = current;
    const root = current.parentElement ?? (current.getRootNode() instanceof ShadowRoot ? (current.getRootNode() as ShadowRoot).host : null);
    current = root;
  }
  return best;
}
function videoTrackOf(video: HTMLVideoElement): MediaStreamTrack | undefined {
  const source = video.srcObject;
  return source instanceof MediaStream ? source.getVideoTracks().find(track => track.readyState === "live") : undefined;
}
// Meet plays each participant through its own element, so their voice can often be recorded
// into their own file instead of everyone landing on one mixed tab-audio track.
function audioTrackOf(video: HTMLVideoElement): MediaStreamTrack | undefined {
  const own = video.srcObject instanceof MediaStream ? video.srcObject.getAudioTracks().find(track => track.readyState === "live") : undefined;
  if (own) return own;
  const container = containerOf(video);
  const id = container?.getAttribute("data-participant-id");
  // A tile that carries its own <audio> is the best case; otherwise fall back to a document-wide
  // element paired by participant id, which is how Meet lays it out.
  const inTile = container ? deepQueryAll(container, "audio") : [];
  for (const element of [...inTile, ...deepQueryAll(document, "audio")] as HTMLAudioElement[]) {
    const source = element.srcObject;
    if (!(source instanceof MediaStream)) continue;
    const track = source.getAudioTracks().find(track => track.readyState === "live");
    if (!track) continue;
    if (container?.contains(element)) return track;
    if (id && element.closest("[data-participant-id]")?.getAttribute("data-participant-id") === id) return track;
  }
  return undefined;
}
function isVisibleVideo(video: HTMLVideoElement): boolean {
  const r = video.getBoundingClientRect();
  const style = getComputedStyle(video);
  return r.width >= 80 && r.height >= 60 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0 && video.readyState >= 2 && !!videoTrackOf(video);
}
// "Live" is all recording needs: the track keeps flowing whether or not Meet currently shows
// the tile, so visibility, popup focus, or tab switches never interrupt a recording.
function tileLive(entry: Tracked): boolean {
  return entry.video.isConnected && !!videoTrackOf(entry.video);
}
// Meet shows your own camera mirrored, as a CSS transform on the tile. Recording the raw track
// bypasses that, so the file comes out reversed compared to what was on screen. Tab-capture
// recorders never hit this because they copy rendered pixels; we have to reproduce it.
function isMirrored(video: HTMLVideoElement): boolean {
  let flipped = false;
  let node: Element | null = video;
  while (node) {
    const transform = getComputedStyle(node).transform;
    if (transform && transform !== "none") {
      // matrix(a, ...) / matrix3d(a, ...): a negative horizontal scale means flipped.
      const scaleX = Number(/^matrix(?:3d)?\(\s*(-?[\d.e+-]+)/.exec(transform)?.[1]);
      if (Number.isFinite(scaleX) && scaleX < 0) flipped = !flipped;
    }
    node = node.parentElement;
  }
  return flipped;
}
function isLocalTrack(track: MediaStreamTrack | undefined): boolean {
  // Verified in Chrome: deviceId is present on remote receiver tracks too, so it cannot tell
  // them apart. Only a real local capture device also reports a groupId.
  return !!track && typeof track.getSettings === "function" && !!track.getSettings().groupId;
}
function detectKind(video: HTMLVideoElement): TileKind {
  if (videoTrackOf(video)?.getSettings().displaySurface) return "screen";
  const container = containerOf(video);
  const labels = container ? tileLabels(container) : [];
  const own = video.getAttribute("aria-label");
  if (own) labels.push(own);
  // Never match a bare "screen": "Pin to screen" is a control on ordinary camera tiles.
  return labels.some(label => /presentation|presenting|screen\s*shar/i.test(label)) ? "screen" : "camera";
}
// Meet's class names are generated and change often, so the name is read from the things that
// stay put: aria-label, Meet's own self-name attribute, and finally the visible text inside the
// tile. Anything unrecognised falls back to a numbered label rather than guessing wrong.
const UI_TEXT = new Set([
  "you", "presentation", "pinned", "pin", "unpin", "more options", "mute", "muted", "unmute",
  "host", "co-host", "presenting", "is presenting", "your presentation", "screen share",
  "reframe", "pin to screen", "remove from screen", "options", "more", "settings",
]);
// Meet's control labels are written for screen readers, so they are far more stable than its
// generated class names, and they embed the participant's name: "Unpin Mohammed Ahmed's
// presentation", "Pin Mohammed Ahmed", "Mohammed Ahmed is presenting". Pulling the name out of
// those is much more reliable than hunting for the right div.
const NAME_FROM_LABEL: RegExp[] = [
  /^(?:un)?pin\s+(.+?)'s\s+presentation\b/i,
  /^(.+?)'s\s+presentation\b/i,
  /^(.+?)\s+is\s+presenting\b/i,
  /^more\s+options\s+for\s+(.+?)$/i,
  /^(?:un)?pin\s+(.+?)$/i,
  /^(?:un)?mute\s+(.+?)$/i,
  /^(.+?)'s\s+video\b/i,
  /^(.+?)\s+is\s+(?:muted|speaking|pinned)\b/i,
];
function plausibleName(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 60) return false;
  if (text.includes("_")) return false;                              // icon ligature
  if (/^\d+$/.test(text) || /^\d{1,2}:\d{2}/.test(text)) return false; // counters and timers
  return !UI_TEXT.has(text.toLowerCase());
}
function tileLabels(container: Element): string[] {
  const labels: string[] = [];
  const own = container.getAttribute("aria-label");
  if (own) labels.push(own);
  for (const node of deepQueryAll(container, "[aria-label], [data-tooltip], [title]")) {
    const label = node.getAttribute("aria-label") ?? node.getAttribute("data-tooltip") ?? node.getAttribute("title");
    if (label) labels.push(label);
  }
  return labels;
}
function nameFromTile(video: HTMLVideoElement, kind: TileKind): string | null {
  const container = containerOf(video);
  if (!container) return null;
  // Whatever this particular product exposes directly beats any amount of scraping.
  const hint = adapter.nameHints?.({ video, container, kind })?.trim();
  if (hint && plausibleName(hint)) return hint;
  // Most specific pattern first, across every control label in the tile.
  const labels = tileLabels(container);
  for (const pattern of NAME_FROM_LABEL) {
    for (const label of labels) {
      const name = pattern.exec(label.trim())?.[1]?.trim();
      if (name && plausibleName(name)) return name;
    }
  }
  // Otherwise the visible name chip, ignoring anything that belongs to a control. Shadow roots
  // are walked too: on a web-component product the name tag is only ever inside one.
  for (const node of deepLeaves(container)) {
    if (node.closest("button, [role='button'], [role='menuitem'], [aria-label], [data-tooltip]")) continue;
    const text = deepText(node);
    if (plausibleName(text)) return text;
  }
  // A bare aria-label with no recognisable pattern is a last resort, and only if it reads like
  // a name rather than a control ("Reframe", "Pin to screen").
  const bare = labels.find(label => plausibleName(label) && !/^(un)?pin\b|option|reframe|screen/i.test(label.trim()));
  return bare?.trim() ?? null;
}
const NUMBERED_LABEL = /^(Participant|Screen share) \d+$/;
function resolveLabel(entry: Tracked): string {
  const name = nameFromTile(entry.video, entry.kind);
  if (entry.kind === "screen") {
    if (!name) return `Screen share ${entry.ordinal}`;
    // Meet's own label often already says "… is presenting"; don't tack "screen" onto that.
    return /present|screen|shar/i.test(name) ? name : `${name} (screen)`;
  }
  if (name) return name;
  // A product mirrors only your own camera, so a mirrored tile is a reliable self-view signal
  // even when the track carries no groupId (Meet's effects pipeline strips it).
  return entry.mirrored || isLocalTrack(videoTrackOf(entry.video)) ? "Your self view" : `Participant ${entry.ordinal}`;
}
// Cached: resolveLabel walks the tile's subtree, and this is read on every preview frame.
function labelFor(entry: Tracked): string { return entry.label; }
// Identity that survives Meet replacing the element, which it does whenever a camera is toggled
// or switched. Without this the same person is rediscovered as a new tile every time.
// Attributes products use to mark who a tile belongs to. Checked on the tile and its ancestors.
const ID_ATTRIBUTES = ["data-participant-id", "data-participant", "data-peer-id", "data-user-id", "data-member-id", "data-session-id"];
function participantIdOf(video: HTMLVideoElement, kind: TileKind): string | null {
  const container = containerOf(video);
  const fromAdapter = adapter.stableId?.({ video, container, kind });
  if (fromAdapter) return fromAdapter;
  for (const attribute of ID_ATTRIBUTES) {
    const value = deepClosest(video, `[${attribute}]`)?.getAttribute(attribute);
    if (value) return value;
  }
  return null;
}
function tileKey(video: HTMLVideoElement, kind: TileKind): string | null {
  const participant = participantIdOf(video, kind);
  if (participant) return `${participant}|${kind}`;
  // No id attribute: a product built from web components keeps the participant object as a JS
  // property, which lives in the page's world and is invisible here. The rendered name is the
  // next most stable thing about a person, and it survives the element being replaced.
  const name = nameFromTile(video, kind);
  if (name) return `name:${name}|${kind}`;
  // Last resort. A MediaStream id is stable while the stream lasts, so it still prevents the
  // same tile being rediscovered on every 500ms scan — it just cannot follow a camera swap.
  const stream = video.srcObject;
  return stream instanceof MediaStream && stream.id ? `stream:${stream.id}|${kind}` : null;
}
function newId(video: HTMLVideoElement): string {
  return `${participantIdOf(video, "camera") || "tile"}-${++idCounter}`;
}
function getDetectedTiles(): DetectedTile[] {
  return Array.from(tracked.values(), entry => ({ id: entry.id, label: labelFor(entry), kind: entry.kind, selected: entry.selected }));
}
function getSelections(): Selection | null {
  const tiles = Array.from(tracked.values()).filter(entry => entry.selected && tileLive(entry)).map(entry => ({ id: entry.id, label: labelFor(entry), kind: entry.kind, mirrored: entry.mirrored }));
  return tiles.length ? { tiles } : null;
}
// Screenshots are captured straight from each selected video's real track (native resolution),
// independent of recording state, and saved as plain data: URLs so no blob-origin issues arise
// when the background page (a different context) hands them to chrome.downloads.
async function captureScreenshots(): Promise<number> {
  const selected = Array.from(tracked.values()).filter(entry => entry.selected && tileLive(entry) && entry.video.readyState >= 2);
  if (!selected.length) return 0;
  let prefix = "gmrec";
  try { const stored = await chrome.storage.local.get("settings"); prefix = safeName(stored.settings?.name ?? "gmrec"); } catch { /* fall back to default prefix */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const entry of selected) {
    const canvas = document.createElement("canvas");
    canvas.width = entry.video.videoWidth; canvas.height = entry.video.videoHeight;
    canvas.getContext("2d")!.drawImage(entry.video, 0, 0);
    const dataUrl = canvas.toDataURL("image/png");
    const filename = `${meetingFolder(document.title, location.href)}/${prefix}-screenshot-${stamp}-${safeName(labelFor(entry))}.png`;
    void chrome.runtime.sendMessage({ target: "background", type: "save-screenshot", dataUrl, filename }).catch(() => {});
  }
  return selected.length;
}

function sendSignal(id: string, signal: TileSignal) {
  void chrome.runtime.sendMessage({ target: "background", type: "tile-signal", id, signal }).catch(() => {});
}
function closeLoopback(id: string) {
  const entry = loopbacks.get(id);
  if (!entry) return;
  loopbacks.delete(id);
  entry.pc.onicecandidate = null;
  entry.pc.close();
  entry.clone.stop();
  entry.audioClone?.stop();
}
// This connection never leaves the machine, so WebRTC's congestion control has nothing real to
// protect against. Left alone it still ramps its bandwidth estimate up from a few hundred kbps,
// which at 720p starves the encoder.
//
// Do NOT set degradationPreference to "maintain-resolution" here. That tells the encoder to throw
// away framerate to protect resolution, and combined with the slow ramp it collapses a camera to
// a fraction of a frame per second. Chrome already picks a sensible default per content hint.
async function tuneSender(sender: RTCRtpSender, kind: TileKind) {
  // "detail" keeps shared text sharp; "motion" keeps a talking head smooth.
  if (sender.track) sender.track.contentHint = kind === "screen" ? "detail" : "motion";
  try {
    const params = sender.getParameters();
    // Framerate is preferred for both kinds. The recorder normalises every tile into a
    // fixed-size canvas, so upstream resolution adaptation no longer reaches the file and there
    // is nothing left to protect by dropping frames instead.
    params.degradationPreference = "maintain-framerate";
    if (!params.encodings?.length) params.encodings = [{}];
    for (const encoding of params.encodings) {
      encoding.maxBitrate = MAX_BITRATE_BPS;
      encoding.maxFramerate = 30;
      delete encoding.scaleResolutionDownBy;
    }
    await sender.setParameters(params);
  } catch { /* older Chrome may reject some fields; the stream still flows */ }
}
const MAX_BITRATE_BPS = 8_000_000;
const START_BITRATE_KBPS = 4000;
// maxBitrate above is only a ceiling; it does not raise the *starting* estimate. These
// Chrome-specific SDP parameters do, and they are applied to the answer we receive because the
// remote description is what configures our own encoder.
function boostVideoBitrate(sdp: string, kbps: number): string {
  const lines = sdp.split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith("m=video"));
  if (start === -1) return sdp;
  let end = lines.findIndex((line, index) => index > start && line.startsWith("m="));
  if (end === -1) end = lines.length;
  const section = lines.slice(start, end);
  // Only the real video codecs, never rtx/red/ulpfec payloads.
  const codecs = new Set(section.flatMap(line => {
    const match = /^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)\//i.exec(line);
    return match ? [match[1]] : [];
  }));
  const tuned = section.flatMap(line => {
    if (line.startsWith("c=")) return [line, `b=AS:${kbps}`, `b=TIAS:${kbps * 1000}`];
    if (line.startsWith("b=")) return []; // replaced by the pair above
    const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(line);
    if (fmtp && codecs.has(fmtp[1]) && !fmtp[2].includes("x-google-")) {
      return [`a=fmtp:${fmtp[1]} ${fmtp[2]};x-google-start-bitrate=${kbps};x-google-min-bitrate=${Math.round(kbps / 2)};x-google-max-bitrate=${kbps}`];
    }
    return [line];
  });
  return [...lines.slice(0, start), ...tuned, ...lines.slice(end)].join("\r\n");
}
async function openLoopback(entry: Tracked) {
  closeLoopback(entry.id);
  const sourceTrack = videoTrackOf(entry.video);
  if (!sourceTrack) { sendSignal(entry.id, { kind: "error", message: `${labelFor(entry)} has no live video right now.` }); return; }
  const pc = new RTCPeerConnection();
  const clone = sourceTrack.clone();
  const outgoing = new MediaStream([clone]);
  const sender = pc.addTrack(clone, outgoing);
  // That participant's own voice, when Meet exposes it, so it lands in their file rather than
  // everyone sharing one mixed tab-audio track.
  const participantAudio = audioTrackOf(entry.video);
  const audioClone = participantAudio?.clone();
  if (audioClone) { outgoing.addTrack(audioClone); pc.addTrack(audioClone, outgoing); }
  const loopback: Loopback = { pc, sender, sourceTrack, clone, audioClone, pending: [], remoteSet: false, kind: entry.kind };
  loopbacks.set(entry.id, loopback);
  pc.onicecandidate = event => { if (event.candidate) sendSignal(entry.id, { kind: "ice", candidate: event.candidate.toJSON() }); };
  try {
    await tuneSender(sender, entry.kind);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(entry.id, { kind: "offer", sdp: offer.sdp ?? "" });
  } catch (error) {
    closeLoopback(entry.id);
    sendSignal(entry.id, { kind: "error", message: errorMessage(error) });
  }
}
async function handleSignal(id: string, incoming: TileSignal) {
  if (incoming.kind === "request") {
    let match: Tracked | undefined;
    for (const entry of tracked.values()) if (entry.id === id) { match = entry; break; }
    if (!match) { sendSignal(id, { kind: "error", message: "That video is no longer in the meeting." }); return; }
    await openLoopback(match);
    return;
  }
  const loopback = loopbacks.get(id);
  if (!loopback) return;
  if (incoming.kind === "answer") {
    await loopback.pc.setRemoteDescription({ type: "answer", sdp: boostVideoBitrate(incoming.sdp, START_BITRATE_KBPS) });
    loopback.remoteSet = true;
    for (const candidate of loopback.pending) await loopback.pc.addIceCandidate(candidate).catch(() => {});
    loopback.pending = [];
    // Re-apply now that negotiation filled in the real encodings.
    await tuneSender(loopback.sender, loopback.kind);
  } else if (incoming.kind === "ice") {
    if (loopback.remoteSet) await loopback.pc.addIceCandidate(incoming.candidate).catch(() => {}); else loopback.pending.push(incoming.candidate);
  } else if (incoming.kind === "close" || incoming.kind === "error") {
    closeLoopback(id);
  }
}
// Meet swaps tracks in place during renegotiation; keep the recording on the current one.
function syncLoopbackTracks() {
  for (const entry of tracked.values()) {
    const loopback = loopbacks.get(entry.id);
    if (!loopback) continue;
    const current = videoTrackOf(entry.video);
    if (!current || current === loopback.sourceTrack) continue;
    const clone = current.clone();
    void loopback.sender.replaceTrack(clone).then(
      () => { loopback.clone.stop(); loopback.clone = clone; loopback.sourceTrack = current; },
      () => clone.stop(),
    );
  }
}

// All selected tiles' previews live in one shared, draggable host so the whole stack moves
// together; each tile just gets its own box (canvas + label) inside it.
let previewHost: HTMLDivElement | undefined;
let previewStack: HTMLDivElement | undefined;
function ensurePreviewHost(): HTMLDivElement {
  if (previewHost && previewStack) return previewStack;
  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;right:16px;top:16px;z-index:2147483646";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${OVERLAY_CSS}
    .chassis{padding:6px;display:flex;flex-direction:column;gap:6px;width:max-content}
    .bar{display:flex;align-items:center;gap:6px;padding:2px 2px 0}
    .grip{width:22px;height:20px}
    .heading{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-muted);user-select:none}
    .stack{display:flex;flex-direction:column;gap:6px}
    .tile{position:relative;line-height:0}
    canvas{display:block;border-radius:9px;background:oklch(0 0 0)}
    .label{
      position:absolute;left:6px;bottom:6px;max-width:calc(100% - 12px);
      padding:3px 8px;border-radius:6px;background:oklch(0.165 0.013 245/.82);
      color:var(--ink);font:12px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    }
  </style>
  <div class="chassis">
    <div class="bar"><span class="grip" title="Drag to move" aria-label="Drag to move the preview">${GRIP_SVG}</span><span class="heading">Recording preview</span></div>
    <div class="stack"></div>
  </div>`;
  document.documentElement.append(host);
  previewHost = host; previewStack = shadow.querySelector<HTMLDivElement>(".stack")!;
  makeDraggable(shadow.querySelector(".grip")!, host, "gmrecPreviewPos");
  return previewStack;
}
function ensureTileOverlay(entry: Tracked) {
  if (entry.overlayCanvas) return;
  const stack = ensurePreviewHost();
  const box = document.createElement("div");
  box.className = "tile";
  box.innerHTML = `<canvas></canvas><div class="label"></div>`;
  stack.append(box);
  entry.overlayBox = box;
  entry.overlayCanvas = box.querySelector("canvas")!;
}
function teardownTileOverlay(entry: Tracked) {
  entry.overlayBox?.remove();
  entry.overlayBox = undefined;
  entry.overlayCanvas = undefined;
  if (previewStack && !previewStack.children.length) { previewHost?.remove(); previewHost = undefined; previewStack = undefined; }
}
function startOverlayLoop() {
  if (overlayRaf === undefined) overlayRaf = requestAnimationFrame(drawOverlay);
}
let lastPreviewDraw = 0;
// A small live preview of what is being recorded. Purely informational (recording no longer
// depends on it), so it is throttled to ~15 fps to stay cheap.
function drawOverlay(now: number) {
  overlayRaf = undefined;
  const selected = Array.from(tracked.values()).filter(entry => entry.selected);
  if (!selected.length) return;
  if (now - lastPreviewDraw >= 66) {
    lastPreviewDraw = now;
    const maxWidth = Math.max(1, Math.min(PREVIEW_MAX_WIDTH, innerWidth * 0.28));
    const maxHeight = Math.max(1, Math.min(PREVIEW_MAX_HEIGHT, innerHeight * 0.22));
    for (const entry of selected) {
      ensureTileOverlay(entry);
      const canvas = entry.overlayCanvas!;
      if (tileLive(entry) && entry.video.readyState >= 2 && entry.video.videoWidth) {
        const box = fitRect(entry.video.videoWidth, entry.video.videoHeight, maxWidth, maxHeight, "contain");
        const width = Math.max(1, Math.round(box.width)), height = Math.max(1, Math.round(box.height));
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        const ctx = canvas.getContext("2d")!;
        // Match the recording, which reproduces Meet's own mirroring for that tile.
        ctx.setTransform(entry.mirrored ? -1 : 1, 0, 0, 1, entry.mirrored ? width : 0, 0);
        ctx.drawImage(entry.video, 0, 0, width, height);
      } else {
        if (!canvas.width) { canvas.width = Math.round(maxWidth); canvas.height = Math.round(maxHeight); }
        const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      (entry.overlayBox!.querySelector(".label") as HTMLDivElement).textContent = labelFor(entry);
    }
  }
  overlayRaf = requestAnimationFrame(drawOverlay);
}
// Pinning asks the meeting to send a higher-quality stream for a tile, so it is worth doing —
// but it has to be done the way the product actually does it. A synthetic double-click on the
// tile does nothing in Google Meet; what works is pressing the same Pin control a person would,
// found by the aria-label the tile already exposes. Those labels are also what names are read
// from, so they are known to be present without hovering first.
const PIN_LABEL = /^pin\b/i;
const UNPIN_LABEL = /^(unpin\b|remove from screen\b)/i;
const PIN_CONTROLS = "button, [role='button'], [role='menuitem']";
// Don't press the same control over and over while a click is still being processed.
const PIN_COOLDOWN_MS = 1500;
function labelOf(node: Element): string {
  return (node.getAttribute("aria-label") ?? node.getAttribute("data-tooltip") ?? node.getAttribute("title") ?? "").trim();
}
// Deliberately the first match in the tile: a presentation gets a tile of its own, so one
// container never holds both "Pin Ada" and "Pin Ada's presentation". Preferring by tile kind
// would be circular anyway — detectKind calls any container carrying a presentation label a
// screen tile, so the kind is derived from the very labels it would be used to choose between.
function pinControl(entry: Tracked, pattern: RegExp): HTMLElement | null {
  const container = containerOf(entry.video);
  if (!container) return null;
  for (const node of deepQueryAll(container, PIN_CONTROLS)) {
    const label = labelOf(node);
    if (label && pattern.test(label)) return node as HTMLElement;
  }
  return null;
}
function anythingIsPinned(): boolean {
  return deepQueryAll(document, PIN_CONTROLS).some(node => UNPIN_LABEL.test(labelOf(node)));
}
// Meet spotlights exactly one tile, so GMRec remembers exactly one thing: the id of the tile it
// pinned, or nothing. Every other fact — whether that tile is still pinned, whether anything
// else is — is read back off the page on each scan instead of being remembered.
//
// That is the whole design. Three rounds of review found bugs in the previous version, and every
// one of them was remembered state drifting away from what the page actually showed: a pin
// claimed before the click landed, a claim dropped while the pin stayed, two tiles both believing
// they held the one pin Meet allows. State that is re-derived cannot drift.
let ourPin: string | null = null;
let pinCooldownUntil = 0;
// Recording stopped: give the view back, without forgetting what is selected.
let pinsSuspended = false;
// Three answers, not two. A tile whose container cannot be resolved — detached mid-re-render,
// or its id attribute not set yet — is unreadable, NOT unpinned. Collapsing those two is how a
// claim gets dropped while Meet is still pinned, which strands the pin for the rest of the call.
function pinStateOf(entry: Tracked): "pinned" | "unpinned" | "unknown" {
  if (!entry.video.isConnected || !containerOf(entry.video)) return "unknown";
  return pinControl(entry, UNPIN_LABEL) ? "pinned" : "unpinned";
}
function pinnedEntry(): Tracked | undefined {
  return ourPin ? Array.from(tracked.values()).find(entry => entry.id === ourPin) : undefined;
}
function reconcilePins() {
  // Only where a pin control is known to exist and to mean this. Elsewhere GMRec records what
  // the page already sends rather than pressing buttons it does not understand.
  if (!adapter.spotlight) return;
  try {
    // Nothing is read while a click is still settling: the label has not flipped yet, and taking
    // that at face value would mean concluding our own pin never happened.
    if (Date.now() < pinCooldownUntil) return;
    let owner = pinnedEntry();
    // The pin we took is genuinely gone — the user moved it, or the tile left the call. The slot
    // is free again, and there is nothing left to give back.
    if (ourPin && (!owner || pinStateOf(owner) === "unpinned")) { ourPin = null; owner = undefined; }
    // Give back a pin whose tile is no longer being recorded. ourPin stays set until the page
    // confirms it is released, so a click that does not land is simply tried again.
    if (ourPin && owner && (pinsSuspended || !owner.selected)) {
      const control = pinControl(owner, UNPIN_LABEL);
      if (!control) return;
      pinCooldownUntil = Date.now() + PIN_COOLDOWN_MS;
      control.click();
      return;
    }
    // Take the slot for a selected tile, but only when nothing at all is pinned: an existing pin
    // is the user's view of the call, and it is not ours to move.
    if (ourPin || pinsSuspended || anythingIsPinned()) return;
    const wanted = Array.from(tracked.values()).find(entry => entry.selected);
    const control = wanted && pinControl(wanted, PIN_LABEL);
    if (!wanted || !control) return;
    pinCooldownUntil = Date.now() + PIN_COOLDOWN_MS;
    control.click();
    ourPin = wanted.id; // optimistic; the next reconcile corrects it if the click did nothing
  } catch { /* Meet's DOM can change at any time; pinning is a quality aid, never required. */ }
}
// Hand the pin back before this script goes away, or it is stranded: the replacement starts with
// nothing tracked, so it reads the leftover pin as the user's and never pins again.
function releasePinNow() {
  const owner = pinnedEntry();
  if (owner) try { pinControl(owner, UNPIN_LABEL)?.click(); } catch { /* best effort */ }
  ourPin = null;
}
async function call(type: string, payload: object = {}): Promise<unknown> {
  const reply = await chrome.runtime.sendMessage({ target: "background", type, ...payload });
  if (!reply?.ok) throw new Error(reply && !reply.ok ? reply.error : "GMRec did not respond.");
  return reply.data;
}
type ControlBar = { host: HTMLDivElement; start: HTMLButtonElement; pause: HTMLButtonElement; stop: HTMLButtonElement; shot: HTMLButtonElement; live: HTMLSpanElement; timer: HTMLSpanElement; message: HTMLSpanElement };
let controlBar: ControlBar | undefined;
let barState: RecorderState = { phase: "idle", elapsedMs: 0 };
let barReadAt = Date.now();
function showBarMessage(text: string) {
  if (!controlBar) return;
  controlBar.message.textContent = text; controlBar.message.hidden = false;
  window.setTimeout(() => { if (controlBar) controlBar.message.hidden = true; }, 4000);
}
async function barAction(work: () => Promise<unknown>) {
  try { await work(); } catch (error) { showBarMessage(errorMessage(error)); }
}
// A small always-present control bar on the Meet page itself, so recording can be started,
// paused, stopped, or screenshotted without opening the extension popup.
function ensureControlBar(): ControlBar {
  if (controlBar) return controlBar;
  const host = document.createElement("div");
  // Bottom-right, not bottom-center: Meet's own call toolbar (mic/camera/leave) sits
  // bottom-center, and this bar must never sit on top of it.
  host.style.cssText = "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;font:13px system-ui";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${OVERLAY_CSS}
    .chassis{display:flex;align-items:center;gap:7px;padding:7px;border-radius:999px;width:max-content}
    .grip{width:20px;height:28px}
    /* Idle "Record" is a neutral pill with a red tally dot, the way a hardware record button
       reads. A large red pill near Meet's controls invites a hang-up misclick mid-call, and a
       red dot on the cyan accent measured only 2.1:1, so neither of those is an option. */
    .start{border-color:var(--accent)}
    .start .dot{background:var(--tally)}
    .live{display:flex;align-items:center;gap:8px;padding:0 4px 0 6px}
    .live .dot{animation:tally 2s var(--ease) infinite}
    .live[data-phase="paused"] .dot{background:var(--paused);animation:none}
    .timer{font-variant-numeric:tabular-nums;font-weight:600;letter-spacing:-.01em;min-width:60px}
    .msg{
      max-width:230px;padding:0 4px;color:var(--paused);font-size:12px;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    }
    @keyframes tally{0%,100%{opacity:1}50%{opacity:.3}}
  </style>
  <div class="chassis">
    <span class="grip" title="Drag to move" aria-label="Drag to move the controls">${GRIP_SVG}</span>
    <button class="start" type="button"><span class="dot"></span>Record</button>
    <span class="live" hidden><span class="dot"></span><span class="timer">00:00:00</span></span>
    <button class="pause" type="button" hidden>${PAUSE_SVG}Pause</button>
    <button class="stop danger" type="button" hidden>${STOP_SVG}Stop</button>
    <button class="shot" type="button" title="Save a still of each selected video">${SHOT_SVG}Still</button>
    <span class="msg" role="status" hidden></span>
  </div>`;
  document.documentElement.append(host);
  makeDraggable(shadow.querySelector(".grip")!, host, "gmrecBarPos");
  const bar: ControlBar = {
    host,
    start: shadow.querySelector(".start")!,
    pause: shadow.querySelector(".pause")!,
    stop: shadow.querySelector(".stop")!,
    shot: shadow.querySelector(".shot")!,
    live: shadow.querySelector(".live")!,
    timer: shadow.querySelector(".timer")!,
    message: shadow.querySelector(".msg")!,
  };
  bar.start.addEventListener("click", () => void barAction(async () => {
    const stored = await chrome.storage.local.get("settings");
    await call("start", { settings: stored.settings });
  }));
  bar.pause.addEventListener("click", () => void barAction(() => call(barState.phase === "paused" ? "resume" : "pause")));
  bar.stop.addEventListener("click", () => void barAction(() => call("stop")));
  bar.shot.addEventListener("click", () => void barAction(async () => {
    const count = await captureScreenshots();
    showBarMessage(count ? `Saved ${count} screenshot${count === 1 ? "" : "s"}.` : "Select a video to screenshot first.");
  }));
  controlBar = bar;
  return bar;
}
function renderControlBar() {
  const bar = ensureControlBar();
  const idle = barState.phase === "idle";
  const paused = barState.phase === "paused";
  bar.start.hidden = !idle;
  bar.pause.hidden = idle; bar.stop.hidden = idle; bar.live.hidden = idle;
  bar.live.dataset.phase = barState.phase;
  bar.start.disabled = barState.phase === "starting";
  bar.pause.disabled = ["starting", "stopping"].includes(barState.phase);
  bar.stop.disabled = bar.pause.disabled;
  // Static markup; swaps the icon along with the label so the two never disagree.
  bar.pause.innerHTML = paused ? `${PLAY_SVG}Resume` : `${PAUSE_SVG}Pause`;
  bar.pause.setAttribute("aria-label", paused ? "Resume recording" : "Pause recording");
  if (barState.warning && barState.warning !== lastBarWarning) showBarMessage(barState.warning);
  lastBarWarning = barState.warning ?? "";
}
let lastBarWarning = "";
window.setInterval(() => {
  if (!controlBar || controlBar.live.hidden) return;
  const elapsed = barState.elapsedMs + (barState.phase === "recording" ? Date.now() - barReadAt : 0);
  controlBar.timer.textContent = formatTime(elapsed);
}, 250);
function setSelected(id: string, on: boolean): boolean {
  let match: Tracked | undefined;
  for (const entry of tracked.values()) if (entry.id === id) { match = entry; break; }
  if (!match || match.selected === on) return !!match;
  match.selected = on;
  if (on) {
    pinsSuspended = false;
    reconcilePins();
    startOverlayLoop();
    if (active) void chrome.runtime.sendMessage({ target: "background", type: "add-tile", tile: { id: match.id, label: labelFor(match), kind: match.kind, mirrored: match.mirrored } }).catch(() => {});
  } else {
    reconcilePins();
    teardownTileOverlay(match);
    if (active) void chrome.runtime.sendMessage({ target: "background", type: "remove-tile", id }).catch(() => {});
  }
  return true;
}
// A new screen share appearing mid-recording is easy to miss; ask once whether to add it.
function promptForScreenShare(entry: Tracked) {
  if (promptForId || dismissedScreenIds.has(entry.id)) return;
  promptForId = entry.id;
  const host = document.createElement("div");
  // Top-left, not top-center: the preview stack anchors top-right, and a narrow window could
  // otherwise overlap a centered prompt with it.
  host.style.cssText = "all:initial;position:fixed;top:16px;left:16px;z-index:2147483647";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `<style>${OVERLAY_CSS}
    .chassis{display:flex;align-items:center;gap:10px;max-width:400px;padding:10px 10px 10px 14px}
    .icon{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;flex-shrink:0;
      background:oklch(0.8 0.125 195/.16);color:var(--accent)}
    .icon svg{width:17px;height:17px}
    .copy{flex:1;min-width:0}
    .copy strong{display:block;font-weight:600}
    .copy span{color:var(--ink-muted);font-size:12px}
  </style>
  <div class="chassis">
    <span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3.5" width="20" height="14" rx="2.5"/><path d="M8.5 21h7M12 17.5V21"/></svg></span>
    <span class="copy"><strong>Screen share started</strong><span>Record it as its own file?</span></span>
    <button class="add primary" type="button">Add</button>
    <button class="ignore" type="button">Ignore</button>
  </div>`;
  document.documentElement.append(host);
  promptHost = host;
  const done = () => { host.remove(); if (promptHost === host) promptHost = undefined; if (promptForId === entry.id) promptForId = undefined; };
  shadow.querySelector(".add")!.addEventListener("click", () => { setSelected(entry.id, true); done(); });
  shadow.querySelector(".ignore")!.addEventListener("click", () => { dismissedScreenIds.add(entry.id); done(); });
  window.setTimeout(() => { if (promptForId === entry.id) { dismissedScreenIds.add(entry.id); done(); } }, 20000);
}
function scan() {
  const current = new Set<HTMLVideoElement>();
  refreshAdapter();
  for (const video of deepVideos()) {
    if (!video.isConnected) continue;
    current.add(video);
    const existing = tracked.get(video);
    // Meet routinely swaps a tile's underlying stream in place (renegotiation, simulcast layer
    // changes) without removing the element. Update in place rather than dropping the tracked
    // tile: dropping it would silently lose the user's selection and hand out a new id.
    if (existing && existing.source !== video.srcObject) existing.source = video.srcObject;
    // Meet often mounts a tile before its name label, so keep retrying until a real name shows
    // up. Once one is found it sticks, rather than walking the subtree on every tick forever.
    if (existing && NUMBERED_LABEL.test(existing.label)) existing.label = resolveLabel(existing);
    if (existing || !isVisibleVideo(video)) continue;
    const kind = detectKind(video);
    const key = tileKey(video, kind);
    // Same participant, new element: rebind the existing tile so its id, selection and any
    // running recording carry over instead of a duplicate appearing in the list.
    const previous = key ? Array.from(tracked.values()).find(entry => entry.key === key) : undefined;
    if (previous) {
      tracked.delete(previous.video);
      previous.missingSince = undefined;
      previous.video = video;
      previous.source = video.srcObject;
      previous.mirrored = isMirrored(video);
      previous.label = resolveLabel(previous);
      tracked.set(video, previous);
      continue;
    }
    const entry: Tracked = { video, id: newId(video), ordinal: idCounter, kind, selected: false, mirrored: isMirrored(video), key, label: "", source: video.srcObject };
    entry.label = resolveLabel(entry);
    tracked.set(video, entry);
    if (active && kind === "screen") promptForScreenShare(entry);
  }
  for (const [video, entry] of tracked) {
    // A tile counts as alive while its element is in the DOM and either selected or still
    // carrying video; unselected leftovers with a dead track are pruned so switching cameras
    // cannot pile up stale entries.
    if (current.has(video) && (entry.selected || videoTrackOf(video))) { entry.missingSince = undefined; continue; }
    // Meet removes the old element before the replacement is ready, so a vanished tile is held
    // briefly: that window is what lets the same participant rebind instead of duplicating.
    entry.missingSince ??= Date.now();
    if (Date.now() - entry.missingSince < REBIND_GRACE_MS) continue;
    // A tile vanishing for good (someone leaving) must not end its file. The recorder keeps it
    // running until Stop.
    closeLoopback(entry.id);
    teardownTileOverlay(entry);
    tracked.delete(video);
  }
  // Every scan, not just on select: this is what makes the pin self-correcting. A click that
  // did not land, a pin the user moved, a tile that went away mid-flight — all of it is noticed
  // here and put right, because the page is the source of truth rather than a remembered flag.
  reconcilePins();
  syncLoopbackTracks();
}
const listener: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (message, _sender, respond) => {
  if (message?.target !== "content") return;
  if (message.type === "selection") { scan(); respond(getSelections()); return; }
  if (message.type === "tiles") { scan(); respond(getDetectedTiles()); return; }
  if (message.type === "select") { respond(setSelected(message.id, !!message.on)); return; }
  if (message.type === "screenshot") { void captureScreenshots().then(respond); return true; }
  if (message.type === "tile-signal") { void handleSignal(message.id, message.signal).catch(error => sendSignal(message.id, { kind: "error", message: errorMessage(error) })); respond(null); return; }
  if (message.type === "state") {
    const state = message.state as RecorderState;
    const wasActive = active;
    active = state.phase !== "idle";
    barState = state; barReadAt = Date.now();
    renderControlBar();
    if (!active && wasActive) {
      pinsSuspended = true;
      reconcilePins();
      for (const id of Array.from(loopbacks.keys())) closeLoopback(id);
    }
    respond(null);
    return;
  }
};
chrome.runtime.onMessage.addListener(listener);
ensureControlBar();
scan();
const interval = window.setInterval(scan, 500);
scope.__gmrecDispose = () => {
  clearInterval(interval);
  chrome.runtime.onMessage.removeListener(listener);
  if (overlayRaf !== undefined) cancelAnimationFrame(overlayRaf);
  for (const id of Array.from(loopbacks.keys())) closeLoopback(id);
  // Give the pin back first, or the replacement script reads it as the user's and never pins.
  releasePinNow();
  for (const entry of tracked.values()) teardownTileOverlay(entry);
  tracked.clear();
  previewHost?.remove();
  promptHost?.remove();
  controlBar?.host.remove();
};
void chrome.runtime.sendMessage({ target: "background", type: "status" }).then(reply => {
  if (reply?.ok) { active = reply.data.phase !== "idle"; barState = reply.data; barReadAt = Date.now(); renderControlBar(); }
}).catch(() => {});
