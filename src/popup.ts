import type { DetectedTile, RecorderState, SavedRecording, Settings } from "./types";
import { defaults, errorMessage, formatTime, meetingFolder, normalizeSettings, normalizeSite, siteLabel } from "./shared";
import { createSelect, element, initTheme, send } from "./client";

const status = element<HTMLParagraphElement>("status");
const warning = element<HTMLParagraphElement>("warning");
const start = element<HTMLButtonElement>("start");
const stop = element<HTMLButtonElement>("stop");
const pause = element<HTMLButtonElement>("pause");
const tileList = element<HTMLDivElement>("tileList");
const tileCount = element<HTMLSpanElement>("tileCount");
const includeSelf = element<HTMLInputElement>("includeSelf");
const name = element<HTMLInputElement>("name");
const saveFolder = element<HTMLInputElement>("saveFolder");
const askWhereToSave = element<HTMLInputElement>("askWhereToSave");
const siteInput = element<HTMLInputElement>("siteInput");
let settings: Settings = { ...defaults };
const qualitySelect = createSelect(element("qualitySelect"), [{ value: "720p", label: "720p · 30 fps (recommended)" }, { value: "1080p", label: "1080p · 30 fps" }], settings.quality, value => { settings = normalizeSettings({ ...settings, quality: value as Settings["quality"] }); void chrome.storage.local.set({ settings }).catch(showError); });
// Disabled until stored settings finish loading (see `initialized` below), so an early click
// can never be silently overwritten once that async read resolves.
qualitySelect.setDisabled(true); includeSelf.disabled = true; name.disabled = true; saveFolder.disabled = true; askWhereToSave.disabled = true;
let current: RecorderState = { phase: "idle", elapsedMs: 0 };
let tiles: DetectedTile[] = [];
let busy = false;
let initialized = false;
let readAt = Date.now();
let polling = false;
let reportedWarning = "";
let libraryGeneration = 0;
initTheme();

function showError(error: unknown) { warning.textContent = errorMessage(error); warning.hidden = false; }
function hasSelection() { return tiles.some(tile => tile.selected); }
function toggleTile(tile: DetectedTile, on: boolean) {
  void run(async () => { await send("select", { id: tile.id, on }); await refreshTiles(); });
}
// Static icon markup only. Tile labels come from the page, so they are always set as text.
const ICON = {
  camera: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-5 4 5 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2.5"/></svg>`,
  screen: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3.5" width="20" height="14" rx="2.5"/><path d="M8.5 21h7M12 17.5V21"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 5 5 10-11"/></svg>`,
};
let renderedTiles = "";
function renderTiles() {
  const disabledNow = busy || ["starting", "stopping"].includes(current.phase);
  // The popup polls every 1.5s; rebuilding identical rows churns the DOM for no reason.
  const signature = JSON.stringify([tiles, disabledNow]);
  if (signature === renderedTiles) return;
  renderedTiles = signature;
  const selectedCount = tiles.filter(tile => tile.selected).length;
  tileCount.textContent = String(selectedCount);
  tileCount.hidden = selectedCount === 0;
  tileList.replaceChildren();
  if (!tiles.length) {
    const empty = document.createElement("p");
    empty.className = "tile-empty";
    empty.textContent = "No videos detected yet. Open the meeting tab and make sure at least one person's camera is on.";
    tileList.append(empty);
    return;
  }
  const disabled = disabledNow;
  for (const tile of tiles) {
    const row = document.createElement("label"); row.className = "tile-row";
    const check = document.createElement("span"); check.className = "check";
    const box = document.createElement("input"); box.type = "checkbox"; box.checked = tile.selected; box.disabled = disabled;
    box.addEventListener("change", () => toggleTile(tile, box.checked));
    const face = document.createElement("span"); face.className = "check-box"; face.innerHTML = ICON.check;
    check.append(box, face);
    const kind = document.createElement("span"); kind.className = "tile-kind"; kind.setAttribute("aria-hidden", "true");
    kind.innerHTML = tile.kind === "screen" ? ICON.screen : ICON.camera;
    const name = document.createElement("span"); name.className = "tile-name"; name.textContent = tile.label;
    const meta = document.createElement("span"); meta.className = "tile-meta"; meta.textContent = tile.kind === "screen" ? "Screen" : "Camera";
    row.append(check, kind, name, meta);
    tileList.append(row);
  }
}
function render() {
  const idle = current.phase === "idle";
  start.disabled = busy || !initialized || !idle || !hasSelection();
  stop.disabled = busy || !["recording", "paused"].includes(current.phase);
  pause.disabled = stop.disabled;
  // Gate on `initialized` too: without it, a click before stored settings finish loading
  // could be silently overwritten once that async read resolves and re-applies the old value.
  for (const control of [includeSelf, name, saveFolder, askWhereToSave]) control.disabled = busy || !initialized || !idle;
  qualitySelect.setDisabled(busy || !initialized || !idle);
  element<HTMLButtonElement>("setup").disabled = busy || !idle;
  const panel = element<HTMLDivElement>("recordingPanel");
  panel.hidden = idle;
  panel.dataset.phase = current.phase;
  element("phase").textContent = current.phase === "paused" ? "Paused" : current.phase === "starting" ? "Starting…" : current.phase === "stopping" ? "Saving…" : "Recording";
  pause.textContent = current.phase === "paused" ? "Resume" : "Pause";
  renderTiles();
}
async function refreshTiles() {
  try { tiles = await send<DetectedTile[]>("tiles"); } catch (error) { showError(error); }
  render();
}
function applyState(next: RecorderState) {
  current = next; readAt = Date.now();
  render();
  if (next.warning) { showError(next.warning); reportedWarning = next.warning; }
  else if (reportedWarning && warning.textContent === reportedWarning) { warning.hidden = true; reportedWarning = ""; }
}
async function run(work: () => Promise<void>) {
  if (busy) return;
  busy = true; warning.hidden = true; render();
  try { await work(); } catch (error) { showError(error); }
  finally { busy = false; render(); }
}
// Show the real path a recording would take, sanitiser and all, so a typed folder name is never
// a guess about where the files went.
function renderSavePath() {
  const next = normalizeSettings({ ...settings, saveFolder: saveFolder.value, name: name.value, askWhereToSave: askWhereToSave.checked });
  // Rendered with no meeting title, so the placeholder segment is exactly what an unnamed
  // meeting really gets rather than an invented example.
  const example = meetingFolder(undefined, "", new Date(), next.name, next.saveFolder);
  element("savePath").textContent = next.askWhereToSave
    ? "Chrome asks for a destination for every file."
    : `Downloads / ${example.replace(/\//g, " / ")} / …`;
}
async function saveSettings() {
  settings = normalizeSettings({ ...settings, includeSelf: includeSelf.checked, name: name.value, saveFolder: saveFolder.value, askWhereToSave: askWhereToSave.checked });
  renderSavePath();
  await chrome.storage.local.set({ settings });
}
for (const input of [includeSelf, name, saveFolder, askWhereToSave]) input.addEventListener("change", () => { void saveSettings().catch(showError); });
for (const input of [name, saveFolder]) input.addEventListener("input", renderSavePath);
element("howItWorks").addEventListener("click", () => { void run(async () => { await send("onboarding"); window.close(); }); });

// ---- Sites ------------------------------------------------------------------------------------
// Built-in sites come from the manifest and cannot be removed; user-added ones each hold an
// optional host permission, which is requested here because Chrome only grants one on a gesture.
let userSites: string[] = [];
const BUILT_IN = [{ label: "Google Meet", host: "meet.google.com" }, { label: "ADPList", host: "adplist.org" }];
function renderSites() {
  const list = element("siteList");
  list.replaceChildren();
  for (const site of BUILT_IN) {
    const row = document.createElement("div"); row.className = "tile-row site-row";
    const name = document.createElement("span"); name.className = "tile-name"; name.textContent = site.label;
    const meta = document.createElement("span"); meta.className = "tile-meta"; meta.textContent = "Built in";
    row.append(name, meta); list.append(row);
  }
  for (const origin of userSites) {
    const row = document.createElement("div"); row.className = "tile-row site-row";
    const name = document.createElement("span"); name.className = "tile-name"; name.textContent = origin.replace(/^https?:\/\//, "");
    const remove = document.createElement("button"); remove.className = "text-button"; remove.textContent = "Remove";
    remove.addEventListener("click", () => { void run(async () => {
      await chrome.permissions.remove({ origins: [`${origin}/*`] }).catch(() => {});
      userSites = await send<{ sites: string[] }>("sites", { sites: userSites.filter(s => s !== origin) }).then(r => r.sites);
      renderSites();
    }); });
    row.append(name, remove); list.append(row);
  }
}
element("addSite").addEventListener("click", () => { void run(async () => {
  const origin = normalizeSite(siteInput.value);
  if (!origin) throw new Error("Enter a site address, for example app.example.com.");
  if (userSites.includes(origin)) { status.textContent = `${siteLabel(origin)} is already allowed.`; return; }
  // Must be called straight from the click: Chrome only grants an optional permission on a gesture.
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) throw new Error("Chrome did not grant access to that site, so GMRec cannot read its tiles.");
  userSites = await send<{ sites: string[] }>("sites", { sites: [...userSites, origin] }).then(r => r.sites);
  siteInput.value = "";
  renderSites();
  status.textContent = `${siteLabel(origin)} added. Open a meeting there and refresh the tab.`;
}); });
element("setup").addEventListener("click", () => { void run(async () => { await send("setup"); window.close(); }); });
element("screenshot").addEventListener("click", () => { void run(async () => {
  const count = await send<number>("screenshot");
  status.textContent = count ? `Saved ${count} screenshot${count === 1 ? "" : "s"}.` : "Select a video to screenshot first.";
}); });
start.addEventListener("click", () => { void run(async () => {
  status.textContent = "Opening capture sources…";
  await saveSettings();
  applyState(await send<RecorderState>("start", { settings }));
  const count = tiles.filter(tile => tile.selected).length;
  status.textContent = `Recording ${count} video file${count === 1 ? "" : "s"}${settings.includeSelf ? " plus your camera" : ""}. Keep the meeting visible.`;
}); });
stop.addEventListener("click", () => { void run(async () => {
  status.textContent = "Finalizing video and starting downloads…";
  const next = await send<RecorderState>("stop"); applyState(next);
  status.textContent = "Stopped. Check Chrome Downloads; backup copies are in Saved recordings.";
  await refreshLibrary();
}); });
pause.addEventListener("click", () => { void run(async () => {
  applyState(await send<RecorderState>(current.phase === "paused" ? "resume" : "pause"));
  status.textContent = current.phase === "paused" ? "Recording paused. Paused time is excluded from both files." : "Recording resumed. Keep the meeting visible.";
}); });
async function refreshLibrary() {
  const generation = ++libraryGeneration;
  const records = await send<SavedRecording[]>("list");
  if (generation !== libraryGeneration) return;
  const saved = element("savedCount");
  saved.textContent = String(records.length);
  saved.hidden = records.length === 0;
  const library = element("library");
  library.replaceChildren();
  if (!records.length) {
    const empty = document.createElement("p");
    empty.className = "tile-empty";
    empty.textContent = "Nothing saved yet. Recordings appear here as soon as you stop one.";
    library.append(empty);
    return;
  }
  for (const record of records) {
    const row = document.createElement("div"); row.className = "recording-item";
    const title = document.createElement("p"); title.textContent = record.filename;
    const detail = document.createElement("p"); detail.className = "meta";
    detail.textContent = `${(record.bytes / 1024 / 1024).toFixed(1)} MB · ${record.status} · ${new Date(record.createdAt).toLocaleString()}`;
    const actions = document.createElement("div"); actions.className = "file-actions";
    const save = document.createElement("button"); save.className = "text-button"; save.textContent = "Download copy"; save.disabled = record.status === "recording" || !record.bytes;
    save.addEventListener("click", () => { void run(async () => { await send("save", { id: record.id }); status.textContent = "Download started. The local backup remains available."; }); });
    const remove = document.createElement("button"); remove.className = "text-button"; remove.textContent = "Remove backup"; remove.disabled = record.status === "recording";
    let confirming = false;
    remove.addEventListener("click", () => {
      if (!confirming) { confirming = true; remove.textContent = "Confirm removal"; return; }
      void run(async () => { await send("delete", { id: record.id }); await refreshLibrary(); });
    });
    actions.append(save, remove); row.append(title, detail, actions); library.append(row);
  }
}
element("refreshLibrary").addEventListener("click", () => { void refreshLibrary().catch(showError); });

// Tabs keep the popup one screen tall. The app bar, live state and Start/Stop footer sit outside
// them on purpose: stop must never be hidden behind a tab while a recording is running.
const TABS = [
  { tab: "tabRecord", panel: "panelRecord" },
  { tab: "tabSetup", panel: "panelSetup" },
  { tab: "tabFiles", panel: "panelFiles" },
];
function selectTab(id: string, moveFocus = false) {
  for (const entry of TABS) {
    const tab = element<HTMLButtonElement>(entry.tab);
    const active = entry.tab === id;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    element(entry.panel).hidden = !active;
    if (active && moveFocus) tab.focus();
  }
  try { localStorage.setItem("gmrec-tab", id); } catch { /* storage can be unavailable */ }
  if (id === "tabFiles") void refreshLibrary().catch(showError);
}
TABS.forEach((entry, index) => {
  const tab = element<HTMLButtonElement>(entry.tab);
  tab.addEventListener("click", () => selectTab(entry.tab));
  tab.addEventListener("keydown", event => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    selectTab(TABS[(index + step + TABS.length) % TABS.length].tab, true);
  });
});
let storedTab: string | null = null;
try { storedTab = localStorage.getItem("gmrec-tab"); } catch { /* storage can be unavailable */ }
selectTab(TABS.some(entry => entry.tab === storedTab) ? storedTab! : "tabRecord");
async function refreshState() {
  if (busy || polling) return;
  polling = true;
  try {
    const next = await send<RecorderState>("status");
    if (busy) return;
    const ended = current.phase !== "idle" && next.phase === "idle";
    applyState(next);
    if (ended) { status.textContent = "Recording ended. Check downloads and local backup copies."; await refreshLibrary(); }
    await refreshTiles();
  } catch (error) { showError(error); } finally { polling = false; }
}
const clock = window.setInterval(() => { element("timer").textContent = formatTime(current.elapsedMs + (current.phase === "recording" ? Date.now() - readAt : 0)); }, 250);
const poll = window.setInterval(() => { void refreshState(); }, 1500);
window.addEventListener("pagehide", () => { clearInterval(clock); clearInterval(poll); });
void (async () => {
  const stored = await chrome.storage.local.get(["settings", "deviceLabels"]);
  settings = normalizeSettings(stored.settings); includeSelf.checked = settings.includeSelf; qualitySelect.setValue(settings.quality); name.value = settings.name;
  saveFolder.value = settings.saveFolder; askWhereToSave.checked = settings.askWhereToSave; renderSavePath();
  if (stored.deviceLabels) element("deviceSummary").textContent = `${stored.deviceLabels.camera || "Default camera"} · ${stored.deviceLabels.microphone || "Default microphone"}`;
  try { userSites = (await send<{ sites: string[] }>("sites")).sites; } catch { /* the list is additive; failing to read it must not block recording */ }
  renderSites();
  applyState(await send<RecorderState>("status"));
  try { await refreshTiles(); }
  catch (error) { status.textContent = errorMessage(error); }
  if (hasSelection()) status.textContent = "Check devices, then start when ready.";
  else if (!warning.textContent) status.textContent = "Open your meeting; toggle on the participants or screen shares to record.";
  if (current.phase !== "idle") status.textContent = "A recording is active. Use the controls above to pause or stop.";
  initialized = true; render();
  await refreshLibrary();
})().catch(showError);
