# GMRec

A local Chrome extension that records a Google Meet call as **one clean video file per person** —
each taken from the live stream Meet delivers, not from pixels on your screen.

No server, no account, no upload. Everything stays on the machine it was recorded on.

```
Downloads/GMRec/Weekly-sync-2026-09-19-1430/
├── Mohammed-Ahmed.mp4          ← his camera, his aspect ratio, his voice
├── Mohammed-Ahmed-screen.mp4   ← his screen share, as its own file
├── self.mp4                    ← your camera + your microphone
├── meeting-audio.m4a           ← the whole meeting's sound, as a backup
└── recording-info.json         ← what each file contains
```

> [!IMPORTANT]
> Tell everyone in the meeting that you are recording, and record only with their agreement.
> Recording people without consent is illegal in many places. GMRec does not notify other
> participants, and it is not a substitute for asking.

---

## Why not just record the screen?

| | Screen / tab capture | GMRec |
|---|---|---|
| Source | Pixels of the rendered page | Each participant's own WebRTC track |
| Aspect ratio | The tile's crop in the current layout | The ratio the sender's camera actually produces |
| Window resized, tab switched | Changes the recording | No effect |
| Meet menu covering a tile | Recorded into the file | No effect |
| Tile scrolled out of view | Recording stops or goes blank | No effect |
| Output | One file, everyone in a grid | One file per person, editable separately |
| Mirroring | Whatever Meet showed | Matches what you saw, deliberately |

---

## Install

Requires **Chrome 120+**. Checks were run against Chrome 152 on Windows. Edge is untested.

```bash
npm install
npm run typecheck
npm test
npm run build
```

Then open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the
**`dist`** folder. If GMRec is already loaded from this folder, press its **Reload** button
instead, then refresh any open Meet tab.

A walkthrough opens by itself on first install. Reopen it any time from **Setup → How GMRec
works**.

---

## Recording

| Step | What you do |
|---|---|
| 1 | Get everyone's agreement to be recorded. |
| 2 | **Setup → Device setup → Allow & test.** Pick your camera and microphone, check the preview, then **Stop preview & save choices**. Nothing is recorded here. |
| 3 | Back in Meet, open GMRec. The **Record** tab lists every camera and screen share it can see. Tick the ones you want — each becomes its own file. |
| 4 | Press **Start recording**, in the popup or on the control bar GMRec adds to the Meet page. |
| 5 | Press **Stop & save**. Check Chrome Downloads for the session folder. |

Tiles can be ticked and unticked **while recording**: a new tick starts its own file from that
moment, an untick finalizes that file early. If someone starts presenting mid-recording, an
on-page prompt asks whether to add it.

### What ends up in each file

| File | Video | Audio |
|---|---|---|
| `<Name>.mp4` | That participant's camera, as Meet sends it | Their own voice when Meet exposes it separately, otherwise the meeting's shared audio |
| `<Name>-screen.mp4` | Their screen share | Same as above |
| `self.mp4` | Your selected camera | Your selected microphone — and nothing else |
| `meeting-audio.m4a` | — | The whole meeting, as a single backup track |
| `recording-info.json` | — | — (a manifest describing all of the above) |

Your microphone is deliberately kept out of other people's files, and is never played back
through your speakers.

---

## Where files are saved

**Setup → Save location** takes a path like `Work/Meetings`. Each session gets its own subfolder
there, named for the meeting and its date.

That path is always **inside the browser's Downloads folder** — a Chrome extension cannot write
anywhere else on disk. Two ways around that:

| Want | Do this |
|---|---|
| Move everything at once | Change Chrome's download location in `chrome://settings/downloads` |
| Pick a destination per file | Turn on **Ask where to save each file** (uses Chrome's Save-as dialog; it prompts once per file, and a session is usually 4+ files) |

Typed paths are sanitized before use: characters Chrome rejects become dashes, `..` cannot escape
upwards, and depth is capped at four folders. The Setup tab previews the exact resulting path.

---

## Quality and metadata

Recordings are **MP4 (H.264 / AAC)**, so a finished file has a real duration, seeks properly, and
opens anywhere. WebM is a fallback only.

| Setting | Value | Why |
|---|---|---|
| Video codec | H.264 **High** profile (`avc1.6400xx`) | Left to choose, Chrome writes Baseline — no CABAC, no B-frames, visibly worse at the same bitrate |
| Audio codec | AAC-LC (`mp4a.40.2`) | Plain `video/mp4` pairs H.264 with Opus, which some editors reject |
| Video bitrate | 6 Mbps at 720p, 12 Mbps at 1080p | These files are local; re-encoding should not be where quality is lost |
| Audio bitrate | 192 kbps | — |
| Resolution | Fixed for the whole file | Meet changes resolution mid-call; a normalizer holds it constant so players get the ratio right and no black frames appear |

`recording-info.json` sits beside the files with the meeting name and URL, session start/end and
time zone, the codecs and bitrates in use, and per file: who or what is in it, where it starts on
the session timeline, how long it runs, its resolution, its size, and whether it finished cleanly.

It is a sidecar because Chrome's `MediaRecorder` writes **no `udta`/`meta` boxes** and offers no
API to add title or author tags — a name cannot be embedded inside the MP4 itself. What the
container *can* carry (creation time, duration, resolution, frame rate, codec) is written by the
encoder as usual and repeated in the sidecar, so one read describes the whole session.

---

## It keeps recording

A recording ends when **you** stop it. None of the following finalizes a file:

- a participant switching their camera off, or switching cameras
- someone's voice cutting out
- a participant leaving the call
- the background service worker restarting
- Meet renegotiating the stream

Closing or reloading the Meet tab, or losing a capture device, stops the recording and saves
whatever is available.

### Backups and recovery

Chunks are written to the extension's local IndexedDB while recording. **Files → Local backups**
can re-download a copy or remove one. If the browser is forcibly closed, persisted chunks are
offered as **interrupted** recordings next time; those may be incomplete.

Backups consume disk space and are subject to browser storage eviction. Keep downloaded copies of
anything important. Finalization needs memory — multi-hour sessions are untested, so check files
periodically on long calls.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Nothing starts | Rebuild, reload GMRec in `chrome://extensions`, refresh Meet, then use the toolbar icon **from the Meet tab**. Read the error in the popup. |
| Permission denied | Open Device setup in its own tab; allow camera and microphone in that page's site controls **and** in your OS privacy settings. |
| Device unavailable | Reconnect it, or pick an available one and stop the preview. Some camera drivers refuse to be shared between Meet and another capture — participant-only mode still works. |
| No selectable video | The picker needs a *playing* video, not an avatar or an empty tile. Turn the camera on and keep the tile visible. |
| Hidden-tile warning | Return to Meet, pin the participant, and reselect if Meet swapped their video element. |
| Download missing | Check Chrome Downloads for a prompt or interruption, then use **Files → Download copy**. |
| Recording is slow | Choose 720p and close other video workloads. Confirm files play before a long session. |
| File reports infinite duration | That is a WebM fallback file. Convert it with `tools/convert-webm.ps1` (needs FFmpeg with H.264/AAC on PATH). |

---

## How it works

Each participant's real `MediaStreamTrack` is cloned in the Meet page and streamed to the
recorder over a local WebRTC loopback connection, so the recorder holds the original video —
never a screenshot of a tile.

```
Meet tab (content.ts)                 Service worker           Offscreen document
─────────────────────                 ──────────────           ──────────────────
finds <video> tiles        ──tiles──▶
clones each real track
  │                        ◀─signal──▶  relays WebRTC  ◀─signal──▶  receives tracks
  └── RTCPeerConnection ────────────── loopback ──────────────────▶ normalizes size
                                                                    MediaRecorder → MP4
                                       chrome.downloads ◀──blob───  IndexedDB chunks
```

| Piece | File | Role |
|---|---|---|
| Content script | `src/content.ts` | Detects tiles, reads names from Meet's accessibility labels, pins on select, clones tracks, draws on-page overlays |
| Service worker | `src/background.ts` | Message router and trust boundary; owns downloads, badge, tab lifecycle |
| Offscreen doc | `src/recorder.ts` | Receives loopback streams, normalizes resolution, encodes, persists chunks, writes the manifest |
| Popup | `src/popup.ts` | Tabbed UI: Record / Setup / Files |
| Shared | `src/shared.ts` | Validation, sanitizing, folder naming — the code the unit tests exercise directly |

More detail for anyone (or anything) changing the code lives in **[AGENTS.md](AGENTS.md)**.
Design rationale is in **[PRODUCT.md](PRODUCT.md)** and **[DESIGN.md](DESIGN.md)**.

---

## Development

| Command | Does |
|---|---|
| `npm run dev` | Watch TypeScript and static assets |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | 16 dependency-free unit tests |
| `npm run test:browser` | Full integration suite in a real Chrome |
| `npm run build` | Produce `dist/` |

The browser suite needs Playwright and a recent Chrome. Point `GMREC_CHROMIUM_PATH` at the
executable and `GMREC_PLAYWRIGHT_MODULE` at a Playwright module directory if they are not at
their default locations:

```bash
GMREC_CHROMIUM_PATH="/c/Program Files/Google/Chrome/Application/chrome.exe" npm run test:browser
```

It uses a disposable profile, a synthetic Meet fixture, fake devices and muted audio — never your
real profile, camera or microphone. Output lands in `test-results/`.

---

## Contributing

**Contributions are welcome from anyone.** Open an issue or send a pull request — no invitation
needed, and no prior involvement expected.

AI agents and LLMs are explicitly welcome too. Read **[AGENTS.md](AGENTS.md)** first: it maps the
architecture, states the invariants that are easy to break, and lists the findings that are not
obvious from reading the code. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the workflow.

---

## Privacy

GMRec has no backend and makes no network requests. Recordings are written to your Downloads
folder and buffered in the extension's local storage. Nothing is transmitted anywhere.

It requests `tabCapture` (meeting audio), `downloads` (saving files), `storage` (settings and
chunk backups), `offscreen` (the recorder document), `scripting` / `activeTab` / `tabs` (reaching
the Meet tab), and host access to `https://meet.google.com/*` only.

## License

[MIT](LICENSE) — free to use, modify and distribute.
