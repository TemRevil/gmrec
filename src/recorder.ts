import type { RecorderState, RecordingConfig, Reply, SavedRecording, TileSignal } from "./types";
import { errorMessage, fitRect, safeName, validSelection } from "./shared";
import { appendChunk, deleteRecording, listRecordings, readRecording, saveMetadata } from "./storage";

type Output = { recorder: MediaRecorder; record: SavedRecording; writes: Promise<void>; done: Promise<void>; failed: boolean; tileId?: string; normalized?: Normalized; startOffsetMs: number; durationMs?: number };
type Normalized = { track: MediaStreamTrack; stop: () => void };
// One loopback RTCPeerConnection per recorded tile. The Meet content script owns the real
// participant tracks and streams each one here over a local WebRTC connection, so the
// recorder encodes the native stream directly instead of screen-cropping the page.
type Loopback = { pc: RTCPeerConnection; pending: RTCIceCandidateInit[]; remoteSet: boolean; timer?: number; resolve?: (stream: MediaStream) => void; reject?: (error: Error) => void };
let outputs: Output[] = [];
let streams: MediaStream[] = [];
const loopbacks = new Map<string, Loopback>();
let audio: AudioContext | undefined;
let phase: RecorderState["phase"] = "idle";
let tabId: number | undefined;
let startedAt = 0;
let pausedAt = 0;
let pausedMs = 0;
let finalElapsed = 0;
let warning = "";
let operations: Promise<unknown> = Promise.resolve();
const urls = new Set<string>();
let activeConfig: RecordingConfig | undefined;
let activeSession = "";
let activeMimeType = "";
let tabStreamRef: MediaStream | undefined;
// Tab audio and the microphone mixed together, so a participant file contains both sides of the
// conversation. Meet never plays your own voice back into the tab, so without this you are
// simply missing from every recording except your own camera file.
let mixedAudio: MediaStream | undefined;
// Kept alive for the length of the recording; a garbage-collected node stops passing audio.
let audioBridges: MediaStreamAudioDestinationNode[] = [];
const usedKinds = new Set<string>();
// MP4 first, and not only because it is the more portable container: a MediaRecorder WebM ships
// with no duration and no cues, so players report it as an endless live stream and cannot seek
// it. Chrome's MP4 muxer writes a proper header on stop, giving a real duration, working seeking
// and roughly half the size at the same bitrate. WebM stays as a fallback for older Chrome.
// Ask for H.264 High profile explicitly. Left to choose, Chrome writes Baseline (profile 66),
// which has no CABAC or B-frames and is visibly worse at the same bitrate; requesting High
// gives profile 100 with Chrome still picking an appropriate level. AAC is named for the same
// reason: plain "video/mp4" pairs the video with Opus, which fewer editors accept.
const VIDEO_TYPES = [
  "video/mp4;codecs=avc1.640028,mp4a.40.2",
  "video/mp4;codecs=avc1.64001F,mp4a.40.2",
  "video/mp4;codecs=avc1.4D401F,mp4a.40.2",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];
const AUDIO_TYPES = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
function extensionFor(mimeType: string): string {
  if (mimeType.startsWith("audio/mp4")) return "m4a";
  if (mimeType.startsWith("video/mp4")) return "mp4";
  return "webm";
}

function uniqueKind(label: string): string {
  const base = safeName(label) || "tile";
  let kind = base, n = 2;
  while (usedKinds.has(kind)) kind = `${base}-${n++}`;
  usedKinds.add(kind);
  return kind;
}
function state(): RecorderState {
  return { phase, tabId, warning, elapsedMs: phase === "idle" || phase === "stopping" ? finalElapsed : startedAt ? Math.max(0, (pausedAt || Date.now()) - startedAt - pausedMs) : 0 };
}
async function background<T>(type: string, payload: object = {}): Promise<T> {
  const reply: Reply<T> = await chrome.runtime.sendMessage({ target: "background", type, ...payload });
  if (!reply?.ok) throw new Error(reply && !reply.ok ? reply.error : "GMRec background did not respond.");
  return reply.data;
}
function publish() { void background("state-changed", { state: state() }).catch(console.error); }
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const next = operations.then(work, work);
  operations = next.catch(() => {});
  return next;
}
function fail(reason: string) {
  warning = reason;
  publish();
  void enqueue(() => stopRecording(reason)).catch(console.error);
}
async function acquire(constraints: MediaStreamConstraints, source = "devices"): Promise<MediaStream> {
  // Release even a late permission result, after the UI has already reported a timeout.
  let expired = false;
  let timer: number | undefined;
  try {
    const stream = await Promise.race([
      navigator.mediaDevices.getUserMedia(constraints).then(stream => {
        if (expired) { stream.getTracks().forEach(track => track.stop()); throw new Error("Device request expired."); }
        return stream;
      }),
      new Promise<never>((_, reject) => { timer = window.setTimeout(() => { expired = true; reject(new Error("Device access timed out. Open Device setup to grant access before recording.")); }, 15000); }),
    ]);
    streams.push(stream);
    return stream;
  } catch (error) {
    if (source === "tab") throw new Error(`Could not capture the meeting tab: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}. Return to the meeting, click the GMRec toolbar icon, and try again.`);
    throw error;
  } finally { window.clearTimeout(timer); }
}
function signal(id: string, signal: TileSignal) {
  void background("tile-signal", { tabId, id, signal }).catch(console.error);
}
function closeLoopback(id: string, notify = true) {
  const entry = loopbacks.get(id);
  if (!entry) return;
  loopbacks.delete(id);
  window.clearTimeout(entry.timer);
  entry.pc.onicecandidate = null; entry.pc.ontrack = null;
  entry.pc.close();
  if (notify) signal(id, { kind: "close" });
}
function requestTileStream(id: string): Promise<MediaStream> {
  closeLoopback(id);
  return new Promise((resolve, reject) => {
    const pc = new RTCPeerConnection();
    const entry: Loopback = { pc, pending: [], remoteSet: false, resolve, reject };
    entry.timer = window.setTimeout(() => { closeLoopback(id); reject(new Error("Timed out waiting for the video stream from Meet.")); }, 12000);
    loopbacks.set(id, entry);
    pc.onicecandidate = event => { if (event.candidate) signal(id, { kind: "ice", candidate: event.candidate.toJSON() }); };
    pc.ontrack = event => {
      // A tile can carry that participant's audio as well, so ontrack fires more than once.
      // Both tracks share one stream; wait for the video one before handing it over.
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      if (!stream.getVideoTracks().length) return;
      window.clearTimeout(entry.timer); entry.timer = undefined;
      resolve(stream);
    };
    signal(id, { kind: "request" });
  });
}
async function handleSignal(id: string, incoming: TileSignal) {
  const entry = loopbacks.get(id);
  if (!entry) return;
  if (incoming.kind === "offer") {
    await entry.pc.setRemoteDescription({ type: "offer", sdp: incoming.sdp });
    entry.remoteSet = true;
    for (const candidate of entry.pending) await entry.pc.addIceCandidate(candidate).catch(() => {});
    entry.pending = [];
    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    signal(id, { kind: "answer", sdp: answer.sdp ?? "" });
  } else if (incoming.kind === "ice") {
    if (entry.remoteSet) await entry.pc.addIceCandidate(incoming.candidate).catch(() => {}); else entry.pending.push(incoming.candidate);
  } else if (incoming.kind === "error") {
    closeLoopback(id, false);
    entry.reject?.(new Error(incoming.message));
  } else if (incoming.kind === "close") {
    closeLoopback(id, false);
    entry.reject?.(new Error("Meet closed the video stream."));
  }
}
async function createOutput(stream: MediaStream, kind: string, config: RecordingConfig, session: string, mimeType: string): Promise<Output> {
  // Just the name: the folder already carries the meeting and its date, so repeating them
  // in every file only makes the folder harder to read.
  const video = stream.getVideoTracks().length > 0;
  const record: SavedRecording = {
    id: crypto.randomUUID(), filename: `${kind}.${extensionFor(mimeType)}`, folder: config.folder, createdAt: Date.now(),
    mimeType, kind, bytes: 0, chunks: 0, status: "recording", saveAs: config.askWhereToSave,
    ...(video ? { width: config.width, height: config.height } : {}),
  };
  // Generous bitrates: these files are local, and re-encoding what Meet sent should not be
  // where the quality is lost.
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: config.height === 720 ? 6_000_000 : 12_000_000, audioBitsPerSecond: 192_000 });
  await saveMetadata(record);
  let resolveDone!: () => void;
  // Where this file begins on the session timeline, so its own duration can be stated exactly
  // even for a tile that was ticked on halfway through.
  const output: Output = { recorder, record, writes: Promise.resolve(), done: new Promise(resolve => { resolveDone = resolve; }), failed: false, startOffsetMs: state().elapsedMs };
  recorder.ondataavailable = event => {
    if (!event.data.size || output.failed) return;
    output.writes = output.writes.then(() => appendChunk(record, event.data)).catch(error => {
      output.failed = true;
      fail(`Local recording storage failed: ${errorMessage(error)}. Only previously saved chunks may be recoverable.`);
    });
  };
  recorder.onstop = resolveDone;
  recorder.onerror = () => { output.failed = true; fail("The media encoder failed. Available data will be kept in Saved recordings."); };
  return output;
}
// WebRTC keeps adapting resolution while it runs: a real recording stepped 320x180 -> 480x270
// -> 640x360 -> 960x540. A WebM whose frames change size while its header declares one size
// plays back at the wrong aspect and flashes black in stricter players such as VLC. Drawing
// every frame into one fixed-size canvas gives the file exactly one resolution end to end.
// The same pass reproduces the page's mirroring, which keeps all canvas work out of that tab.
function normalizeTrack(track: MediaStreamTrack, width: number, height: number, fps: number, mirrored: boolean): Normalized {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  // No alpha and desynchronised: this canvas is never composited on screen, and the cost of
  // every normalised frame is paid alongside the encoders in the same document.
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true })!;
  const stream = canvas.captureStream(0);
  const output = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  // Frames are pulled straight off the track rather than through a <video> element: an offscreen
  // document is never rendered, so a <video> there does not reliably decode an incoming WebRTC
  // track, which produced files with no presentable frames at all. This is also frame-driven,
  // so it neither duplicates nor drops frames the way a timer would.
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  let stopped = false;
  let lastFrameAt = performance.now();
  let blanked = false;
  // The canvas is emitted on a steady clock rather than per incoming frame. If a participant
  // turns their camera off, mutes, drops, or Meet renegotiates, frames simply stop arriving —
  // the file keeps running (black after a couple of seconds) instead of ending or gaining a gap.
  const pulse = window.setInterval(() => {
    if (stopped) return;
    if (!blanked && performance.now() - lastFrameAt > 2000) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);
      blanked = true;
    }
    output.requestFrame();
  }, 1000 / fps);
  void (async () => {
    while (!stopped) {
      const { value: frame, done } = await reader.read();
      if (done || !frame) break;
      try {
        lastFrameAt = performance.now();
        blanked = false;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const box = fitRect(frame.displayWidth, frame.displayHeight, width, height, "contain");
        // Only repaint the background when the frame does not cover the canvas; a full-surface
        // fill on every frame is pure waste in the common case of a matching aspect ratio.
        if (box.x > 0.5 || box.y > 0.5) { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, height); }
        // The fit is centred, so the mirrored draw lands in the same place.
        if (mirrored) ctx.setTransform(-1, 0, 0, 1, width, 0);
        ctx.drawImage(frame, box.x, box.y, box.width, box.height);
      } finally { frame.close(); }
    }
  })().catch(() => { /* the source ended; the pulse keeps the file running until Stop */ });
  return {
    track: output,
    stop: () => { stopped = true; window.clearInterval(pulse); void reader.cancel().catch(() => {}); output.stop(); },
  };
}
async function createTileOutput(tile: { id: string; label: string; kind?: string; mirrored?: boolean }, stream: MediaStream): Promise<Output> {
  const config = activeConfig!;
  const source = stream.getVideoTracks()[0];
  const normalized = normalizeTrack(source, config.width, config.height, config.fps, !!tile.mirrored);
  // That participant's own audio when Meet exposed it, otherwise the meeting's shared tab audio.
  // The microphone is deliberately NOT mixed in here: your voice belongs in your own file.
  // A remote WebRTC audio track delivers no samples until something consumes it, and handing an
  // idle track to MediaRecorder stalls the muxer and yields a zero-byte file, so it is pumped
  // through an AudioContext (to a stream, never to the speakers) first.
  const ownAudio = stream.getAudioTracks();
  let audioTracks = tabStreamRef?.getAudioTracks() ?? [];
  if (ownAudio.length) {
    audio ??= new AudioContext();
    await audio.resume().catch(() => {});
    const bridge = audio.createMediaStreamDestination();
    audio.createMediaStreamSource(new MediaStream(ownAudio)).connect(bridge);
    audioBridges.push(bridge);
    audioTracks = bridge.stream.getAudioTracks();
  }
  const output = await createOutput(new MediaStream([normalized.track, ...audioTracks]), uniqueKind(tile.label), config, activeSession, activeMimeType);
  output.tileId = tile.id;
  output.normalized = normalized;
  output.record.label = tile.label;
  output.record.kind = tile.kind === "screen" ? "screen share" : "participant camera";
  // Deliberately no "ended" handler: a camera switching off or a participant dropping must not
  // finalise their file. It keeps recording until Stop, so one timeline covers the whole meeting.
  return output;
}
async function finishOutput(output: Output) {
  if (output.recorder.state !== "inactive") output.recorder.stop();
  await output.done;
  await output.writes;
  output.record.status = output.failed ? "interrupted" : "ready";
  output.durationMs = Math.max(0, finalElapsed || state().elapsedMs) - output.startOffsetMs;
  await saveMetadata(output.record);
  output.normalized?.stop();
  if (output.tileId) closeLoopback(output.tileId);
}
async function cleanup() {
  for (const id of Array.from(loopbacks.keys())) closeLoopback(id);
  for (const stream of streams) for (const track of stream.getTracks()) track.stop();
  streams = [];
  await audio?.close().catch(() => {});
  audio = undefined;
  for (const output of outputs) output.normalized?.stop();
  audioBridges = [];
  activeConfig = undefined; tabStreamRef = undefined; mixedAudio = undefined; usedKinds.clear();
}
async function startRecording(config: RecordingConfig, tabStreamId: string) {
  if (phase !== "idle") throw new Error("A recording is already active.");
  if (!validSelection(config.selection)) throw new Error("Select at least one participant or screen share to record.");
  phase = "starting"; tabId = config.tabId; startedAt = 0; finalElapsed = 0; pausedAt = 0; pausedMs = 0; warning = "";
  outputs = []; usedKinds.clear();
  publish();
  try {
    const mimeType = VIDEO_TYPES.find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("This browser cannot record video. Use Chrome 120 or newer.");
    const constraints = { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: tabStreamId } } as MediaTrackConstraints;
    const tabStream = await acquire({ audio: constraints, video: constraints }, "tab");
    // Only Meet's audio is needed from tab capture; drop its video track right away so the
    // browser never spends CPU producing full-page frames.
    tabStream.getVideoTracks().forEach(track => { track.stop(); tabStream.removeTrack(track); });
    let selfStream: MediaStream | undefined;
    if (config.includeSelf) {
      selfStream = await acquire({
        video: { ...(config.cameraDeviceId === "default" ? {} : { deviceId: { exact: config.cameraDeviceId } }), width: { ideal: config.width }, height: { ideal: config.height }, frameRate: { ideal: config.fps, max: config.fps } },
        audio: { ...(config.microphoneDeviceId === "default" ? {} : { deviceId: { exact: config.microphoneDeviceId } }), echoCancellation: true, noiseSuppression: true },
      });
    }
    // Tab capture stops normal playback, so Meet's audio is routed back to the speakers, and
    // separately mixed with the microphone for the participant files.
    if (tabStream.getAudioTracks().length || selfStream?.getAudioTracks().length) {
      audio = new AudioContext();
      const mix = audio.createMediaStreamDestination();
      if (tabStream.getAudioTracks().length) {
        const tabAudio = audio.createMediaStreamSource(tabStream);
        tabAudio.connect(mix);
        tabAudio.connect(audio.destination);
      }
      mixedAudio = mix.stream;
      await audio.resume();
    }
    activeConfig = config; activeSession = new Date().toISOString().replace(/[:.]/g, "-"); activeMimeType = mimeType; tabStreamRef = tabStream;
    const results = await Promise.allSettled(config.selection.tiles.map(async tile => ({ tile, stream: await requestTileStream(tile.id) })));
    const received = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    const failures = results.flatMap(result => result.status === "rejected" ? [errorMessage(result.reason)] : []);
    if (!received.length) throw new Error(`Could not receive any participant video from Meet: ${failures[0] ?? "unknown error"}`);
    if (failures.length) warning = `${failures.length} selected video${failures.length === 1 ? "" : "s"} could not be captured: ${failures[0]}`;
    for (const { tile, stream } of received) outputs.push(await createTileOutput(tile, stream));
    if (selfStream) {
      const self = await createOutput(selfStream, "self", config, activeSession, mimeType);
      self.record.kind = "your camera and microphone";
      self.record.label = "You";
      outputs.push(self);
    }
    // Audio-only copy of the entire meeting (everyone plus your microphone). Small, and the
    // thing to fall back on if any individual video file is unusable.
    if (mixedAudio?.getAudioTracks().length) {
      const audioMime = AUDIO_TYPES.find(type => MediaRecorder.isTypeSupported(type)) ?? mimeType;
      const backup = await createOutput(new MediaStream(mixedAudio.getAudioTracks()), "meeting-audio", config, activeSession, audioMime);
      backup.record.kind = "whole-meeting audio backup";
      outputs.push(backup);
    }
    // A disconnected source used to stop everything. Now it is reported and the recording runs
    // on, so one lost device cannot cost the whole session.
    for (const stream of [tabStream, ...(selfStream ? [selfStream] : [])]) {
      for (const track of stream.getTracks()) track.addEventListener("ended", () => {
        if (phase !== "recording" && phase !== "paused") return;
        warning = "A capture source disconnected. Recording continues; press Stop when you are done.";
        publish();
      }, { once: true });
    }
    for (const output of outputs) output.recorder.start(1000);
    startedAt = Date.now(); phase = "recording";
    publish();
    return state();
  } catch (error) {
    for (const output of outputs) {
      if (output.recorder.state !== "inactive") { output.recorder.stop(); await output.done; }
      await output.writes;
      output.record.status = "interrupted";
      await saveMetadata(output.record).catch(console.error);
    }
    await cleanup(); outputs = []; phase = "idle"; warning = errorMessage(error); publish();
    throw error;
  }
}
async function addTile(tile: { id: string; label: string }) {
  if ((phase !== "recording" && phase !== "paused") || !activeConfig || !tabStreamRef) return;
  if (outputs.some(output => output.tileId === tile.id)) return;
  try {
    const stream = await requestTileStream(tile.id);
    if (phase !== "recording" && phase !== "paused") { closeLoopback(tile.id); return; }
    const output = await createTileOutput(tile, stream);
    outputs.push(output);
    output.recorder.start(1000);
    if (phase === "paused") output.recorder.pause();
  } catch (error) { warning = `Could not add ${tile.label}: ${errorMessage(error)}`; }
  publish();
}
async function removeTile(id: string) {
  const index = outputs.findIndex(output => output.tileId === id);
  if (index === -1) { closeLoopback(id); return; }
  const [output] = outputs.splice(index, 1);
  try { await finishOutput(output); }
  catch (error) { warning = `Finalization failed for a removed recording: ${errorMessage(error)}`; }
  publish();
}
async function download(id: string) {
  if (outputs.some(output => output.record.id === id) && phase !== "idle") throw new Error("Stop this recording before downloading it.");
  const { record, blob } = await readRecording(id);
  const url = URL.createObjectURL(blob);
  urls.add(url);
  const target = record.folder ? `${record.folder}/${record.filename}` : record.filename;
  try { return await background<number>("download", { url, filename: target, saveAs: record.saveAs === true }); }
  catch (error) { URL.revokeObjectURL(url); urls.delete(url); throw error; }
}
// Chrome's MediaRecorder writes no udta/meta boxes and exposes no API to add any, so the
// details that cannot live inside the MP4 (who is in it, which meeting, which tile) are written
// beside the files instead. Everything the container does carry — creation time, duration,
// resolution, codec — stays in the file itself; this repeats it so one read describes the session.
function describeCodecs(mimeType: string): { container: string; video?: string; audio?: string } {
  const container = mimeType.split(";")[0];
  const codecs = /codecs=([^;]+)/.exec(mimeType)?.[1].replace(/"/g, "").split(",") ?? [];
  const profiles: Record<string, string> = { "42": "Baseline", "4d": "Main", "58": "Extended", "64": "High" };
  const out: { container: string; video?: string; audio?: string } = { container };
  for (const codec of codecs) {
    const avc = /^avc1\.(\w{2})\w{2}(\w{2})$/i.exec(codec);
    if (avc) out.video = `H.264 ${profiles[avc[1].toLowerCase()] ?? `profile 0x${avc[1]}`} profile, level ${parseInt(avc[2], 16) / 10}`;
    else if (/^avc1/i.test(codec)) out.video = "H.264";
    else if (/^vp8|^vp9|^av01/i.test(codec)) out.video = codec.toUpperCase();
    else if (/^mp4a/i.test(codec)) out.audio = "AAC-LC";
    else if (/^opus/i.test(codec)) out.audio = "Opus";
  }
  return out;
}
async function writeManifest(finished: Output[], config: RecordingConfig) {
  const saved = finished.filter(output => output.record.bytes > 0);
  if (!saved.length) return;
  const startedIso = new Date(startedAt || Date.now()).toISOString();
  const manifest = {
    application: `GMRec ${chrome.runtime.getManifest?.().version ?? ""}`.trim(),
    meeting: { name: config.meeting.title || "", url: config.meeting.url || "", folder: config.folder },
    savedTo: config.askWhereToSave ? "chosen per file in Chrome's Save-as dialog" : `Downloads/${config.folder}`,
    session: {
      id: activeSession,
      startedAt: startedIso,
      endedAt: new Date().toISOString(),
      recordedSeconds: Math.round(finalElapsed / 1000),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    encoding: {
      ...describeCodecs(activeMimeType),
      frameRate: config.fps,
      videoBitrate: config.height === 720 ? 6_000_000 : 12_000_000,
      audioBitrate: 192_000,
    },
    files: saved.map(output => ({
      file: output.record.filename,
      source: output.record.kind ?? output.record.filename.replace(/\.[^.]+$/, ""),
      name: output.record.label ?? null,
      startsAtSecond: Math.round(output.startOffsetMs / 1000),
      durationSeconds: Math.round((output.durationMs ?? 0) / 1000),
      width: output.record.width ?? null,
      height: output.record.height ?? null,
      bytes: output.record.bytes,
      mimeType: output.record.mimeType,
      complete: output.record.status === "ready",
    })),
    note: "Times are wall-clock; paused time is excluded from both the timeline and the files.",
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }));
  urls.add(url);
  try { await background<number>("download", { url, filename: `${config.folder}/recording-info.json`, saveAs: config.askWhereToSave }); }
  catch { URL.revokeObjectURL(url); urls.delete(url); }
}
async function stopRecording(reason?: string) {
  if (phase === "idle") return state();
  const config = activeConfig; // cleanup() clears it, and the manifest is written afterwards.
  finalElapsed = state().elapsedMs;
  phase = "stopping";
  if (reason) warning = reason;
  publish();
  const finished = outputs;
  try { await Promise.all(finished.map(finishOutput)); }
  catch (error) { warning = `Finalization failed: ${errorMessage(error)}. Check Saved recordings for recoverable data.`; }
  finally { await cleanup(); outputs = []; }
  // A manifest is a convenience beside the recordings; never let it hold up their download.
  if (config) await writeManifest(finished, config).catch(() => {});
  for (const output of finished) {
    if (!output.record.bytes) continue;
    try { await download(output.record.id); }
    catch (error) { warning = `Download could not start: ${errorMessage(error)}. Retry from Saved recordings.`; }
  }
  phase = "idle";
  publish();
  return state();
}
async function handle(message: any) {
  if (message.type === "start") return startRecording(message.config, message.tabStreamId);
  if (message.type === "stop") return stopRecording(message.reason);
  if (message.type === "pause" || message.type === "resume") {
    const pausing = message.type === "pause";
    if (phase !== "recording" && phase !== "paused") throw new Error("No recording is active.");
    if (pausing && phase === "recording") {
      outputs.forEach(output => output.recorder.pause()); pausedAt = Date.now(); phase = "paused";
    } else if (!pausing && phase === "paused") {
      outputs.forEach(output => output.recorder.resume()); pausedMs += Date.now() - pausedAt; pausedAt = 0; phase = "recording";
    }
    publish(); return state();
  }
  if (message.type === "save") return download(message.id);
  if (message.type === "delete") {
    if (outputs.some(output => output.record.id === message.id)) throw new Error("Stop the recording before removing its local copy.");
    await deleteRecording(message.id); return null;
  }
  throw new Error("Unknown recorder command.");
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== "recorder" || sender.id !== chrome.runtime.id || sender.tab || (sender.url && sender.url !== chrome.runtime.getURL("background.js"))) return;
  let work: Promise<unknown>;
  if (message.type === "status") {
    work = Promise.resolve(state());
  } else if (message.type === "tile-signal") {
    work = handleSignal(message.id, message.signal).then(() => null);
  } else if (message.type === "add-tile") {
    work = enqueue(() => addTile(message.tile)).then(() => null);
  } else if (message.type === "remove-tile") {
    work = enqueue(() => removeTile(message.id)).then(() => null);
  } else if (message.type === "release") {
    if (urls.delete(message.url)) URL.revokeObjectURL(message.url);
    work = Promise.resolve(null);
  } else if (message.type === "list") {
    work = listRecordings().then(records => records.map(record => ({ ...record, status: record.status === "recording" && !outputs.some(output => output.record.id === record.id) ? "interrupted" : record.status })));
  } else { work = enqueue(() => handle(message)); }
  void work.then(data => respond({ ok: true, data }), error => respond({ ok: false, error: errorMessage(error) }));
  return true;
});
