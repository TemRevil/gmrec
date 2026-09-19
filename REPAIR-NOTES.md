# GMRec repair notes

## Faults found in 0.1

- Background and recorder listeners used identical unaddressed commands, creating response races and routing ambiguity. The recorder did not return success or failure to its caller.
- The hidden recorder called `chrome.downloads`, although offscreen documents only support the `chrome.runtime` extension API.
- The self-camera animation stopped after the first frame because it checked the recorder array before that array was initialized. Separate animation loops also had incomplete cleanup.
- Capture failures could leave acquired devices running, and the UI could report recording before startup succeeded.
- Recording state and the selected crop were held only in background globals, which are lost when a Manifest V3 worker shuts down.
- The crop was fixed at selection time, could refer to a different tab, and allowed arbitrary non-video elements.
- Tab audio was captured without restoring speaker playback.
- Camera/microphone tests leaked resources on repeated use, selections were not saved, and popup closure discarded readiness state.
- General popup CSS was injected into Meet. Flex styling also overrode the recording panel's hidden state.
- Video chunks existed only in memory, with no download-retry path, failure reporting, or object-URL cleanup.
- The build deleted the previous output before a new build succeeded and did not watch static assets. The converter overwrote MP4 files without an explicit overwrite option.

## Changes

The recorder is now the authority for its lifecycle, with addressed request/reply messages and serialized recording commands. Background handles privileged downloads and toolbar state. The content script owns the live selection, checks its current geometry and identity, and reports it only for its own tab. Its picker uses isolated shadow DOM without injecting general CSS.

Both canvases share a tracked drawing timer and explicitly submit completed frames to their capture tracks. Acquired streams are registered immediately and released on startup failure, stop, or source loss. Tab audio is routed to an AudioContext destination. Output chunks and metadata are stored locally as recording proceeds. Downloads use temporary blob URLs retained until completion/interruption, and local copies are retained for retries.

The popup adds saved choices, a dedicated device setup page, participant-only recording, resolution/framing controls, filename prefixes, accurate pause/resume state, warnings, and a local backup library. Build and conversion helpers were corrected, and the distribution is version 0.2.0.

## Validation

- TypeScript strict typecheck and production build.
- Ten unit/regression tests covering geometry, settings, routing, worker restart, start errors, tab validation, extension pages, sender restrictions, and manifest isolation.
- Browser integration uses the actual built extension in an isolated Chrome profile, a local synthetic Meet fixture, and fake media devices. It exercises permissions/setup, selection, real tab capture, separate MediaRecorders, crop resizing, pause/resume, a real worker stop/restart, finalization, completed downloads, playback with moving frames and audio tracks, persistent recovery after offscreen recreation, retry download, and backup removal through the popup.
- Additional browser cases cover missing-camera cleanup, participant-only capture, hidden-tile warnings, and automatic saving when the source tab closes. Browser reports and UI screenshots are generated in `test-results/`.

The test harness does not replace a live Google Meet compatibility test: Meet can change its DOM and camera behavior. Physical-device combinations, Edge, multi-hour recordings, storage exhaustion, and full FFmpeg conversion still require separate checks. A full FFmpeg build with H.264/AAC support was not available on PATH.

## Platform references

- [Offscreen API: supported extension APIs and document lifetime](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [Tab capture: stream-ID scope and preserving playback](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)
- [Service worker lifecycle and state persistence](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
