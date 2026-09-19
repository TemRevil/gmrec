# GMRec

## What it is

A local-only Chrome extension that records Google Meet calls. Each participant camera and each
screen share is captured from its own live stream and written to its own WebM file, alongside an
optional file of the user's own camera and microphone. Nothing is uploaded.

## Register

**Product.** Design serves the task. The user is mid-call; the interface should disappear into
the work and be readable in a glance.

## Who uses it

Someone running a call they need a recording of: interviews, user research sessions, client
calls, podcast guests, lessons. They are not a video professional. They are talking to someone
while they use it, so every control has to be understood without reading a manual and without
breaking eye contact for more than a second.

## Scene

Mid-interview on a client call. The browser tab is already dark. They glance at a small control
in the corner to confirm the recording is still running, then look straight back at the person
they are talking to. Often at night, often on a laptop, usually with one hand.

This forces the answer: the on-page surface is **dark-native**. A bright panel over a dark Meet
call glares and pulls the eye away from the conversation. State must be legible peripherally.

## Surfaces

| Surface | Where | Notes |
|---|---|---|
| Popup | Toolbar, 390px | Setup and selection. Supports light and dark. |
| Control bar | Injected, on top of Meet | Record / pause / stop / screenshot + timer. Dark only. Draggable. |
| Preview stack | Injected, on top of Meet | Live thumbnails of what is being recorded. Dark only. Draggable. |
| Share prompt | Injected, on top of Meet | Transient: "a screen share appeared, record it too?" |
| Device setup | Own tab | Camera/mic permission and check. |

## The constraint that drives the palette

The injected surfaces sit **on top of Google Meet**, whose own chrome is near-black with a **red
hang-up button bottom-center** and blue accents. The control bar sits bottom-right.

1. **Red is reserved.** In Meet, red bottom-of-screen means *leave the call*. A red primary
   button on our bar invites a catastrophic misclick mid-interview. Red is therefore used for
   exactly one thing: the live recording tally, and the stop action it belongs to.
2. **Blue is unavailable.** It reads as Meet's own UI, so our controls would look like Meet's
   controls and users would not know which product they are operating.
3. Our accent must be a third thing, clearly ours, clearly not Meet's.

## Color strategy

**Restrained** (the product floor): tinted near-black surfaces, one accent, semantic state colors.

The vocabulary is broadcast equipment: a dark chassis, cool indicator lighting, and a red tally
light that means *you are live*. That metaphor is earned here rather than decorative, because the
product genuinely is a recorder and the tally genuinely is a live indicator.

- **Accent (cyan-teal):** interactive affordances, focus, selection, brand. Distinct from both
  Meet red and Meet blue.
- **Tally (red):** live recording only, and stop. Never decoration, never a non-stop button.
- **Amber:** paused.

## Non-negotiables

- Recording state readable at a glance, from the corner of the eye, without reading text.
- Never mistakable for Meet's own hang-up control.
- Every control keyboard reachable with a visible focus ring; body text ≥ 4.5:1.
- Motion conveys state only. Respect `prefers-reduced-motion`.
- The injected surfaces must never cover Meet's bottom-center toolbar.
