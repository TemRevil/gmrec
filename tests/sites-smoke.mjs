// Site adapters against a real Chrome. Covers the two things that are easy to get wrong away
// from Google Meet: finding tiles that live inside shadow roots, and naming them without any
// participant-id attribute to key on.
import { createRequire } from "node:module";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.GMREC_PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(import.meta.dirname, "..");
const results = path.join(root, "test-results");
await mkdir(results, { recursive: true });
const profile = path.join(results, `sites-profile-${Date.now()}`);

async function poll(read, matches, description) {
  const deadline = Date.now() + 15000;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (matches(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out: ${description} (last value: ${JSON.stringify(last)})`);
}

// A feed built the way the Meet fixture builds one: delivered as a remote receiver track, so the
// extension sees what it would really see rather than a local capture track.
const FEED = `
  function feed(w,h,hue){
    const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
    const c=canvas.getContext('2d');let tick=0;
    setInterval(()=>{tick++;
      c.fillStyle='hsl('+hue+',60%,45%)';c.fillRect(0,0,w,h);
      c.fillStyle='white';c.font='40px sans-serif';c.fillText('F'+tick,40,h/2);},33);
    return canvas.captureStream(30);
  }
  async function remoteFeed(w,h,hue){
    const send=new RTCPeerConnection(), recv=new RTCPeerConnection();
    send.onicecandidate=e=>e.candidate&&recv.addIceCandidate(e.candidate);
    recv.onicecandidate=e=>e.candidate&&send.addIceCandidate(e.candidate);
    const stream=feed(w,h,hue);
    for(const t of stream.getTracks()) send.addTrack(t,stream);
    const incoming=new Promise(r=>{recv.ontrack=e=>r(e.streams[0]||new MediaStream([e.track]));});
    const offer=await send.createOffer();await send.setLocalDescription(offer);await recv.setRemoteDescription(offer);
    const answer=await recv.createAnswer();await recv.setLocalDescription(answer);
    await send.setRemoteDescription({type:'answer',sdp:answer.sdp});
    return incoming;
  }`;

// ADPList's own sessions run on Dyte, whose UI Kit is Stencil: every tile is a custom element
// with an OPEN shadow root, the video lives inside it, and the name is rendered by a nested
// <dyte-name-tag> that renders into a shadow root of its own. A plain
// document.querySelectorAll("video") finds nothing here at all.
const DYTE_FIXTURE = `<!doctype html><html><head><title>Mentorship with Aya – ADPList</title></head>
<body style="margin:0;background:#111"><dyte-meeting></dyte-meeting><div id="grid"></div><script>
${FEED}
class NameTag extends HTMLElement{
  connectedCallback(){const sr=this.attachShadow({mode:'open'});
    sr.innerHTML='<div class="name"><span>'+(this.getAttribute('data-name')||'')+'</span></div>';}
}
class Tile extends HTMLElement{
  connectedCallback(){
    const sr=this.attachShadow({mode:'open'});
    sr.innerHTML='<div class="tile"><video autoplay muted playsinline style="width:480px;height:270px"></video>'
      + '<dyte-name-tag data-name="'+this.getAttribute('data-name')+'"></dyte-name-tag>'
      + '<button aria-label="More">more_vert</button></div>';
    remoteFeed(1280,720,this.getAttribute('data-hue')|0).then(s=>{sr.querySelector('video').srcObject=s;});
  }
}
customElements.define('dyte-name-tag',NameTag);
customElements.define('dyte-participant-tile',Tile);
for(const [name,hue] of [['Aya Hassan',200],['Mohammed Ahmed',20]]){
  const tile=document.createElement('dyte-participant-tile');
  tile.setAttribute('data-name',name);tile.setAttribute('data-hue',hue);
  document.getElementById('grid').append(tile);
}
</script></body></html>`;

// A site with no conventions at all: no participant ids, no custom elements, just nested divs.
// This is what the generic adapter has to cope with, and it is the common case.
const PLAIN_FIXTURE = `<!doctype html><html><head><title>Standup</title></head>
<body style="margin:0"><div id="grid"></div><script>
${FEED}
for(const [name,hue] of [['Lina Park',150],['Sam Okafor',300]]){
  const tile=document.createElement('div');
  tile.innerHTML='<div class="wrap"><video autoplay muted playsinline style="width:480px;height:270px"></video>'
    + '<div class="label"><span>'+name+'</span></div></div>';
  document.getElementById('grid').append(tile);
  remoteFeed(1280,720,hue).then(s=>{tile.querySelector('video').srcObject=s;});
}
</script></body></html>`;

const context = await chromium.launchPersistentContext(profile, {
  ...(process.env.GMREC_CHROMIUM_PATH ? { executablePath: process.env.GMREC_CHROMIUM_PATH } : { channel: "chromium" }),
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: ["--enable-unsafe-extension-debugging", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  viewport: { width: 1280, height: 800 },
});
const errors = [];
context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
try {
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send("Extensions.loadUnpacked", { path: path.join(root, "dist") });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const id = new URL(worker.url()).host;

  // Requests must come from an extension page: a service worker does not receive its own
  // runtime messages, and the worker answers for whichever tab is currently active.
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${id}/setup.html`);
  const ask = (type, payload = {}) => ext.evaluate(async ([type, payload]) =>
    chrome.runtime.sendMessage({ target: "background", type, ...payload }), [type, payload]);
  const tilesOn = async page => {
    await page.bringToFront();
    const reply = await ask("tiles");
    return reply.ok ? reply.data : { error: reply.error };
  };

  // ---- Dyte / ADPList -------------------------------------------------------------------------
  await context.route("https://adplist.org/**", route => route.fulfill({ contentType: "text/html", body: DYTE_FIXTURE }));
  const adplist = await context.newPage();
  await adplist.goto("https://adplist.org/meeting");
  // The fixture is proof the discovery is real: nothing is reachable without piercing the roots.
  assert.equal(await adplist.evaluate(() => document.querySelectorAll("video").length), 0,
    "fixture is wrong: the videos must be inside shadow roots for this test to mean anything");

  const dyteTiles = await poll(() => tilesOn(adplist), list => Array.isArray(list) && list.length === 2, "two Dyte tiles detected");
  assert.deepEqual([...dyteTiles.map(tile => tile.label)].sort(), ["Aya Hassan", "Mohammed Ahmed"],
    `names must come from the shadow-rendered name tag, got ${JSON.stringify(dyteTiles)}`);
  assert.ok(dyteTiles.every(tile => tile.kind === "camera"), JSON.stringify(dyteTiles));
  // Ids stay stable across scans, so a tile is not rediscovered every 500ms.
  const again = await tilesOn(adplist);
  assert.deepEqual([...again.map(t => t.id)].sort(), [...dyteTiles.map(t => t.id)].sort(), "tile ids churned between scans");
  console.log("Dyte (ADPList) tiles found inside shadow roots and named", dyteTiles.map(t => t.label));

  // Selection survives, which is what the recorder is handed.
  await ask("select", { id: dyteTiles[0].id, on: true });
  const selected = (await ask("selection")).data;
  assert.equal(selected.tiles.length, 1);
  assert.ok(["Aya Hassan", "Mohammed Ahmed"].includes(selected.tiles[0].label), JSON.stringify(selected));
  console.log("Selection carries the real name through to the recorder");
  await adplist.close();

  // ---- A site with no conventions -------------------------------------------------------------
  await context.unroute("https://adplist.org/**");
  await context.route("https://adplist.org/**", route => route.fulfill({ contentType: "text/html", body: PLAIN_FIXTURE }));
  const plain = await context.newPage();
  await plain.goto("https://adplist.org/standup");
  const plainTiles = await poll(() => tilesOn(plain), list => Array.isArray(list) && list.length === 2, "two plain tiles detected");
  assert.deepEqual([...plainTiles.map(tile => tile.label)].sort(), ["Lina Park", "Sam Okafor"],
    `the generic adapter must read the visible name chip, got ${JSON.stringify(plainTiles)}`);
  console.log("Generic adapter names tiles with no participant ids and no custom elements");
  await plain.close();

  // ---- A site nobody allowed ------------------------------------------------------------------
  await context.route("https://not-allowed.example/**", route => route.fulfill({ contentType: "text/html", body: PLAIN_FIXTURE }));
  const stranger = await context.newPage();
  await stranger.goto("https://not-allowed.example/room");
  await stranger.bringToFront();
  const refused = await ask("tiles");
  assert.equal(refused.ok, false, "an un-added site must not be recordable");
  assert.match(refused.error, /add any other site under Setup/i, refused.error);
  console.log("An un-added site is refused until the user allows it");

  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  console.log("Site adapter smoke test passed");
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
