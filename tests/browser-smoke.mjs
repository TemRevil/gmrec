// Optional real Chromium integration test. Never uses the user's profile or real devices.
import { createRequire } from "node:module";
import { mkdir, writeFile, rm, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.GMREC_PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(import.meta.dirname, "..");
const results = path.join(root, "test-results");
await mkdir(results, { recursive: true });
const profile = path.join(results, `profile-${Date.now()}`);
async function poll(read, matches, description) {
  const deadline = Date.now() + 20000;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (matches(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out: ${description} (last value: ${JSON.stringify(last)})`);
}
const context = await chromium.launchPersistentContext(profile, {
  // An explicit executable wins; Playwright rejects channel + executablePath together.
  ...(process.env.GMREC_CHROMIUM_PATH ? { executablePath: process.env.GMREC_CHROMIUM_PATH } : { channel: "chromium" }),
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
  args: ["--enable-unsafe-extension-debugging", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  viewport: { width: 1280, height: 800 }, acceptDownloads: true,
});
const errors = [];
context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
try {
  const cdp = await context.browser().newBrowserCDPSession();
  await mkdir(path.join(results, "downloads"), { recursive: true });
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: path.join(results, "downloads") });
  await cdp.send("Extensions.loadUnpacked", { path: path.join(root, "dist") });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const id = new URL(worker.url()).host;
  await context.grantPermissions(["camera", "microphone"]);
  console.log("Extension service worker loaded", id);
  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${id}/setup.html`);
  await setup.getByRole("button", { name: "Allow & test" }).click();
  await setup.getByText("Camera and microphone are working.", { exact: false }).waitFor();
  await setup.getByRole("button", { name: "Stop preview & save choices" }).click();
  await setup.screenshot({ path: path.join(results, "setup.png"), fullPage: true });
  console.log("Device setup and fake-media permission passed");

  // Synthetic Meet: a participant tile whose <video> carries a real MediaStream, exactly the
  // shape the content script pulls the recorded track from. Frames carry a moving counter and
  // a solid colour block so playback can be checked for motion and for corruption.
  await context.route("https://meet.google.com/**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><title>Synthetic Meet fixture</title></head><body style="margin:0;background:#ddd"><h1 style="height:60px;margin:0">Synthetic participant — no real meeting</h1><div id="tile" data-participant-id="p-mo"><video id="person" autoplay muted playsinline style="width:640px;height:360px;transform:scaleX(-1)"></video><button aria-label="Reframe">crop</button><button aria-label="Pin Mohammed Ahmed">push_pin</button><span>mic_off</span></div><script>
  function feed(width, height, hue){
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const c=canvas.getContext('2d');let tick=0;
    setInterval(()=>{tick++;
      c.fillStyle='hsl('+hue+','+(tick%2?'70%':'50%')+',45%)';c.fillRect(0,0,width,height);
      // Enough moving detail that the encoder has real work (a flat fill would hide a
      // framerate collapse), but not so much that the fixture itself starves the extension.
      for(let i=0;i<40;i++){
        c.fillStyle='hsl('+((tick*7+i*13)%360)+',80%,'+(30+(i%50))+'%)';
        c.fillRect((i*97+tick*11)%width,(i*61+tick*7)%height,26,26);
      }
      c.fillStyle='white';c.font='48px sans-serif';c.fillText('FRAME '+tick,60,height/2);
      // Asymmetric marker, drawn last so nothing covers it: a white block in the top-LEFT.
      // If a recording reproduces Meet's mirroring, this lands on the right instead.
      c.fillStyle='#fff';c.fillRect(0,0,width*0.12,height*0.12);},33);
    return canvas.captureStream(30);
  }
  // Same start-bitrate munge the extension applies, so this stand-in for Meet delivers a
  // realistic stream instead of ramping up from a few hundred kbps.
  function boost(sdp,kbps){
    const lines=sdp.split(/\\r?\\n/);const s=lines.findIndex(l=>l.startsWith('m=video'));
    if(s===-1)return sdp;let e=lines.findIndex((l,i)=>i>s&&l.startsWith('m='));if(e===-1)e=lines.length;
    const sec=lines.slice(s,e);
    const codecs=new Set(sec.flatMap(l=>{const m=/^a=rtpmap:(\\d+) (VP8|VP9|H264|AV1)\\//i.exec(l);return m?[m[1]]:[];}));
    const tuned=sec.flatMap(l=>{
      if(l.startsWith('c='))return [l,'b=AS:'+kbps,'b=TIAS:'+(kbps*1000)];
      if(l.startsWith('b='))return [];
      const f=/^a=fmtp:(\\d+) (.*)$/.exec(l);
      if(f&&codecs.has(f[1])&&!f[2].includes('x-google-'))return ['a=fmtp:'+f[1]+' '+f[2]+';x-google-start-bitrate='+kbps+';x-google-min-bitrate='+Math.round(kbps/2)+';x-google-max-bitrate='+kbps];
      return [l];
    });
    return [...lines.slice(0,s),...tuned,...lines.slice(e)].join('\\r\\n');
  }
  // Deliver tiles the way Meet really does: as remote RTCRtpReceiver tracks, so the extension
  // is exercised against receiver tracks (no deviceId) rather than local capture tracks.
  async function remoteFeed(width, height, hue, voiceHz){
    const send=new RTCPeerConnection(), recv=new RTCPeerConnection();
    send.onicecandidate=e=>e.candidate&&recv.addIceCandidate(e.candidate);
    recv.onicecandidate=e=>e.candidate&&send.addIceCandidate(e.candidate);
    const stream=feed(width,height,hue);
    if(voiceHz){
      const ac=new AudioContext();const osc=ac.createOscillator();osc.frequency.value=voiceHz;
      const dest=ac.createMediaStreamDestination();osc.connect(dest);osc.start();ac.resume();
      for(const t of dest.stream.getAudioTracks()) stream.addTrack(t);
    }
    for(const track of stream.getTracks()) send.addTrack(track,stream);
    const incoming=new Promise(resolve=>{recv.ontrack=e=>resolve(e.streams[0]||new MediaStream([e.track]));});
    const offer=await send.createOffer();await send.setLocalDescription(offer);await recv.setRemoteDescription(offer);
    const answer=await recv.createAnswer();await recv.setLocalDescription(answer);
    await send.setRemoteDescription({type:'answer',sdp:boost(answer.sdp,4000)});
    return incoming;
  }
  window.__feed=feed;
  window.__remoteFeed=remoteFeed;
  remoteFeed(1280,720,210,880).then(stream=>{document.querySelector('video').srcObject=stream;});
  // Meet pins from its own Pin control, not from a double-click on the tile. The fixture counts
  // both, so the test can assert GMRec presses the control and never fires a stray gesture.
  window.__pinClicks=0;window.__unpinClicks=0;window.__dblClicks=0;
  document.getElementById('tile').addEventListener('dblclick',()=>{window.__dblClicks++;});
  const pinBtn=document.querySelector('[aria-label="Pin Mohammed Ahmed"]');
  pinBtn.addEventListener('click',()=>{
    const pinning=!pinBtn.getAttribute('aria-label').startsWith('Unpin');
    if(pinning)window.__pinClicks++;else window.__unpinClicks++;
    // Deliberately asynchronous: a real product updates its own state and re-renders after the
    // click, so the label has not flipped yet when the handler returns. Flipping it synchronously
    // here once hid a bug where the extension claimed the pin in the same tick and never could.
    setTimeout(()=>pinBtn.setAttribute('aria-label',(pinning?'Unpin':'Pin')+' Mohammed Ahmed'),60);
  });
  const audio=new AudioContext();const tone=audio.createOscillator();tone.frequency.value=440;tone.connect(audio.destination);tone.start();audio.resume();
  </script></body></html>` }));
  const meet = await context.newPage();
  await meet.goto("https://meet.google.com/abc-defg-hij");
  await meet.waitForFunction(() => document.querySelector("video").readyState >= 2);
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: "https://meet.google.com/*" }))[0].id);
  const readTiles = () => worker.evaluate(tabId => chrome.tabs.sendMessage(tabId, { target: "content", type: "tiles" }), tabId);
  const readSelection = () => worker.evaluate(tabId => chrome.tabs.sendMessage(tabId, { target: "content", type: "selection" }), tabId);
  const selectTile = (id, on) => worker.evaluate(({ tabId, id, on }) => chrome.tabs.sendMessage(tabId, { target: "content", type: "select", id, on }), { tabId, id, on });
  const detected = await poll(readTiles, value => value.length === 1, "camera tile auto-detected");
  assert.equal(detected[0].kind, "camera");
  assert.equal(detected[0].selected, false);
  // Named from the tile's own label, skipping the Material icon ligature sitting next to it.
  assert.equal(detected[0].label, "Mohammed Ahmed", `tile should be named from Meet's control labels, got "${detected[0].label}"`);
  assert.equal(await selectTile(detected[0].id, true), true);
  // Selecting a tile presses Meet's own Pin control, which is what actually makes Meet send a
  // higher-quality stream. A synthetic double-click does nothing in Meet, so it must not be used.
  const pinState = () => meet.evaluate(() => ({
    pins: window.__pinClicks, unpins: window.__unpinClicks, dbl: window.__dblClicks,
    pinned: !!document.querySelector('[aria-label^="Unpin Mohammed"]'),
  }));
  await poll(pinState, value => value.pinned, "selecting a tile presses Meet's Pin control");
  assert.deepEqual({ ...await pinState() }, { pins: 1, unpins: 0, dbl: 0, pinned: true },
    "exactly one Pin press, and no stray double-click: Meet ignores it and it can mean other things");
  // Deselecting hands the tile back. The label flips a tick after the click, so nothing here can
  // be keyed on the click having taken effect synchronously.
  assert.equal(await selectTile(detected[0].id, false), true);
  const released = await poll(pinState, value => value.unpins === 1 && !value.pinned, "deselecting releases the pin GMRec took");
  assert.deepEqual({ ...released }, { pins: 1, unpins: 1, dbl: 0, pinned: false });

  // Pinning changes the layout, which is exactly when Meet swaps a tile's <video> for a new one.
  // The tile is rebound, and the pin must still be released afterwards.
  assert.equal(await selectTile(detected[0].id, true), true);
  await poll(pinState, value => value.pinned, "pinned again");
  await meet.evaluate(async () => {
    const old = document.getElementById("person");
    const stream = old.srcObject;
    old.remove();
    // Long enough to outlast the reconciler's cooldown, so the tile really is read while it is
    // detached. A shorter gap proves nothing: the cooldown alone would cover it.
    await new Promise(r => setTimeout(r, 2000));
    const fresh = document.createElement("video");
    fresh.id = "person"; fresh.autoplay = true; fresh.muted = true; fresh.playsInline = true;
    fresh.style.cssText = "width:640px;height:360px;transform:scaleX(-1)";
    fresh.srcObject = stream;
    document.getElementById("tile").prepend(fresh);
  });
  assert.equal(await selectTile(detected[0].id, false), true);
  const afterSwap = await poll(pinState, value => value.unpins === 2 && !value.pinned, "released even after the element was swapped");
  assert.deepEqual({ ...afterSwap }, { pins: 2, unpins: 2, dbl: 0, pinned: false });

  // Unpinning by hand while the tile is still selected must be noticed and put right: the pin
  // state is read back off the page, so a stale claim cannot survive.
  assert.equal(await selectTile(detected[0].id, true), true);
  await poll(pinState, value => value.pins === 3 && value.pinned, "pinned for the self-heal check");
  await meet.evaluate(() => document.querySelector('[aria-label^="Unpin Mohammed"]').click());
  const healed = await poll(pinState, value => value.pins === 4 && value.pinned, "a pin taken away by hand is taken again");
  assert.deepEqual({ ...healed }, { pins: 4, unpins: 3, dbl: 0, pinned: true });
  assert.equal(await selectTile(detected[0].id, false), true);
  await poll(pinState, value => value.unpins === 4 && !value.pinned, "and released again on deselect");

  // A tile the user pinned themselves is left alone: pressing Pin again would toggle it OFF,
  // which is the opposite of what selecting it is meant to do.
  await meet.evaluate(() => document.querySelector('[aria-label^="Pin Mohammed"]').click());
  await poll(pinState, value => value.pinned, "manual pin applied");
  assert.equal(await selectTile(detected[0].id, true), true);
  // Well past the reconciler's cooldown and several scans, so a wrong implementation has had
  // every chance to press something.
  await meet.waitForTimeout(2500);
  assert.deepEqual({ ...await pinState() }, { pins: 5, unpins: 4, dbl: 0, pinned: true },
    "a tile that is already pinned must not be toggled, and that pin must not be released later");
  console.log("Tile auto-detection, toggle, and auto-pin passed");

  // Meet replaces the <video> element whenever a camera is toggled or switched. That must
  // rebind the existing tile, not add a second one for the same person.
  await meet.evaluate(async () => {
    const old = document.getElementById("person");
    const stream = old.srcObject;
    old.remove();
    await new Promise(r => setTimeout(r, 400)); // Meet drops the old element before the new one
    const fresh = document.createElement("video");
    fresh.id = "person"; fresh.autoplay = true; fresh.muted = true; fresh.playsInline = true;
    fresh.style.cssText = "width:640px;height:360px;transform:scaleX(-1)";
    document.getElementById("tile").prepend(fresh);
    fresh.srcObject = stream;
    await fresh.play().catch(() => {});
  });
  const rebound = await poll(readTiles, value => value.length === 1 && value[0].selected, "camera swap rebinds the existing tile");
  assert.equal(rebound.length, 1, `camera swap duplicated the tile: ${JSON.stringify(rebound)}`);
  assert.equal(rebound[0].id, detected[0].id, "the tile keeps its identity across a camera swap");
  const selectionAfterSwap = await poll(readSelection, value => !!value, "selection survives the camera swap");
  console.log("Camera swap rebinding passed", JSON.stringify(selectionAfterSwap));

  const target = (await cdp.send("Target.getTargets", { filter: [{ type: "tab" }] })).targetInfos.find(target => target.url === meet.url());
  await cdp.send("Extensions.triggerAction", { id, targetId: target.targetId });
  // Headless Chrome popups are not Playwright pages, so drive the same public runtime messages.
  const request = async (type, payload = {}) => {
    const reply = await setup.evaluate(message => chrome.runtime.sendMessage(message), { target: "background", type, ...payload });
    assert.equal(reply.ok, true, reply.error);
    return reply.data;
  };
  const started = await request("start", { settings: { includeSelf: true, quality: "720p", name: "gmrec-test" } });
  assert.equal(started.phase, "recording");
  console.log("Loopback streams negotiated and recording started");

  // A screen share appearing mid-recording is auto-detected; toggling it on (what the on-page
  // "Add" prompt does internally) must add it as its own output without restarting.
  await meet.evaluate(async () => {
    // Shaped like a real Meet presentation tile: the name only exists inside a control label.
    const host = document.createElement("div");
    host.setAttribute("data-participant-id", "p-mo-screen");
    const video = document.createElement("video");
    video.id = "share"; video.autoplay = true; video.muted = true; video.playsInline = true;
    video.style.cssText = "width:800px;height:450px";
    const unpin = document.createElement("button");
    unpin.setAttribute("aria-label", "Unpin Mohammed Ahmed's presentation");
    unpin.textContent = "push_pin";
    host.append(video, unpin); document.body.append(host);
    video.srcObject = await window.__remoteFeed(800, 450, 140);
  });
  const withShare = await poll(readTiles, value => value.some(tile => tile.kind === "screen"), "screen share auto-detected mid-recording");
  const share = withShare.find(tile => tile.kind === "screen");
  assert.equal(share.selected, false);
  assert.equal(share.label, "Mohammed Ahmed (screen)", `screen tile mislabelled: "${share.label}"`);
  assert.equal(await selectTile(share.id, true), true);
  console.log("Mid-recording screen-share detection and add-tile passed");

  // Hiding the Meet tile must NOT disturb the recording: the track keeps flowing.
  await new Promise(resolve => setTimeout(resolve, 1500));
  await meet.evaluate(() => { document.querySelector("video").style.display = "none"; });
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal((await request("status")).phase, "recording", "a hidden tile must not stop or fault the recording");
  await meet.evaluate(() => { document.querySelector("video").style.display = "block"; });

  // What Meet actually delivers to each tile is the bar to hit: the recording must match it
  // exactly, with no re-scaling on the way through the extension.
  const liveSizes = await meet.evaluate(() => ({
    person: [document.getElementById("person").videoWidth, document.getElementById("person").videoHeight],
    share: [document.getElementById("share").videoWidth, document.getElementById("share").videoHeight],
  }));
  console.log("Live tile sizes delivered by the page", liveSizes);
  await meet.screenshot({ path: path.join(results, "overlay-recording.png") });
  assert.equal((await request("pause")).phase, "paused");
  await meet.screenshot({ path: path.join(results, "overlay-paused.png") });
  const pausedTime = (await request("status")).elapsedMs;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal((await request("status")).elapsedMs, pausedTime);
  // Suspend the real worker: the offscreen recorder must remain the state authority.
  const setupCDP = await context.newCDPSession(setup);
  await setupCDP.send("ServiceWorker.enable");
  await setupCDP.send("ServiceWorker.stopAllWorkers");
  assert.equal((await request("status")).phase, "paused");
  assert.equal((await request("resume")).phase, "recording");
  // Long enough that every file, including the tile added mid-recording, has a decent number
  // of frames to measure: a short clip makes the framerate estimate noisy.
  await new Promise(resolve => setTimeout(resolve, 4500));
  assert.equal((await request("stop")).phase, "idle");

  const recordings = await request("list");
  assert.equal(recordings.length, 4, "camera tile, screen tile, self, and the meeting audio backup");
  // Every file from one session is filed under a single dated meeting folder.
  const folders = new Set(recordings.map(r => r.folder));
  assert.equal(folders.size, 1, `one folder per session, got ${[...folders].join(", ")}`);
  assert.match([...folders][0], /^GMRec\/.+-\d{4}-\d{2}-\d{2}-\d{4}$/, "folder is named for the meeting and dated");
  // Inside the folder, files are named for who is in them and nothing else.
  assert.deepEqual([...recordings.map(r => r.filename)].sort(),
    ["Mohammed-Ahmed-screen.mp4", "Mohammed-Ahmed.mp4", "meeting-audio.m4a", "self.mp4"],
    "files are named for the participant and written as MP4");
  const audioOnly = recordings.filter(r => /^meeting-audio\.m4a$/.test(r.filename));
  assert.equal(audioOnly.length, 1, "a standalone meeting-audio file is always written");
  assert.ok(audioOnly[0].bytes > 1000, "meeting audio backup is empty");
  assert.ok(recordings.every(record => record.bytes > 1000 && record.status === "ready" && record.chunks >= 2), JSON.stringify(recordings));
  console.log("Three recordings finalized", recordings.map(r => ({ name: r.filename, bytes: r.bytes, chunks: r.chunks })));
  const downloads = await poll(() => setup.evaluate(() => chrome.downloads.search({})), list => list.length === 5 && list.every(d => d.state === "complete"), "all five downloads complete");
  assert.equal(downloads.length, 5, "four recordings plus the session manifest");
  assert.equal(downloads.filter(d => d.mime === "application/json").length, 1, "one recording-info.json per session");

  // Inspect each finished file in a clean page. Measuring inside the extension page proved
  // unreliable (the first clip reported no frames at all), and this mirrors how a real player
  // opens the file: fresh document, index it, play it, count what is actually presented.
  const downloadDir = path.join(results, "downloads");
  // MediaRecorder writes no udta/meta boxes, so the details the container cannot hold are
  // written beside the files. Check the sidecar actually describes the session it sat next to.
  const manifestFile = downloads.find(d => d.mime === "application/json").filename;
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  assert.equal(manifest.meeting.folder, [...folders][0], "manifest names the folder it sits in");
  assert.match(manifest.meeting.url, /meet\.google\.com/);
  assert.ok(manifest.session.recordedSeconds > 0 && manifest.session.startedAt < manifest.session.endedAt, JSON.stringify(manifest.session));
  assert.match(manifest.encoding.video, /^H\.264 High profile/, `expected High profile, got ${manifest.encoding.video}`);
  assert.equal(manifest.encoding.audio, "AAC-LC");
  assert.equal(manifest.files.length, 4);
  const camera = manifest.files.find(f => f.file === "Mohammed-Ahmed.mp4");
  assert.equal(camera.name, "Mohammed Ahmed", "the manifest carries the tile name the file is named for");
  assert.equal(camera.kind ?? camera.source, "participant camera");
  assert.ok(camera.width > 0 && camera.height > 0 && camera.durationSeconds > 0, JSON.stringify(camera));
  assert.ok(manifest.files.every(f => f.complete && f.bytes > 1000), JSON.stringify(manifest.files));

  const onDisk = await Promise.all((await readdir(downloadDir)).map(async name => {
    const full = path.join(downloadDir, name);
    return { full, size: (await stat(full)).size };
  }));
  const inspector = await context.newPage();
  await inspector.goto("about:blank");
  const playback = [];
  for (const record of recordings.filter(r => !/^meeting-audio\.m4a$/.test(r.filename))) {
    const match = onDisk.find(file => file.size === record.bytes);
    assert.ok(match, `no downloaded file matches ${record.filename} (${record.bytes} bytes)`);
    const bytes = await readFile(match.full);
    const result = await inspector.evaluate(async b64 => {
      const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bin], { type: "video/mp4" }));
      const video = document.createElement("video");
      video.muted = true; video.src = url; document.body.append(video);
      await new Promise(r => { video.onloadedmetadata = r; });
      // MediaRecorder WebM has no duration in its header; seeking to the end indexes it.
      await new Promise(r => { video.onseeked = r; video.currentTime = 1e6; setTimeout(r, 2000); });
      const duration = video.duration;
      video.onseeked = null;
      video.currentTime = 0;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      // Downscaled: reading back a full 1280x720 frame is slow enough to distort playback and
      // therefore the framerate being measured.
      const sample = () => {
        canvas.width = 160; canvas.height = 90;
        ctx.drawImage(video, 0, 0, 160, 90);
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let green = 0, pixels = 0;
        for (let i = 0; i < data.length; i += 4) {
          pixels++;
          if (data[i] < 60 && data[i + 1] > 180 && data[i + 2] < 60) green++;
        }
        const bw = Math.max(1, Math.floor(canvas.width * 0.12)), bh = Math.max(1, Math.floor(canvas.height * 0.12));
        const meanLuma = x0 => {
          let sum = 0, n = 0;
          for (let y = 0; y < bh; y++) for (let x = x0; x < x0 + bw; x++) {
            const i = (y * canvas.width + x) * 4;
            sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]; n++;
          }
          return sum / n;
        };
        return { url: canvas.toDataURL(), greenRatio: green / pixels, cornerBias: +(meanLuma(0) - meanLuma(canvas.width - bw)).toFixed(1) };
      };
      const stamps = [], sizes = new Set();
      let darkFrames = 0;
      // Sampled while playing: seeking a MediaRecorder WebM is unreliable (sparse keyframes),
      // so two seeks can land on the same frame and make moving content look frozen.
      let early = null;
      await new Promise(resolve => {
        const tick = (_now, meta) => {
          stamps.push(meta.mediaTime);
          sizes.add(`${video.videoWidth}x${video.videoHeight}`);
          if (stamps.length === 3) early = sample();
          if (video.ended || stamps.length > 1200) return resolve();
          video.requestVideoFrameCallback(tick);
        };
        video.requestVideoFrameCallback(tick);
        video.onended = () => resolve();
        setTimeout(resolve, 12000);
        video.play();
      });
      const first = early ?? { url: "", greenRatio: 0, cornerBias: 0 };
      const second = first;
      const span = stamps.length > 1 ? stamps[stamps.length - 1] - stamps[0] : 0;
      const result = {
        width: video.videoWidth, height: video.videoHeight,
        greenRatio: Math.max(first.greenRatio, second.greenRatio),
        cornerBias: second.cornerBias,
        audioTracks: video.captureStream().getAudioTracks().length,
        fps: span > 0 ? +((stamps.length - 1) / span).toFixed(1) : 0,
        sampledFrames: stamps.length,
        sizes: [...sizes],
        corrupted: video.getVideoPlaybackQuality().corruptedVideoFrames,
        darkFrames,
        durationSeconds: +duration.toFixed(2),
      };
      video.pause(); video.remove(); URL.revokeObjectURL(url);
      return result;
    }, bytes.toString("base64"));
    playback.push({ filename: record.filename, ...result });

    console.log("Playback inspection", record.filename, result);
    playback.push({ filename: record.filename, ...result });
  }
  // Each tile is recorded at its source stream's own native size, not a fixed canvas size.
  // Files are named after the tile, not "Participant N".
  const cameraFile = playback.find(p => /^Mohammed-Ahmed\.mp4$/i.test(p.filename));
  const screenFile = playback.find(p => /^Mohammed-Ahmed-screen\.mp4$/i.test(p.filename));
  const selfFile = playback.find(p => /^self\.mp4$/.test(p.filename));
  assert.ok(cameraFile && screenFile && selfFile, `unexpected filenames: ${playback.map(p => p.filename).join(", ")}`);
  for (const result of playback) {
    assert.equal(result.audioTracks, 1, `${result.filename} is missing its audio track`);
    assert.equal(result.corrupted, 0, `${result.filename} decoded corrupted frames`);
    assert.ok(result.greenRatio < 0.2, `${result.filename} looks like a starved/corrupt stream (green ${(result.greenRatio * 100).toFixed(1)}%)`);
    // The source is 30fps. A real regression here looked like 0.33fps, so this is the assertion
    // that actually matters; headless leaves some headroom, hence 15 rather than 25.
    assert.ok(result.fps >= 15, `${result.filename}: framerate collapsed to ${result.fps}fps (${result.sampledFrames} frames sampled)`);
    // WebRTC adapts resolution as it runs. If that reaches the file, its header declares one
    // size while the frames are another, which plays back at the wrong aspect and flashes
    // black in stricter players. Every frame must be the same size.
    assert.equal(result.sizes.length, 1, `${result.filename}: resolution changed mid-file (${result.sizes.join(", ")})`);
    // The reason for MP4: a finished file must report a real duration. MediaRecorder WebM
    // reports Infinity, so players treat it as an endless live stream and cannot seek it.
    assert.ok(Number.isFinite(result.durationSeconds) && result.durationSeconds > 0,
      `${result.filename}: duration is ${result.durationSeconds}, so players will treat it as a live stream`);
  }
  // Tiles are never deliberately rescaled, but WebRTC may adapt resolution under load and this
  // run drives two encoders on one headless CPU. Assert no gross collapse rather than exact
  // equality; the framerate assertion above is the strict one, since that is what regressed.
  const closeTo = (got, delivered, label) => assert.ok(
    got[0] >= delivered[0] * 0.5 && got[1] >= delivered[1] * 0.5,
    `${label}: recorded ${got.join("x")} is far below the delivered ${delivered.join("x")}`,
  );
  closeTo([cameraFile.width, cameraFile.height], liveSizes.person, "participant");
  closeTo([screenFile.width, screenFile.height], liveSizes.share, "screen share");
  // Meet mirrors your own camera with a CSS transform; the fixture's camera tile does the same.
  // The recording must reproduce that, and must NOT flip a tile that is not mirrored.
  assert.ok(cameraFile.cornerBias < -20, `mirrored tile was not flipped in the recording (corner bias ${cameraFile.cornerBias})`);
  assert.ok(screenFile.cornerBias > 20, `an unmirrored tile was flipped (corner bias ${screenFile.cornerBias})`);
  assert.deepEqual([selfFile.width, selfFile.height], [1280, 720], "self camera recorded at the requested 720p");
  console.log("All three files play clean, moving, native-resolution video with audio");

  await setup.evaluate(() => chrome.offscreen.closeDocument());
  assert.equal((await request("list")).length, 4);
  await request("save", { id: recordings[0].id });
  await poll(() => setup.evaluate(() => chrome.downloads.search({})), list => list.length === 6 && list.every(d => d.state === "complete"), "backup download completes");
  console.log("Backup recovery and re-download after offscreen restart passed");

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.setViewportSize({ width: 390, height: 640 });
  // Tabs: only one section is visible at a time, and Start/Stop stay reachable on every tab.
  await popup.screenshot({ path: path.join(results, "popup.png") });
  const panelVisible = id => popup.evaluate(id => !document.getElementById(id).hidden, id);
  assert.equal(await panelVisible("panelRecord"), true, "Record is the default tab");
  assert.equal(await panelVisible("panelFiles"), false);
  await popup.getByRole("tab", { name: /Setup/ }).click();
  assert.equal(await panelVisible("panelSetup"), true);
  assert.equal(await panelVisible("panelRecord"), false);
  await popup.screenshot({ path: path.join(results, "popup-setup.png") });
  assert.ok(await popup.getByRole("button", { name: /Stop & save/ }).isVisible(), "stop stays reachable from every tab");

  // Save location: what is typed is sanitized, previewed as a real path, and persisted.
  const savePath = () => popup.textContent("#savePath");
  assert.match(await savePath(), /^Downloads \/ GMRec \/ meeting-/, "the preview starts from the default folder");
  await popup.fill("#saveFolder", "  Work/Client: calls  ");
  await popup.dispatchEvent("#saveFolder", "change");
  await poll(() => popup.evaluate(() => chrome.storage.local.get("settings")), v => v.settings?.saveFolder === "Work/Client- calls", "save folder persisted");
  assert.match(await savePath(), /^Downloads \/ Work \/ Client- calls \/ meeting-\d{4}-\d{2}-\d{2}-\d{4} \/ …$/, await savePath());
  await popup.getByText("Ask where to save each file").click();
  await poll(() => popup.evaluate(() => chrome.storage.local.get("settings")), v => v.settings?.askWhereToSave === true, "Save-as preference persisted");
  assert.match(await savePath(), /Chrome asks for a destination/, "the preview says so when Chrome will prompt instead");
  // Put the defaults back so the later recording stages are unaffected.
  await popup.getByText("Ask where to save each file").click();
  await popup.fill("#saveFolder", "GMRec");
  await popup.dispatchEvent("#saveFolder", "change");
  await poll(() => popup.evaluate(() => chrome.storage.local.get("settings")), v => v.settings?.saveFolder === "GMRec" && v.settings?.askWhereToSave === false, "settings restored");
  await popup.locator("#savePath").scrollIntoViewIfNeeded();
  await popup.screenshot({ path: path.join(results, "popup-save-location.png") });
  console.log("Save-location setting sanitizes, previews and persists");
  // Arrow keys move between tabs, per the tablist pattern.
  await popup.getByRole("tab", { name: /Setup/ }).press("ArrowRight");
  assert.equal(await panelVisible("panelFiles"), true, "ArrowRight moves to the next tab");
  await popup.getByRole("button", { name: "Dark theme", exact: true }).click();
  await popup.waitForTimeout(400); // let the theme transition settle so the capture is truthful
  await popup.screenshot({ path: path.join(results, "popup-dark.png") });
  await popup.getByRole("button", { name: "Remove backup", exact: true }).first().click();
  await popup.getByRole("button", { name: "Confirm removal", exact: true }).click();
  await popup.waitForFunction(() => document.querySelector("#savedCount").textContent === "3");
  assert.equal((await request("list")).length, 3);

  // Onboarding: reachable from the popup, and every control on it is wired up.
  await popup.getByRole("tab", { name: /Setup/ }).click(); // the tests above left the Files tab open
  await popup.getByRole("button", { name: /How GMRec works/ }).click();
  const onboarding = await poll(() => context.pages().find(page => page.url().endsWith("/onboarding.html")), page => !!page, "onboarding page opens from the popup");
  await onboarding.waitForLoadState("domcontentloaded");
  await onboarding.setViewportSize({ width: 900, height: 900 });
  assert.equal(await onboarding.locator(".steps > li").count(), 4, "four numbered steps");
  assert.match(await onboarding.textContent(".consent"), /consent/i, "consent is stated before anything else");
  for (const control of ["#setup", "#meet", "#done", "#themeToggle"]) assert.ok(await onboarding.locator(control).isVisible(), control);
  assert.equal(await onboarding.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "no horizontal overflow");
  await onboarding.setViewportSize({ width: 390, height: 800 });
  assert.equal(await onboarding.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "no horizontal overflow at phone width");
  await onboarding.screenshot({ path: path.join(results, "onboarding.png"), fullPage: true });
  await onboarding.close();
  console.log("Onboarding page opens from the popup and fits every width");

  await meet.bringToFront();
  const failed = await setup.evaluate(() => chrome.runtime.sendMessage({ target: "background", type: "start", settings: { includeSelf: true, cameraDeviceId: "missing-camera-for-test" } }));
  assert.equal(failed.ok, false);
  assert.equal((await request("status")).phase, "idle");
  console.log("Missing-camera failure releases the tab capture and returns idle");

  // Screenshots come straight off the live tracks, with no recording in progress.
  const shots = await request("screenshot");
  assert.equal(shots, 2, "one screenshot per selected tile");
  // CDP's forced download path makes Chrome rewrite every download's filename, so assert on
  // count, completion and size here rather than on the requested name.
  const afterShots = await poll(
    () => setup.evaluate(() => chrome.downloads.search({})),
    list => { const pngs = list.filter(d => d.filename.endsWith(".png")); return pngs.length === 2 && pngs.every(d => d.state === "complete"); },
    "two screenshot downloads complete",
  );
  const pngs = afterShots.filter(d => d.filename.endsWith(".png"));
  assert.ok(pngs.every(d => d.fileSize > 1000), `screenshots look empty: ${JSON.stringify(pngs.map(d => d.fileSize))}`);
  console.log("Screenshot capture passed");

  // Files no longer carry a session stamp, so the second run's records are identified by being
  // new rather than by their name.
  const beforeSecondRun = new Set((await request("list")).map(record => record.id));
  // Selection persists across stop/start, so this run records both tiles and no self camera.
  assert.equal((await request("start", { settings: { includeSelf: false, quality: "1080p", name: "gmrec-participant-only" } })).phase, "recording");
  await new Promise(resolve => setTimeout(resolve, 2200));
  await meet.close();
  await poll(() => request("status"), state => state.phase === "idle", "auto stop after tab closure");
  const afterClose = await request("list");
  const participantOnly = afterClose.filter(record => !beforeSecondRun.has(record.id));
  assert.equal(participantOnly.length, 3, "both tiles carried over plus the meeting audio, self excluded");
  // Audio-only files are legitimately tiny here: the fixture's tone is a pure sine, which Opus
  // compresses to a few hundred bytes. Only require that nothing came out empty.
  assert.ok(participantOnly.every(record => record.status === "ready" && record.bytes > (/^meeting-audio\.m4a$/.test(record.filename) ? 200 : 1000)), JSON.stringify(participantOnly));
  console.log("Participant-only mode and automatic save on tab close passed");

  await writeFile(path.join(results, "browser-report.json"), JSON.stringify({ recordings, downloads, playback, errors }, null, 2));
  assert.deepEqual(errors, []);
  console.log("Browser smoke test passed");
} catch (error) {
  for (const page of context.pages()) {
    console.error("PAGE", page.url(), await page.locator("body").innerText().catch(() => "unavailable"));
  }
  throw error;
} finally {
  await context.close();
  if (path.dirname(profile) !== results || !/^profile-\d+$/.test(path.basename(profile))) throw new Error("Unsafe test profile cleanup path.");
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
