let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; onProgress?: (i: number) => void }>();
function get(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../physics/worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (ev: MessageEvent) => {
      const m = ev.data; const p = pending.get(m.id); if (!p) return;
      if (m.type === "progress") { p.onProgress?.(m.i); return; }
      pending.delete(m.id);
      if (m.type === "error") p.reject(new Error(m.error)); else p.resolve(m);
    };
  }
  return worker;
}
export function callWorker<T = any>(msg: any, onProgress?: (i: number) => void): Promise<T> {
  const id = nextId++;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, onProgress }); get().postMessage({ ...msg, id }); });
}
