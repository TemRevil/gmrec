import type { TileKind } from "./types";

// Site adapters. Everything that knows about a particular meeting product lives here; the rest
// of the content script works in terms of a video element, its tile container, and a label.
//
// The generic adapter is not a stub — it is the one that runs on every site nobody has written
// an adapter for, and it is expected to work. It leans on what every WebRTC product has in
// common: a <video> whose srcObject is a MediaStream, a tile element wrapped around it, and the
// participant's name rendered somewhere inside that tile.

export type TileContext = { video: HTMLVideoElement; container: Element | null; kind: TileKind };

export type Adapter = {
  id: string;
  site: string;
  /** Selectors for the element that wraps one participant's tile, most specific first. */
  containers: string[];
  /** Extra name sources, tried before the shared label and text scan. */
  nameHints?: (ctx: TileContext) => string | null;
  /** A stable per-participant id, when the site exposes one. */
  stableId?: (ctx: TileContext) => string | null;
  /** Whether this product has a Pin control, labelled `Pin …` / `Unpin …`, that makes it send
   *  more detail for that tile. Pressing that control is the only mechanism used — a synthetic
   *  double-click on a tile does nothing, so do not set this by testing one. */
  spotlight: boolean;
};

// ---- Shadow-piercing DOM helpers -------------------------------------------------------------
// Web-component products (Dyte, which is what ADPList runs on, and others built with Stencil or
// Lit) render every tile inside an open shadow root. `document.querySelectorAll("video")` does
// not descend into those, so a plain query finds nothing at all on those sites.

/** Every video in the document, including ones inside open shadow roots. */
export function deepVideos(root: ParentNode = document): HTMLVideoElement[] {
  const found: HTMLVideoElement[] = [];
  const walk = (node: ParentNode) => {
    if (node instanceof Element && node.shadowRoot) walk(node.shadowRoot);
    for (const element of Array.from(node.querySelectorAll<HTMLElement>("*"))) {
      if (element instanceof HTMLVideoElement) found.push(element);
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };
  walk(root);
  return found;
}
/** Like `closest`, but steps out of shadow roots through their host elements. */
export function deepClosest(node: Element, selector: string): Element | null {
  let current: Element | null = node;
  while (current) {
    const hit = current.closest(selector);
    if (hit) return hit;
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}
/** Like `querySelectorAll`, descending into open shadow roots. */
export function deepQueryAll(root: ParentNode, selector: string): Element[] {
  const found: Element[] = [];
  const walk = (node: ParentNode) => {
    if (node instanceof Element && node.shadowRoot) walk(node.shadowRoot);
    for (const element of Array.from(node.querySelectorAll<HTMLElement>("*"))) {
      if (element.matches(selector)) found.push(element);
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };
  walk(root);
  return found;
}
/** Text content, including what is rendered inside open shadow roots. `textContent` alone stops
 *  at a shadow boundary and comes back empty for any element that renders its own content. */
export function deepText(node: Element): string {
  if (node.shadowRoot) {
    return Array.from(node.shadowRoot.children, child => deepText(child)).join(" ").replace(/\s+/g, " ").trim();
  }
  if (!node.childElementCount) return node.textContent?.trim() ?? "";
  return Array.from(node.children, child => deepText(child)).join(" ").replace(/\s+/g, " ").trim();
}
/** Leaf elements carrying visible text, shadow roots included. */
export function deepLeaves(root: ParentNode): HTMLElement[] {
  const found: HTMLElement[] = [];
  const walk = (node: ParentNode) => {
    if (node instanceof Element && node.shadowRoot) walk(node.shadowRoot);
    for (const element of Array.from(node.querySelectorAll<HTMLElement>("*"))) {
      if (element.shadowRoot) { walk(element.shadowRoot); continue; }
      if (!element.childElementCount) found.push(element);
    }
  };
  walk(root);
  return found;
}

// ---- Adapters ---------------------------------------------------------------------------------

const meet: Adapter = {
  id: "meet",
  site: "Google Meet",
  containers: ["[data-participant-id]"],
  // Meet marks your own tile with the account name rather than a control label.
  nameHints: ({ container }) => {
    const self = container?.closest("[data-self-name]") as HTMLElement | null;
    return self?.getAttribute("data-self-name")?.trim() || null;
  },
  stableId: ({ container }) => container?.getAttribute("data-participant-id") ?? null,
  // Meet sends a higher-quality stream for a tile it considers prominent, and exposes a real
  // Pin control on every tile.
  spotlight: true,
};

// ADPList runs its own sessions on Dyte (an ADPList booking can also be a Google Meet, Zoom or
// Teams link, in which case that product's adapter applies instead). Dyte's UI Kit is built with
// Stencil: every tile is a <dyte-participant-tile> with an open shadow root, and the name is
// rendered by a <dyte-name-tag> inside it. The participant object hangs off the element as a JS
// property, which a content script cannot see — it lives in the page's world, not ours — so the
// name is read from what the name tag actually renders.
const dyte: Adapter = {
  id: "dyte",
  site: "Dyte (ADPList and others)",
  containers: ["dyte-participant-tile", "dyte-simple-video", "dyte-screenshare-view"],
  nameHints: ({ container }) => {
    if (!container) return null;
    // The name tag renders into its own shadow root, so textContent on it is empty.
    for (const tag of deepQueryAll(container, "dyte-name-tag")) {
      const text = deepText(tag);
      if (text) return text;
    }
    return null;
  },
  // Dyte keeps the participant id on the element as a property rather than an attribute, so the
  // shared fallbacks (name, then stream id) do the keying.
  spotlight: false,
};

const generic: Adapter = {
  id: "generic",
  site: "Any meeting site",
  // Attribute conventions shared by most WebRTC products; the container heuristic in content.ts
  // takes over when none of them match.
  containers: [
    "[data-participant-id]", "[data-participant]", "[data-peer-id]", "[data-user-id]",
    "[data-member-id]", "[data-session-id]", "[data-testid*='participant' i]", "[data-testid*='tile' i]",
  ],
  spotlight: false,
};

const ADAPTERS = [meet, dyte, generic];

/** Which adapter drives a given page. Host match first, then feature detection, then generic. */
export function adapterFor(url: string, root: ParentNode = document): Adapter {
  let host = "";
  try { host = new URL(url).hostname; } catch { /* about:blank and friends */ }
  if (host === "meet.google.com") return meet;
  // A site is treated as a Dyte site whenever Dyte's elements are actually on the page, so this
  // covers ADPList and every other product embedding the same kit, without listing them.
  if (root.querySelector("dyte-meeting, dyte-participant-tile, dyte-simple-grid")) return dyte;
  return generic;
}
export function adapterById(id: string): Adapter | undefined {
  return ADAPTERS.find(adapter => adapter.id === id);
}
