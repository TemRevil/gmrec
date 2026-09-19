import { element, initTheme, send } from "./client";
import { errorMessage, normalizeSettings } from "./shared";
import type { RecorderState } from "./types";

const camera = element<HTMLSelectElement>("camera");
const microphone = element<HTMLSelectElement>("microphone");
const preview = element<HTMLVideoElement>("preview");
const test = element<HTMLButtonElement>("test");
const stop = element<HTMLButtonElement>("stopPreview");
const status = element("status");
let stream: MediaStream | undefined;
let audio: AudioContext | undefined;
let frame = 0;
let generation = 0;
let savedCamera = "default", savedMicrophone = "default";
initTheme();
function cleanup() {
  generation++;
  cancelAnimationFrame(frame);
  stream?.getTracks().forEach(track => track.stop()); stream = undefined;
  void audio?.close().catch(() => {}); audio = undefined;
  preview.srcObject = null; preview.hidden = true;
  element("level").style.width = "0%";
  element("level").parentElement!.setAttribute("aria-valuenow", "0");
  stop.disabled = true;
}
async function devices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  for (const [select, kind, saved] of [[camera, "videoinput", savedCamera], [microphone, "audioinput", savedMicrophone]] as const) {
    const current = select.value !== "default" ? select.value : saved;
    const entries = all.filter(device => device.kind === kind && device.deviceId && device.deviceId !== "default");
    const defaultOption = new Option(kind === "videoinput" ? "Default camera" : "Default microphone", "default");
    select.replaceChildren(defaultOption, ...entries.map((device, i) => new Option(device.label || `${kind === "videoinput" ? "Camera" : "Microphone"} ${i + 1}`, device.deviceId)));
    select.value = Array.from(select.options).some(option => option.value === current) ? current : "default";
  }
}
async function save() {
  const stored = await chrome.storage.local.get("settings");
  const settings = normalizeSettings({ ...stored.settings, cameraDeviceId: camera.value, microphoneDeviceId: microphone.value });
  savedCamera = camera.value; savedMicrophone = microphone.value;
  await chrome.storage.local.set({ settings, deviceLabels: { camera: camera.selectedOptions[0]?.text, microphone: microphone.selectedOptions[0]?.text } });
}
for (const select of [camera, microphone]) select.addEventListener("change", () => { cleanup(); void save().then(() => { status.textContent = "Device choice saved. Click Allow & test to check it."; }).catch(error => { status.textContent = errorMessage(error); }); });
test.addEventListener("click", () => { void (async () => {
  test.disabled = true; cleanup();
  const request = generation;
  try {
    const current = await send<RecorderState>("status");
    if (current.phase !== "idle") throw new Error("Stop the active recording before testing devices.");
    status.textContent = "Allow camera and microphone access in the browser prompt…";
    const incoming = await navigator.mediaDevices.getUserMedia({ video: camera.value === "default" ? true : { deviceId: { exact: camera.value } }, audio: microphone.value === "default" ? true : { deviceId: { exact: microphone.value } } });
    if (request !== generation) { incoming.getTracks().forEach(track => track.stop()); return; }
    stream = incoming; preview.srcObject = stream; preview.hidden = false; await preview.play();
    audio = new AudioContext(); await audio.resume();
    const analyser = audio.createAnalyser(); analyser.fftSize = 256;
    audio.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const draw = () => {
      analyser.getByteTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, sample) => sum + ((sample - 128) / 128) ** 2, 0) / samples.length);
      const value = Math.min(100, Math.round(rms * 300));
      element("level").style.width = `${value}%`;
      element("level").parentElement!.setAttribute("aria-valuenow", String(value));
      frame = requestAnimationFrame(draw);
    };
    draw(); await devices(); await save(); stop.disabled = false;
    status.textContent = "Camera and microphone are working. Speak to check the meter, then stop the preview before returning to Meet.";
  } catch (error) { cleanup(); status.textContent = errorMessage(error); }
  finally { test.disabled = false; }
})().catch(error => { status.textContent = errorMessage(error); }); });
stop.addEventListener("click", () => { cleanup(); void save().then(() => { status.textContent = "Choices saved and devices released. Return to Meet and open GMRec to start recording."; }).catch(error => { status.textContent = errorMessage(error); }); });
window.addEventListener("pagehide", cleanup);
document.addEventListener("visibilitychange", () => { if (document.hidden) cleanup(); });
navigator.mediaDevices.addEventListener("devicechange", () => { cleanup(); void devices().then(save).catch(error => { status.textContent = errorMessage(error); }); });
void chrome.storage.local.get("settings").then(stored => {
  const settings = normalizeSettings(stored.settings); savedCamera = settings.cameraDeviceId; savedMicrophone = settings.microphoneDeviceId; return devices();
}).catch(error => { status.textContent = errorMessage(error); });
