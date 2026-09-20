import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function load(name, globals = {}, imports = {}) {
  const code = ts.transpileModule(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => imports[name], console, URL, ...globals }, { filename: `${name}.ts` });
  return exports;
}
const shared = load("shared");
const selection = { tiles: [{ id: "p1", label: "Person", kind: "camera" }] };

test("selection validation requires at least one well-formed tile", () => {
  assert.equal(shared.validSelection(selection), true);
  assert.equal(shared.validSelection({ tiles: [] }), false);
  assert.equal(shared.validSelection({ tiles: [{ ...selection.tiles[0], kind: "screencast" }] }), false);
  assert.equal(shared.validSelection({ tiles: [{ ...selection.tiles[0], id: "" }] }), false);
  assert.equal(shared.validSelection(null), false);
});
test("loopback signals are validated by kind", () => {
  assert.equal(shared.validSignal({ kind: "request" }), true);
  assert.equal(shared.validSignal({ kind: "offer", sdp: "v=0" }), true);
  assert.equal(shared.validSignal({ kind: "ice", candidate: { candidate: "x", sdpMid: "0" } }), true);
  assert.equal(shared.validSignal({ kind: "offer" }), false);
  assert.equal(shared.validSignal({ kind: "ice", candidate: null }), false);
  assert.equal(shared.validSignal({ kind: "bogus" }), false);
});
test("contain preserves an entire portrait frame; cover fills the output", () => {
  assert.equal(shared.fitRect(720, 1280, 1920, 1080, "contain").height, 1080);
  assert.equal(shared.fitRect(720, 1280, 1920, 1080, "contain").width, 607.5);
  assert.equal(shared.fitRect(720, 1280, 1920, 1080, "cover").width, 1920);
  assert.ok(shared.fitRect(720, 1280, 1920, 1080, "cover").y < 0);
});
test("each meeting session gets one dated folder", () => {
  const when = new Date(2026, 8, 19, 17, 5);
  assert.equal(shared.meetingFolder("Meet – Weekly sync", "https://meet.google.com/abc-defg-hij", when), "GMRec/Weekly-sync-2026-09-19-1705");
  // Falls back to the meeting code when the tab title carries no name.
  assert.equal(shared.meetingFolder("Meet", "https://meet.google.com/abc-defg-hij", when), "GMRec/abc-defg-hij-2026-09-19-1705");
  assert.equal(shared.meetingFolder(undefined, undefined, when), "GMRec/meeting-2026-09-19-1705");
  // Separators and other unsafe characters never survive into a path segment.
  assert.equal(shared.meetingFolder("../../etc/passwd", "", when), "GMRec/etc-passwd-2026-09-19-1705");
  // A custom prefix leads the folder; the default one would only add noise.
  assert.equal(shared.meetingFolder("Meet – Standup", "", when, "acme"), "GMRec/acme-Standup-2026-09-19-1705");
  assert.equal(shared.meetingFolder("Meet – Standup", "", when, "gmrec"), "GMRec/Standup-2026-09-19-1705");
});
test("the save location is a sanitized relative folder under Downloads", () => {
  assert.equal(shared.safeFolder("Work/Meetings"), "Work/Meetings");
  assert.equal(shared.safeFolder(String.raw`Work\Meetings`), "Work/Meetings", "a pasted Windows path still resolves to segments");
  // Spaces are legal in a Downloads path; the characters Chrome rejects are not.
  assert.equal(shared.safeFolder(" My Calls : 2026? "), "My Calls - 2026", "illegal characters become a dash, then trailing dashes are trimmed");
  assert.equal(shared.safeFolder("../../Windows/System32"), "Windows/System32", "no escaping upwards");
  assert.equal(shared.safeFolder("C:/Users/me/Videos"), "C/Users/me/Videos", "an absolute path is flattened, never honoured");
  assert.equal(shared.safeFolder("a/b/c/d/e/f"), "a/b/c/d", "depth is capped");
  assert.equal(shared.safeFolder(""), "GMRec");
  assert.equal(shared.safeFolder(undefined), "GMRec");
  assert.equal(shared.safeFolder("///"), "GMRec");
  // Whatever the user typed, the resulting download path is always acceptable to Chrome.
  for (const input of ["../../etc", "C:/x", "  ", "Work/Meetings", 'a"b<c>d|e'])
    assert.equal(shared.safeDownloadPath(`${shared.meetingFolder("Meet – Sync", "", new Date(), "gmrec", input)}/x.mp4`), true, input);
  // The chosen folder becomes the root of the per-meeting folder.
  assert.equal(shared.meetingFolder("Meet – Sync", "", new Date(2026, 8, 19, 17, 5), "gmrec", "Work/Calls"), "Work/Calls/Sync-2026-09-19-1705");
});
test("settings carry a save location and a Save-as preference", () => {
  assert.equal(shared.defaults.saveFolder, "GMRec");
  assert.equal(shared.defaults.askWhereToSave, false);
  const values = shared.normalizeSettings({ saveFolder: "../Work/Calls", askWhereToSave: "yes" });
  assert.equal(values.saveFolder, "Work/Calls");
  assert.equal(values.askWhereToSave, false, "only a real boolean true turns on the Save-as dialog");
  assert.equal(shared.normalizeSettings({ askWhereToSave: true }).askWhereToSave, true);
});
test("recordable sites are the built-in ones plus whatever the user added", () => {
  assert.equal(shared.siteAllowed("https://meet.google.com/abc-defg-hij"), true);
  assert.equal(shared.siteAllowed("https://adplist.org/meeting?id=1"), true, "ADPList runs its own sessions on Dyte");
  assert.equal(shared.siteAllowed("https://www.adplist.org/meeting"), true, "subdomains count");
  assert.equal(shared.siteAllowed("https://evil.com/meet.google.com"), false, "a path is never a host");
  assert.equal(shared.siteAllowed("https://notadplist.org/meeting"), false);
  assert.equal(shared.siteAllowed("https://app.example.com/room/1"), false, "unknown until the user adds it");
  assert.equal(shared.siteAllowed("https://app.example.com/room/1", ["https://app.example.com"]), true);
  // A user-added site authorises its own origin only, never a sibling or the parent domain.
  assert.equal(shared.siteAllowed("https://other.example.com/room", ["https://app.example.com"]), false);
  assert.equal(shared.siteAllowed("http://app.example.com/room", ["https://app.example.com"]), false, "scheme is part of the origin");
  // Nothing that is not a web page can ever be recorded, whatever is stored.
  for (const url of ["chrome://settings", "chrome-extension://abc/popup.html", "file:///c/x.html", "", undefined])
    assert.equal(shared.siteAllowed(url, ["https://app.example.com"]), false, String(url));
});
test("a typed site becomes a bare origin", () => {
  assert.equal(shared.normalizeSite("app.example.com"), "https://app.example.com");
  assert.equal(shared.normalizeSite("https://app.example.com/room/42?x=1"), "https://app.example.com", "a pasted meeting link keeps only its origin");
  assert.equal(shared.normalizeSite("  https://a.io:8443/x  "), "https://a.io:8443", "a port is part of the origin");
  assert.equal(shared.normalizeSite("javascript:alert(1)"), "");
  assert.equal(shared.normalizeSite(""), "");
  assert.deepEqual([...shared.normalizeSites(["a.io", "https://a.io/x", "", 7, "b.io"])], ["https://a.io", "https://b.io"], "deduplicated, junk dropped");
  assert.equal(shared.normalizeSites("not an array").length, 0);
  assert.equal(shared.normalizeSites(Array.from({ length: 80 }, (_, i) => `s${i}.io`)).length, 50, "the list is capped");
});
test("folders are named for the meeting on any site, not only Meet", () => {
  const when = new Date(2026, 8, 19, 17, 5);
  assert.equal(shared.meetingFolder("Mentorship with Aya – ADPList", "https://adplist.org/meeting", when), "GMRec/Mentorship-with-Aya-2026-09-19-1705");
  // No usable title: the path segment identifies the room, exactly as a Meet code does.
  assert.equal(shared.meetingFolder("ADPList", "https://adplist.org/meeting", when), "GMRec/meeting-2026-09-19-1705");
  // No title and no room in the path: the site itself is still better than "meeting".
  assert.equal(shared.meetingFolder("", "https://app.example.com/a/b/c", when), "GMRec/app-example-com-2026-09-19-1705");
});
test("download paths must stay inside the downloads folder", () => {
  assert.equal(shared.safeDownloadPath("GMRec/meeting-2026-09-19-1705/clip.webm"), true);
  assert.equal(shared.safeDownloadPath("../escape.webm"), false);
  assert.equal(shared.safeDownloadPath("/absolute.webm"), false);
  assert.equal(shared.safeDownloadPath("C:/drive.webm"), false);
  assert.equal(shared.safeDownloadPath("double//slash.webm"), false);
  assert.equal(shared.safeDownloadPath(""), false);
});
test("settings normalize unsupported values and sanitize filenames", () => {
  const values = shared.normalizeSettings({ name: '../../Test:recording<>', quality: "4k", includeSelf: false, cameraDeviceId: "" });
  assert.equal(values.name, "Test-recording"); assert.equal(values.quality, "720p"); assert.equal(values.cameraDeviceId, "default"); assert.equal(values.includeSelf, false);
  assert.equal(shared.normalizeSettings({ quality: "1080p" }).quality, "1080p");
  assert.equal(shared.safeName(""), "gmrec");
  assert.equal(shared.formatTime(3_661_000), "01:01:01");
});
function event() { const listeners = []; return { addListener: fn => listeners.push(fn), listeners }; }
function workerEnvironment() {
  const calls = [];
  const toContent = [];
  let state = { phase: "idle", elapsedMs: 0 };
  let hasRecorder = false;
  let failStart = false;
  let activeTab = { id: 7, url: "https://meet.google.com/abc-defg-hij" };
  let userSites = [];
  const chrome = {
    runtime: { id: "test", ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" }, getURL: file => `chrome-extension://test/${file}`, getContexts: async () => hasRecorder ? [{}] : [], onMessage: event(), onInstalled: event(), sendMessage: async message => {
      calls.push(message);
      assert.equal(message.target, "recorder");
      if (message.type === "start") {
        if (failStart) return { ok: false, error: "camera unavailable" };
        state = { phase: "recording", elapsedMs: 0, tabId: message.config.tabId };
      }
      if (message.type === "stop") state = { ...state, phase: "idle" };
      return { ok: true, data: state };
    } },
    tabs: { query: async () => [activeTab], sendMessage: async (_id, message) => { toContent.push(message); return message.type === "selection" ? selection : null; }, onRemoved: event(), onUpdated: event() },
    scripting: { executeScript: async () => {}, getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {} },
    offscreen: { Reason: { USER_MEDIA: "USER_MEDIA", BLOBS: "BLOBS" }, createDocument: async () => { hasRecorder = true; } },
    tabCapture: { getMediaStreamId: (_options, cb) => cb("test-stream") },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    downloads: { onChanged: event() },
    storage: {
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      local: { get: async () => ({ sites: userSites }), set: async values => { if (values.sites) userSites = values.sites; } },
    },
    permissions: { contains: async () => true, onRemoved: event() },
  };
  function restart() {
    chrome.runtime.onMessage = event();
    load("background", { chrome }, { "./shared": shared });
  }
  restart();
  function request(type, payload = {}, sender = { id: "test", url: "chrome-extension://test/popup.html" }) {
    return new Promise(resolve => chrome.runtime.onMessage.listeners[0]({ target: "background", type, ...payload }, sender, resolve));
  }
  return { chrome, request, calls, toContent, restart, fail: () => { failStart = true; }, otherTab: () => { activeTab = { id: 9, url: "https://example.com" }; } };
}
test("worker only handles explicitly addressed messages", () => {
  const env = workerEnvironment();
  let responded = false;
  const accepted = env.chrome.runtime.onMessage.listeners[0]({ target: "recorder", type: "start" }, { id: "test" }, () => { responded = true; });
  assert.equal(accepted, undefined); assert.equal(responded, false);
});
test("failed media start reaches UI and never reports recording", async () => {
  const env = workerEnvironment(); env.fail();
  const reply = await env.request("start", { settings: {} });
  assert.equal(reply.ok, false); assert.match(reply.error, /camera unavailable/);
  assert.equal((await env.request("status")).data.phase, "idle");
});
test("recording controls survive worker restart and reject duplicate start", async () => {
  const env = workerEnvironment();
  assert.equal((await env.request("start", { settings: {} })).data.phase, "recording");
  env.restart();
  assert.equal((await env.request("status")).data.phase, "recording");
  assert.equal((await env.request("start", { settings: {} })).ok, false);
  assert.equal((await env.request("stop")).data.phase, "idle");
});
test("start validates the active Meet tab", async () => {
  const env = workerEnvironment(); env.otherTab();
  const reply = await env.request("start", { settings: {} });
  assert.equal(reply.ok, false); assert.match(reply.error, /Google Meet/);
  assert.equal(env.calls.some(message => message.type === "start"), false);
});
test("extension pages opened as tabs can query the recorder", async () => {
  const env = workerEnvironment();
  const reply = await env.request("status", {}, { id: "test", tab: { id: 10 }, frameId: 0, url: "chrome-extension://test/setup.html" });
  assert.equal(reply.ok, true); assert.equal(reply.data.phase, "idle");
});
test("content scripts cannot start recordings or signal into another tab's recording", async () => {
  const env = workerEnvironment();
  const stranger = { id: "test", tab: { id: 8 }, frameId: 0, url: "https://meet.google.com/xyz" };
  assert.equal((await env.request("start", {}, stranger)).ok, false);
  await env.request("start", { settings: {} }); // records tab 7
  await env.request("tile-signal", { id: "p1", signal: { kind: "offer", sdp: "v=0" } }, stranger);
  assert.equal(env.calls.some(message => message.type === "tile-signal"), false);
  // The recorded tab's own content script is allowed through.
  const owner = { id: "test", tab: { id: 7 }, frameId: 0, url: "https://meet.google.com/abc-defg-hij" };
  await env.request("tile-signal", { id: "p1", signal: { kind: "offer", sdp: "v=0" } }, owner);
  assert.equal(env.calls.some(message => message.type === "tile-signal"), true);
  // Malformed signals from the recorded tab are dropped rather than relayed.
  const before = env.calls.filter(message => message.type === "tile-signal").length;
  await env.request("tile-signal", { id: "p1", signal: { kind: "offer" } }, owner);
  assert.equal(env.calls.filter(message => message.type === "tile-signal").length, before);
});
test("only the offscreen recorder may relay signals back into a tab", async () => {
  const env = workerEnvironment();
  await env.request("start", { settings: {} });
  const fromPopup = await env.request("tile-signal", { tabId: 7, id: "p1", signal: { kind: "answer", sdp: "v=0" } });
  assert.equal(fromPopup.ok, false);
  assert.match(fromPopup.error, /Invalid tile signal/);
  const fromRecorder = await env.request("tile-signal", { tabId: 7, id: "p1", signal: { kind: "answer", sdp: "v=0" } }, { id: "test", url: "chrome-extension://test/recorder.html" });
  assert.equal(fromRecorder.ok, true);
  assert.equal(env.toContent.some(message => message.type === "tile-signal" && message.id === "p1"), true);
});
test("manifest keeps extension styling and recorder pages out of Meet", () => {
  const manifest = JSON.parse(readFileSync(new URL("../src/manifest.json", import.meta.url)));
  assert.equal(manifest.content_scripts[0].css, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.minimum_chrome_version, "120");
});
