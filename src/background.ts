import type { DetectedTile, RecorderState, Reply, Selection } from "./types";
import { errorMessage, meetingFolder, normalizeSettings, normalizeSites, safeDownloadPath, siteAllowed, siteLabel, validSelection, validSignal, validTileMeta } from "./shared";

const idle: RecorderState = { phase: "idle", elapsedMs: 0 };
let creating: Promise<void> | undefined;
let starting = false;

async function hasRecorder() {
  return (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [chrome.runtime.getURL("recorder.html")] })).length > 0;
}
async function ensureRecorder() {
  if (creating) return creating;
  creating = (async () => {
    if (!await hasRecorder()) await chrome.offscreen.createDocument({
      url: "recorder.html", reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.BLOBS],
      justification: "Capture consented meeting media and retain local recordings for download recovery.",
    });
  })();
  try { await creating; } finally { creating = undefined; }
}
async function recorder<T>(type: string, payload: object = {}): Promise<T> {
  const reply: Reply<T> = await chrome.runtime.sendMessage({ target: "recorder", type, ...payload });
  if (!reply?.ok) throw new Error(reply && !reply.ok ? reply.error : "The recorder did not respond. Reload the extension and the meeting tab.");
  return reply.data;
}
async function getState(): Promise<RecorderState> {
  return await hasRecorder() ? recorder<RecorderState>("status") : idle;
}
// Sites the user added themselves, on top of the ones shipped in the manifest.
async function extraSites(): Promise<string[]> {
  return normalizeSites((await chrome.storage.local.get("sites")).sites);
}
async function meetTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !siteAllowed(tab.url, await extraSites())) {
    throw new Error("Open your meeting tab and use GMRec there. GMRec knows Google Meet and ADPList; add any other site under Setup.");
  }
  return tab as chrome.tabs.Tab & { id: number };
}
// A content script may only speak for a page GMRec is actually allowed to record. Registering a
// site is what grants that, so the same check gates both directions.
async function senderAllowed(sender: chrome.runtime.MessageSender): Promise<boolean> {
  return siteAllowed(sender.url, await extraSites());
}
async function content<T>(tabId: number, type: string, payload: object = {}): Promise<T> {
  try { return await chrome.tabs.sendMessage(tabId, { target: "content", type, ...payload }); }
  catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return chrome.tabs.sendMessage(tabId, { target: "content", type, ...payload });
  }
}
async function publish(state: RecorderState) {
  await chrome.action.setBadgeText({ text: state.phase === "paused" ? "Ⅱ" : state.phase === "recording" ? "REC" : state.phase === "starting" ? "…" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: state.phase === "paused" ? "#966000" : "#ba1a1a" });
  if (state.tabId) await chrome.tabs.sendMessage(state.tabId, { target: "content", type: "state", state }).catch(() => {});
}
async function handle(message: any, sender: chrome.runtime.MessageSender): Promise<unknown> {
  // Content scripts only add/remove tiles, relay loopback signaling, save screenshots, and
  // request their own current status.
  if (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(""))) {
    if (sender.frameId !== 0 || !await senderAllowed(sender)) throw new Error("Unsupported recording source.");
    if (message.type === "tile-signal") {
      const state = await getState();
      if (state.tabId === sender.tab.id && state.phase !== "idle" && typeof message.id === "string" && validSignal(message.signal)) {
        await recorder("tile-signal", { id: message.id, signal: message.signal });
      }
      return null;
    }
    if (message.type === "add-tile" || message.type === "remove-tile") {
      const state = await getState();
      if (state.tabId === sender.tab.id && state.phase !== "idle") {
        if (message.type === "add-tile" && validTileMeta(message.tile)) await recorder("add-tile", { tile: message.tile });
        if (message.type === "remove-tile" && typeof message.id === "string") await recorder("remove-tile", { id: message.id });
      }
      return null;
    }
    if (message.type === "save-screenshot") {
      if (typeof message.dataUrl !== "string" || !message.dataUrl.startsWith("data:image/png;base64,") || typeof message.filename !== "string" || !safeDownloadPath(message.filename)) throw new Error("Invalid screenshot.");
      return chrome.downloads.download({ url: message.dataUrl, filename: message.filename, saveAs: false, conflictAction: "uniquify" });
    }
    if (message.type === "status") {
      const state = await getState();
      return state.tabId === sender.tab.id ? state : idle;
    }
    throw new Error("This command must be sent from GMRec.");
  }
  if (message.type === "state-changed") {
    if (sender.url !== chrome.runtime.getURL("recorder.html")) throw new Error("Invalid recorder sender.");
    await publish(message.state);
    return null;
  }
  if (message.type === "tile-signal") {
    if (sender.url !== chrome.runtime.getURL("recorder.html") || typeof message.tabId !== "number" || typeof message.id !== "string" || !validSignal(message.signal)) throw new Error("Invalid tile signal.");
    await chrome.tabs.sendMessage(message.tabId, { target: "content", type: "tile-signal", id: message.id, signal: message.signal });
    return null;
  }
  if (message.type === "download") {
    if (sender.url !== chrome.runtime.getURL("recorder.html") || typeof message.url !== "string" || !message.url.startsWith(`blob:chrome-extension://${chrome.runtime.id}/`)) throw new Error("Invalid recording download.");
    if (typeof message.filename !== "string" || !safeDownloadPath(message.filename)) throw new Error("Invalid recording filename.");
    // saveAs hands the file to Chrome's own Save-as dialog, the only way to put a recording
    // outside the Downloads folder; the path then serves as the suggested name.
    const id = await chrome.downloads.download({ url: message.url, filename: message.filename, saveAs: message.saveAs === true, conflictAction: "uniquify" });
    await chrome.storage.session.set({ [`download-${id}`]: message.url });
    const [item] = await chrome.downloads.search({ id });
    if (item && item.state !== "in_progress") await releaseDownload(id);
    return id;
  }
  if (message.type === "status") {
    const state = await getState();
    await publish(state);
    return state;
  }
  if (message.type === "selection") {
    const tab = await meetTab();
    return content<Selection | null>(tab.id, "selection");
  }
  if (message.type === "tiles") {
    const tab = await meetTab();
    return content<DetectedTile[]>(tab.id, "tiles");
  }
  if (message.type === "select") {
    const tab = await meetTab();
    if (typeof message.id !== "string") throw new Error("Missing tile id.");
    return content<boolean>(tab.id, "select", { id: message.id, on: !!message.on });
  }
  if (message.type === "screenshot") {
    const tab = await meetTab();
    return content<number>(tab.id, "screenshot");
  }
  if (message.type === "start") {
    if (starting) throw new Error("Recording is already starting.");
    starting = true;
    try {
      if ((await getState()).phase !== "idle") throw new Error("A recording is already active. Stop it before starting another.");
      const tab = await meetTab();
      const selection = await content<Selection | null>(tab.id, "selection");
      if (!validSelection(selection)) throw new Error("Select at least one participant or screen share to record.");
      const settings = normalizeSettings(message.settings);
      await ensureRecorder();
      const tabStreamId = await new Promise<string>((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, id => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); else resolve(id);
        });
      });
      return await recorder("start", { tabStreamId, config: { ...settings, tabId: tab.id, selection, folder: meetingFolder(tab.title, tab.url, new Date(), settings.name, settings.saveFolder), meeting: { title: tab.title ?? "", url: tab.url ?? "" }, width: settings.quality === "720p" ? 1280 : 1920, height: settings.quality === "720p" ? 720 : 1080, fps: 30 } });
    } finally { starting = false; }
  }
  if (["pause", "resume", "stop"].includes(message.type)) {
    if (!await hasRecorder()) throw new Error("No recording is active.");
    return recorder(message.type);
  }
  if (["list", "save", "delete"].includes(message.type)) {
    await ensureRecorder();
    return recorder(message.type, { id: message.id });
  }
  if (message.type === "sites") {
    if (Array.isArray(message.sites)) await chrome.storage.local.set({ sites: normalizeSites(message.sites) });
    await syncUserSites();
    return { sites: await extraSites(), current: siteLabel(message.url) };
  }
  if (message.type === "onboarding") return openExtensionPage("onboarding.html");
  if (message.type === "setup") {
    return openExtensionPage("setup.html");
  }
  throw new Error("Unknown GMRec command.");
}
// A user-added site is only reachable once its host permission is granted, so registration is
// driven by what Chrome actually granted rather than by what is stored.
const DYNAMIC_SCRIPT_ID = "gmrec-user-sites";
async function syncUserSites() {
  const granted: string[] = [];
  for (const origin of await extraSites()) {
    if (await chrome.permissions.contains({ origins: [`${origin}/*`] }).catch(() => false)) granted.push(`${origin}/*`);
  }
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [DYNAMIC_SCRIPT_ID] }).catch(() => []);
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [DYNAMIC_SCRIPT_ID] }).catch(() => {});
  if (!granted.length) return granted;
  await chrome.scripting.registerContentScripts([{ id: DYNAMIC_SCRIPT_ID, matches: granted, js: ["content.js"], runAt: "document_idle" }]).catch(() => {});
  return granted;
}
// Focus the page if it is already open rather than stacking duplicate tabs.
async function openExtensionPage(page: string) {
  const url = chrome.runtime.getURL(page);
  const tabs = await chrome.tabs.query({ url });
  if (tabs[0]?.id) await chrome.tabs.update(tabs[0].id, { active: true });
  else await chrome.tabs.create({ url });
  return null;
}
// A fresh install lands on the walkthrough: GMRec needs consent, device setup and a meeting
// before it can do anything, and none of that is discoverable from a toolbar icon alone.
chrome.runtime.onInstalled.addListener(details => {
  void syncUserSites().catch(console.error);
  if (details.reason === "install") void openExtensionPage("onboarding.html").catch(console.error);
});
chrome.runtime.onStartup?.addListener(() => { void syncUserSites().catch(console.error); });
// Revoking a site's permission from Chrome's own UI must stop the script running there.
chrome.permissions?.onRemoved?.addListener(() => { void syncUserSites().catch(console.error); });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== "background" || sender.id !== chrome.runtime.id) return;
  void handle(message, sender).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: errorMessage(error) }));
  return true;
});
async function releaseDownload(id: number) {
  const key = `download-${id}`;
  const values = await chrome.storage.session.get(key);
  if (values[key] && await hasRecorder()) await recorder("release", { url: values[key] });
  await chrome.storage.session.remove(key);
}
chrome.downloads.onChanged.addListener(delta => {
  if (delta.state?.current === "complete" || delta.state?.current === "interrupted") void releaseDownload(delta.id).catch(console.error);
});
async function sourceClosed(tabId: number) {
  const state = await getState();
  if (state.tabId === tabId && state.phase !== "idle") await recorder("stop", { reason: "Meet was closed or reloaded. Available recording data was saved locally." });
}
chrome.tabs.onRemoved.addListener(id => { void sourceClosed(id).catch(console.error); });
chrome.tabs.onUpdated.addListener((id, change) => { if (change.status === "loading") void sourceClosed(id).catch(console.error); });
