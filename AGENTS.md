# AGENTS.md

Orientation for AI agents and LLMs working on GMRec. Humans will find it useful too.

This file exists because several things in this codebase look like mistakes and are not, and
several obvious-looking improvements have already been tried and measurably made things worse.
**Read the invariants before changing anything in `src/recorder.ts` or `src/content.ts`.**

---

## What this project is

A Manifest V3 Chrome extension that records each meeting participant into a separate MP4, by
cloning their real WebRTC `MediaStreamTrack` — not by capturing pixels. There is no backend, no
build server, and no network access at runtime.

It ships adapters for Google Meet and ADPList (which runs on Dyte), plus a generic adapter that
is expected to work on any WebRTC site the user adds. Site-specific knowledge belongs in
`src/adapters.ts` and nowhere else.

## Getting oriented

```bash
npm install
npm run typecheck        # tsc --noEmit
npm test                 # 16 unit tests, no browser needed, ~1s
npm run build            # esbuild -> dist/
npm run test:browser     # full integration suite in a real Chrome, ~60s
```

`npm test` and `npm run typecheck` are fast and must always pass. The browser suite needs a real
Chrome; set `GMREC_CHROMIUM_PATH` if Playwright's bundled Chromium is not installed:

```bash
GMREC_CHROMIUM_PATH="/c/Program Files/Google/Chrome/Application/chrome.exe" npm run test:browser
```

### Map

| File | What lives there |
|---|---|
| `src/manifest.json` | MV3 manifest. `minimum_chrome_version` is **120** — do not use APIs newer than that without raising it |
| `src/background.ts` | Service worker. Message router **and the trust boundary** |
| `src/content.ts` | Injected into Meet. Tile detection, naming, pinning, track cloning, on-page overlays |
| `src/recorder.ts` | Offscreen document. Loopback receiver, resolution normalizer, `MediaRecorder`, IndexedDB, downloads, manifest |
| `src/popup.ts` / `popup.html` | Toolbar popup: Record / Setup / Files tabs |
| `src/setup.ts` / `setup.html` | Device permission and preview page |
| `src/onboarding.ts` / `onboarding.html` | First-run walkthrough |
| `src/client.ts` | Shared UI helpers: messaging, custom select, theme |
| `src/adapters.ts` | Per-site knowledge and the shadow-DOM walkers. **The only file that may name a product** |
| `src/shared.ts` | Pure functions: validation, sanitizing, folder naming, site matching. **The unit tests target this** |
| `src/storage.ts` | IndexedDB chunk store |
| `src/types.ts` | All shared types |
| `tests/unit.test.mjs` | Node `--test`; transpiles TS in-process, stubs `chrome` |
| `tests/browser-smoke.mjs` | Playwright, synthetic Meet fixture, real encode/decode, file inspection |
| `tests/sites-smoke.mjs` | Playwright, synthetic Dyte and plain fixtures: shadow-DOM discovery, naming, site gating |

### Data flow

```
content.ts  ──tile list──▶  background.ts  ──start──▶  recorder.ts
content.ts  ◀──WebRTC offer/answer/ICE relayed by background──▶  recorder.ts
                                                 recorder.ts ──blob──▶ chrome.downloads
```

The content script holds the real tracks. The recorder needs them but lives in a different
document, so they travel over a **local `RTCPeerConnection` loopback**, with the service worker
relaying signaling. Nothing leaves the machine.

---

## Invariants

Breaking any of these has caused a real, user-reported bug before.

### 1. Do not add an `ended` handler to tile tracks

A camera switching off, a participant leaving, or Meet renegotiating must **not** finalize a
file. Recording stops when the user stops it, so one timeline covers the whole meeting.
`src/recorder.ts` deliberately has no `"ended"` listener on tile tracks, and a source disconnect
sets a warning rather than calling `fail()`.

### 2. `degradationPreference` must stay `"maintain-framerate"`

Setting `"maintain-resolution"` collapsed the camera to **0.33 fps** (one frame per six seconds).
The normalizer already pins resolution; the sender must be free to trade resolution for motion.

### 3. Do not decode tile video with a `<video>` element

A `<video>` in an offscreen document does not reliably decode a WebRTC track — it produced
0-frame files. Frames are pulled with `MediaStreamTrackProcessor` (breakout box) instead.

### 4. Remote audio must be pumped through an `AudioContext`

A remote WebRTC audio track delivers no samples until something consumes it. Handing an idle
track to `MediaRecorder` stalls the muxer and yields a **0-byte file**. Each participant's audio
goes through `AudioContext.createMediaStreamDestination()` first — to a stream, never to the
speakers.

### 5. Resolution must be constant for the whole file

Meet changes resolution mid-call (320×180 → 480×270 → 960×540 …). Writing that straight to
`MediaRecorder` gave players the wrong aspect ratio and black flashes. `normalizeTrack()` draws
every frame onto a fixed-size canvas and emits at a steady rate.

### 6. Ask for H.264 **High** profile explicitly

Plain `"video/mp4"` makes Chrome pick **Baseline** (profile 66) with Opus audio. `VIDEO_TYPES` in
`src/recorder.ts` therefore lists `avc1.640028` first. Verified by walking the `avcC` box of real
output. Do not "simplify" that list.

### 7. The microphone belongs only in `self.mp4`

Never mix the user's microphone into a participant's file. This was an explicit product decision.

### 8. Tiles are keyed by participant id, not by `<video>` element

Meet swaps the element when someone changes camera. Keying by element produced **four duplicate
tiles for one person**. `tileKey()` uses `data-participant-id` plus kind, with a rebind window
(`REBIND_GRACE_MS`).

### 9. Names come from Meet's control labels, not from leaf text

A naive text scan picked up `"Reframe"` and `"Unpin Mohammed Ahmed's presentation…"` as names.
`NAME_FROM_LABEL` parses aria-labels (`Pin <Name>`, `<Name> is presenting`, …) and the leaf scan
skips `button, [role="button"], [role="menuitem"], [aria-label], [data-tooltip]`.

### 10. Scrollbars use `::-webkit-scrollbar`, never `scrollbar-color`

Setting the standard property makes Chrome **ignore** the pseudo-elements entirely, and it only
shipped in Chrome 121 while the manifest supports 120.

### 11. The service worker is a trust boundary

In `background.ts`, every message from a content script is checked: `sender.frameId === 0`, the
URL is on `meet.google.com`, and — for anything touching a live recording — `state.tabId` matches
the sender's tab. Signals relayed *into* a tab must come from `recorder.html`. Download paths go
through `safeDownloadPath()`. Do not relax these to make a feature simpler.

### 12. Tile discovery must pierce shadow roots

`document.querySelectorAll("video")` does not descend into shadow roots, and web-component
products render every tile inside one — ADPList runs on Dyte, whose Stencil components all use
open shadow DOM, so a plain query finds **zero** tiles there. Use `deepVideos`, `deepQueryAll`,
`deepClosest`, `deepLeaves` and `deepText` from `src/adapters.ts`. Each walker also descends the
root's *own* shadow root: when the root is a custom-element host, everything is in there and
`querySelectorAll` on the host returns nothing. `textContent` likewise stops at a shadow boundary
and comes back empty — `deepText` is what reads a name tag.

### 13. Pin by pressing the site's own Pin control, never by simulating a gesture

A synthetic `dblclick` on a Meet tile **does nothing** — that was shipped and it never worked.
Pinning presses the real control, found by the `Pin …` / `Unpin …` aria-label the tile already
exposes (the same labels names are read from, so they are known to be in the DOM without
hovering). It is gated behind `adapter.spotlight`, set only where a pin control is known to exist
and to mean this.

A pin is a three-state thing on the entry — `none` → `requested` (we clicked) → `held`
(confirmed). Ownership starts at the *click*, not at the confirmation: a tile deselected in
between must still be released, or Meet stays pinned to something nobody is recording and
`foreignPinExists()` then blocks every later pin.

Four rules follow:

1. **Confirm the flip asynchronously.** The click only asks; the product updates its state and
   re-renders afterwards, so the control has *not* flipped in the same tick. Claiming the pin
   synchronously left `pinnedByUs` false on real Meet, which meant the pin was never released.
   `confirmPin` re-checks on a timer instead.
2. **Never take a pin that is already taken.** Meet spotlights one tile at a time, so pinning
   anything drops whatever is pinned now — including a tile the user pinned themselves.
   `foreignPinExists()` checks the whole document, excluding pins GMRec itself holds so that
   re-selecting and multi-select still work. Consequence, accepted on purpose: while a screen
   share is on the main stage, nothing gets auto-pinned.
3. **Never give up a watch because the element vanished.** Pinning changes the layout, which is
   exactly when Meet swaps a tile's `<video>`. The entry survives (`scan()` rebinds it), so the
   timer chain must too — and it must be cleared in `attemptUnpin`, when a tile is pruned, and
   in `__gmrecDispose`, or it outlives everything that could release the pin.
4. **Do not disambiguate pin controls by `entry.kind`.** It is circular: `detectKind` calls any
   container carrying a presentation label a screen tile, so the kind is derived from the very
   labels it would be used to choose between. A presentation gets its own tile in Meet, so the
   first match in the container is the right one.

The fixture flips its label on a timer **on purpose**. Flipping it synchronously is what hid
rule 1: the test passed while the feature was broken in Meet. If you touch this, re-break the
code and confirm the suite fails.

### 14. A site is authorised by origin, not by frame index

`siteAllowed()` gates both the popup's start path and every content-script message. Built-in
sites come from the manifest; user-added ones hold an optional host permission and are registered
at runtime from what Chrome actually granted, never from what is merely stored.

### 15. Downloads cannot leave the Downloads folder

`chrome.downloads.download({ filename })` is always relative to the browser's download directory.
The only escape is `saveAs: true`, which is exposed as the **Ask where to save each file**
setting. Do not claim or attempt arbitrary filesystem paths.

---

## Things already tried that did not work

| Idea | Outcome |
|---|---|
| Detect local vs. remote tracks via `deviceId` | Remote receiver tracks carry one too. Only real capture devices have `groupId` |
| `maintain-resolution` for sharper video | 0.33 fps |
| `<video>` + `canvas.drawImage` in the offscreen doc | 0-frame files |
| Resolve the loopback on the first `ontrack` | Fires for audio first; the video track was lost |
| Embed title/author tags in the MP4 | `MediaRecorder` writes no `udta`/`meta` box and exposes no API. Hence the JSON sidecar |
| Full-resolution `getImageData` sampling in tests | Distorted the measured fps — a test artifact, not a product bug |
| `all_frames: true` for iframe-hosted calls | Duplicates every overlay, and the products targeted so far render in the top document. Left off until a real case needs it |
| Reading Dyte's `participant` property off the tile element | It lives in the page's JS world; a content script cannot see it. The rendered name tag is the readable source |

---

## Working style that fits this codebase

- **Measure, don't assume.** Nearly every fix here came from inspecting real output files —
  parsing MP4 boxes, counting decoded frames, checking reported resolution per frame. If you
  change encoding or timing, verify against a real file, not against reasoning.
- **Comments explain *why*, never *what*.** The existing comments record the trap that was hit.
  Match that: a comment that restates the code will be removed in review.
- **Density matches the file.** This codebase is deliberately compact — multiple statements per
  line where they form one thought. Fit in; do not reformat surrounding code.
- **No new runtime dependencies.** The extension ships zero. Dev dependencies are esbuild,
  TypeScript, `@types/chrome`, and optionally Playwright. Keep it that way.
- **Add a test for behaviour you change.** Pure logic → `tests/unit.test.mjs`. Anything involving
  real media, the DOM, or Chrome APIs → `tests/browser-smoke.mjs`.

## Definition of done

1. `npm run typecheck` clean.
2. `npm test` green.
3. `npm run test:browser` green (say so explicitly if you could not run it and why).
4. `npm run build` succeeds.
5. Docs updated when behaviour changed: `README.md` for users, this file for the next agent.

## Scope boundaries

Do not add, without the maintainer asking:

- telemetry, analytics, crash reporting, or any network call
- an account system, cloud sync, or upload
- transcription or any third-party media service
- anything that makes recording less visible to the person doing it
- broader host permissions than `https://meet.google.com/*`

If a change needs one of these, open an issue and make the case first.

## Maintainer

TemRevil — [temrevil@gmail.com](mailto:temrevil@gmail.com). Security issues go there privately,
not to a public issue.
