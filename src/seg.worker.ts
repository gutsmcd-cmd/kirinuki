// Background-removal worker. Runs BRIA RMBG-1.4 fully on-device with transformers.js / onnxruntime-web.
// Model files come from the Hugging Face CDN once, then are served from the browser cache (offline).
import { AutoModel, Tensor, env } from '@huggingface/transformers'

const MODEL = 'briaai/RMBG-1.4'
const SIZE = 1024
env.allowLocalModels = false
env.useBrowserCache = true

type Msg = { type: 'run'; bitmap: ImageBitmap } | { type: 'load' }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let modelP: Promise<any> | null = null
let device = 'wasm'

async function pickDevice(): Promise<{ device: 'webgpu' | 'wasm'; dtype: 'fp16' | 'q8' }> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu
    if (gpu) {
      const a = await gpu.requestAdapter()
      if (a && a.features.has('shader-f16')) return { device: 'webgpu', dtype: 'fp16' }
    }
  } catch {
    /* fall back */
  }
  return { device: 'wasm', dtype: 'q8' }
}

function load() {
  if (modelP) return modelP
  modelP = (async () => {
    const pick = await pickDevice()
    const opts = (d: typeof pick) => ({
      config: { model_type: 'custom' } as never,
      device: d.device,
      dtype: d.dtype,
      progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status === 'progress' && p.file?.endsWith('.onnx'))
          postMessage({ type: 'progress', loaded: p.loaded ?? 0, total: p.total ?? 0 })
      },
    })
    try {
      device = pick.device
      return await AutoModel.from_pretrained(MODEL, opts(pick))
    } catch (e) {
      if (pick.device === 'wasm') throw e
      device = 'wasm'
      return await AutoModel.from_pretrained(MODEL, opts({ device: 'wasm', dtype: 'q8' }))
    }
  })()
  modelP.catch(() => (modelP = null))
  return modelP
}

async function run(bitmap: ImageBitmap) {
  const t0 = performance.now()
  const model = await load()
  const t1 = performance.now()
  const c = new OffscreenCanvas(SIZE, SIZE)
  const g = c.getContext('2d')!
  g.drawImage(bitmap, 0, 0, SIZE, SIZE)
  bitmap.close()
  const px = g.getImageData(0, 0, SIZE, SIZE).data
  const n = SIZE * SIZE
  const data = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) {
    data[i] = px[i * 4] / 255 - 0.5
    data[n + i] = px[i * 4 + 1] / 255 - 0.5
    data[2 * n + i] = px[i * 4 + 2] / 255 - 0.5
  }
  const input = new Tensor('float32', data, [1, 3, SIZE, SIZE])
  const out = await model({ input })
  const t = (out.output ?? Object.values(out)[0]) as Tensor
  const raw = t.data as Float32Array
  let mn = Infinity, mx = -Infinity
  for (let i = 0; i < raw.length; i++) { const v = raw[i]; if (v < mn) mn = v; if (v > mx) mx = v }
  const mask = new Uint8ClampedArray(n)
  const span = mx - mn || 1
  for (let i = 0; i < n; i++) mask[i] = ((raw[i] - mn) / span) * 255
  const t2 = performance.now()
  postMessage({ type: 'mask', mask, size: SIZE, device, loadMs: Math.round(t1 - t0), inferMs: Math.round(t2 - t1) }, { transfer: [mask.buffer] })
}

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data
  const p = m.type === 'load' ? load().then(() => postMessage({ type: 'ready', device })) : run(m.bitmap)
  p.catch((err: unknown) => postMessage({ type: 'error', message: String((err as Error)?.message ?? err) }))
}
