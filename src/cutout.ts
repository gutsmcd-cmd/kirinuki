// Cutout screen: AI mask + manual keep/erase brush + edge softening.
import type { Dict } from './i18n'

export type CutResult = { cut: Blob; orig: Blob; mask: Blob; w: number; h: number; ox: number; oy: number; ow: number; oh: number }
export const timings: { loadMs?: number; inferMs?: number; totalMs?: number; device?: string } = {}

const MAX = 2048
let worker: Worker | null = null
function getWorker(): Worker {
  if (!worker) worker = new Worker(new URL('./seg.worker.ts', import.meta.url), { type: 'module' })
  return worker
}

export async function blobToCanvas(b: Blob, max = MAX): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(b, { imageOrientation: 'from-image' })
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(bmp.width * k))
  c.height = Math.max(1, Math.round(bmp.height * k))
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
  bmp.close()
  return c
}
export const toBlob = (c: HTMLCanvasElement, type = 'image/png', q?: number) =>
  new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), type, q))

function aiMask(src: HTMLCanvasElement, onProgress: (f: number) => void): Promise<HTMLCanvasElement> {
  return new Promise(async (resolve, reject) => {
    const w = getWorker()
    const t0 = performance.now()
    w.onmessage = (e: MessageEvent) => {
      const m = e.data
      if (m.type === 'progress') onProgress(m.total ? m.loaded / m.total : 0)
      else if (m.type === 'error') reject(new Error(m.message))
      else if (m.type === 'mask') {
        Object.assign(timings, { loadMs: m.loadMs, inferMs: m.inferMs, device: m.device, totalMs: Math.round(performance.now() - t0) })
        const s = m.size as number
        const small = document.createElement('canvas')
        small.width = small.height = s
        const sg = small.getContext('2d')!
        const id = sg.createImageData(s, s)
        const a = m.mask as Uint8ClampedArray
        for (let i = 0; i < a.length; i++) {
          id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = 255
          id.data[i * 4 + 3] = a[i]
        }
        sg.putImageData(id, 0, 0)
        const mc = document.createElement('canvas')
        mc.width = src.width
        mc.height = src.height
        const g = mc.getContext('2d')!
        g.imageSmoothingQuality = 'high'
        g.drawImage(small, 0, 0, mc.width, mc.height)
        resolve(mc)
      }
    }
    w.onerror = (e) => reject(new Error(e.message || 'worker'))
    const bmp = await createImageBitmap(src)
    w.postMessage({ type: 'run', bitmap: bmp }, [bmp])
  })
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text) n.textContent = text
  return n
}

/** Opens the cutout screen. Resolves null on cancel. */
export function openCutout(t: Dict, orig: Blob, prevMask?: Blob): Promise<CutResult | null> {
  return new Promise(async (resolve) => {
    const src = await blobToCanvas(orig)
    const W = src.width, H = src.height
    const mask = document.createElement('canvas')
    mask.width = W
    mask.height = H
    const mg = mask.getContext('2d')!

    const root = el('div', 'modal cut')
    root.dataset.testid = 'cutout'
    const bar = el('div', 'bar')
    const cancel = el('button', 'ghost', t.cancel)
    const title = el('h2', '', t.cutTitle)
    const doneB = el('button', 'primary', t.done)
    doneB.dataset.testid = 'cut-done'
    bar.append(cancel, title, doneB)
    const wrap = el('div', 'cutstage')
    const view = el('canvas', 'checker')
    view.width = W
    view.height = H
    wrap.append(view)
    const status = el('div', 'status')
    const prog = el('progress') as HTMLProgressElement
    prog.max = 1
    const statusTxt = el('p')
    const note = el('p', 'small', t.dlNote)
    status.append(statusTxt, prog, note)
    wrap.append(status)

    let mode: 'keep' | 'erase' = 'erase'
    let brush = 40, soften = 1, showOrig = false
    const tools = el('div', 'tools')
    const seg = el('div', 'seg')
    const kb = el('button', '', t.keep), eb = el('button', 'on', t.erase)
    kb.onclick = () => { mode = 'keep'; kb.classList.add('on'); eb.classList.remove('on') }
    eb.onclick = () => { mode = 'erase'; eb.classList.add('on'); kb.classList.remove('on') }
    seg.append(kb, eb)
    const slider = (label: string, min: number, max: number, v: number, on: (n: number) => void) => {
      const l = el('label', 'sl')
      l.append(el('span', '', label))
      const i = el('input') as HTMLInputElement
      i.type = 'range'; i.min = String(min); i.max = String(max); i.value = String(v)
      i.oninput = () => on(Number(i.value))
      l.append(i)
      return l
    }
    const origL = el('label', 'chk')
    const oc = el('input') as HTMLInputElement
    oc.type = 'checkbox'
    oc.onchange = () => { showOrig = oc.checked; draw() }
    origL.append(oc, el('span', '', t.showOrig))
    const retry = el('button', 'ghost', t.retry)
    retry.onclick = () => void runAI()
    tools.append(seg, slider(t.brush, 5, 200, brush, (n) => (brush = n)), slider(t.soften, 0, 12, soften, (n) => { soften = n; draw() }), origL, retry)
    root.append(bar, wrap, tools)
    document.body.append(root)

    const softMask = (): HTMLCanvasElement => {
      if (!soften) return mask
      const c = document.createElement('canvas')
      c.width = W; c.height = H
      const g = c.getContext('2d')!
      g.filter = `blur(${soften * Math.max(W, H) / 1000}px)`
      g.drawImage(mask, 0, 0)
      return c
    }
    const composite = (): HTMLCanvasElement => {
      const c = document.createElement('canvas')
      c.width = W; c.height = H
      const g = c.getContext('2d')!
      g.drawImage(softMask(), 0, 0)
      g.globalCompositeOperation = 'source-in'
      g.drawImage(src, 0, 0)
      return c
    }
    const vg = view.getContext('2d')!
    function draw() {
      vg.clearRect(0, 0, W, H)
      if (showOrig) { vg.globalAlpha = 0.3; vg.drawImage(src, 0, 0); vg.globalAlpha = 1 }
      vg.drawImage(composite(), 0, 0)
    }

    async function runAI() {
      status.hidden = false
      statusTxt.textContent = t.dl
      prog.removeAttribute('value')
      note.hidden = false
      try {
        const m = await aiMask(src, (f) => {
          prog.value = f
          if (f >= 1) { statusTxt.textContent = t.working; note.hidden = true; prog.removeAttribute('value') }
        })
        mg.globalCompositeOperation = 'copy'
        mg.drawImage(m, 0, 0)
        mg.globalCompositeOperation = 'source-over'
        status.hidden = true
      } catch (e) {
        console.warn('AI cutout failed', e)
        statusTxt.textContent = t.fail
        prog.hidden = true
        note.hidden = true
        setTimeout(() => (status.hidden = true), 2500)
        mg.fillStyle = '#fff'
        mg.fillRect(0, 0, W, H)
      }
      draw()
    }

    if (prevMask) {
      status.hidden = true
      const mc = await blobToCanvas(prevMask, Math.max(W, H))
      mg.drawImage(mc, 0, 0, W, H)
      draw()
    } else void runAI()

    // brush
    let last: [number, number] | null = null
    const pt = (e: PointerEvent): [number, number] => {
      const r = view.getBoundingClientRect()
      return [((e.clientX - r.left) * W) / r.width, ((e.clientY - r.top) * H) / r.height]
    }
    const dab = (a: [number, number], b: [number, number]) => {
      const r = view.getBoundingClientRect()
      const lw = (brush * W) / r.width
      mg.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over'
      mg.strokeStyle = '#fff'
      mg.lineWidth = lw
      mg.lineCap = mg.lineJoin = 'round'
      mg.beginPath(); mg.moveTo(a[0], a[1]); mg.lineTo(b[0], b[1]); mg.stroke()
      mg.globalCompositeOperation = 'source-over'
    }
    let raf = 0
    view.addEventListener('pointerdown', (e) => {
      view.setPointerCapture(e.pointerId)
      last = pt(e)
      dab(last, last)
      draw()
    })
    view.addEventListener('pointermove', (e) => {
      if (!last) return
      const p = pt(e)
      dab(last, p)
      last = p
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw() })
    })
    const up = () => (last = null)
    view.addEventListener('pointerup', up)
    view.addEventListener('pointercancel', up)

    cancel.onclick = () => { root.remove(); resolve(null) }
    doneB.onclick = async () => {
      const c = composite()
      // crop to visible pixels
      const d = c.getContext('2d')!.getImageData(0, 0, W, H).data
      let x0 = W, y0 = H, x1 = -1, y1 = -1
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
      }
      if (x1 < 0) { x0 = 0; y0 = 0; x1 = W - 1; y1 = H - 1 }
      const cw = x1 - x0 + 1, ch = y1 - y0 + 1
      const out = document.createElement('canvas')
      out.width = cw; out.height = ch
      out.getContext('2d')!.drawImage(c, -x0, -y0)
      const [cut, mb] = await Promise.all([toBlob(out), toBlob(mask)])
      root.remove()
      resolve({ cut, orig, mask: mb, w: cw, h: ch, ox: x0 + cw / 2 - W / 2, oy: y0 + ch / 2 - H / 2, ow: W, oh: H })
    }
  })
}
