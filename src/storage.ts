import type { SavedRecording } from "./types";

let database: Promise<IDBDatabase> | undefined;
function openDB(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("gmrec-recordings", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("recordings", { keyPath: "id" });
      request.result.createObjectStore("chunks", { keyPath: ["id", "index"] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
  });
}
function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("Recording storage transaction was aborted."));
    tx.onerror = () => reject(tx.error ?? new Error("Recording storage failed."));
  });
}
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
export async function saveMetadata(record: SavedRecording): Promise<void> {
  const tx = (await openDB()).transaction("recordings", "readwrite");
  tx.objectStore("recordings").put(record);
  await complete(tx);
}
export async function appendChunk(record: SavedRecording, blob: Blob): Promise<void> {
  const tx = (await openDB()).transaction(["recordings", "chunks"], "readwrite");
  tx.objectStore("chunks").put({ id: record.id, index: record.chunks, blob });
  const updated = { ...record, chunks: record.chunks + 1, bytes: record.bytes + blob.size };
  tx.objectStore("recordings").put(updated);
  await complete(tx);
  Object.assign(record, updated);
}
export async function listRecordings(): Promise<SavedRecording[]> {
  const tx = (await openDB()).transaction("recordings", "readonly");
  return (await result<SavedRecording[]>(tx.objectStore("recordings").getAll())).sort((a, b) => b.createdAt - a.createdAt);
}
export async function readRecording(id: string): Promise<{ record: SavedRecording; blob: Blob }> {
  const tx = (await openDB()).transaction(["recordings", "chunks"], "readonly");
  const metadata = result<SavedRecording | undefined>(tx.objectStore("recordings").get(id));
  const chunks = result<{ blob: Blob }[]>(tx.objectStore("chunks").getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])));
  const [record, parts] = await Promise.all([metadata, chunks]);
  if (!record || !parts.length) throw new Error("No saved video data is available for this recording.");
  return { record, blob: new Blob(parts.map(p => p.blob), { type: record.mimeType }) };
}
export async function deleteRecording(id: string): Promise<void> {
  const tx = (await openDB()).transaction(["recordings", "chunks"], "readwrite");
  tx.objectStore("recordings").delete(id);
  tx.objectStore("chunks").delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
  await complete(tx);
}
