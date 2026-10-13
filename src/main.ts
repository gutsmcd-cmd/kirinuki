import './style.css'
import '@fontsource/zen-maru-gothic/700.css'
import { all, askPersist, del, delPrefix, get, put } from './db'
import { dict, type Dict, type Lang } from './i18n'
import { blobToCanvas, openCutout, timings, toBlob, type CutResult } from './cutout'

// ---------- model ----------
type Base = { id: string; hidden: boolean; locked: boolean; opacity: number; x: number; y: number; s: number; r: number }
type ImgL = Base & { type: 'image'; blob: string; orig?: string; mask?: string; w: number; h: number; flip: boolean; shadow: boolean; outline: boolean; outlineColor: string; cx?: number; cy?: number }
type TextL = Base & { type: 'text'; text: string; font: FontK; size: number; color: string; stroke: string; strokeW: number; shadow: boolean; bold: boolean }
type DrawL = Base & { type: 'draw'; strokes: { c: string; w: number; p: number[] }[] }
type ShapeL = Base & { type: 'shape'; kind: ShapeK; w: number; h: number; fill: string; stroke: string; strokeW: number }
type BgL = Base & { type: 'bg'; kind: 'solid' | 'gradient' | 'photo' | 'none'; c1: string; c2: string; blob?: string; blur: number }
type Layer = ImgL | TextL | DrawL | ShapeL | BgL
type FontK = 'maru' | 'sans' | 'serif' | 'hand'
type ShapeK = 'rect' | 'ellipse' | 'tri' | 'star' | 'heart'
type Project = { id: string; name: string; W: number; H: number; layers: Layer[]; updated: number }
type Meta = { id: string; name: string; updated: number; thumb?: Blob }

const FONTS: Record<FontK, string> = {
  maru: "'Zen Maru Gothic', 'Hiragino Maru Gothic ProN', sans-serif",
  sans: "system-ui, 'Hiragino Sans', 'Noto Sans JP', 'Noto Sans CJK JP', sans-serif",
  serif: "'Hiragino Mincho ProN', 'Noto Serif JP', 'Noto Serif CJK JP', serif",
  hand: "'Segoe Print', 'Bradley Hand', 'Comic Sans MS', cursive",
}
const SWATCH = ['#ffffff', '#111111', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#f48fb1', '#80deea']
const GRADS: [string, string][] = [['#fbc2eb', '#a6c1ee'], ['#fddb92', '#d1fdff'], ['#a1c4fd', '#c2e9fb'], ['#f6d365', '#fda085'], ['#84fab0', '#8fd3f4'], ['#30cfd0', '#330867'], ['#232526', '#414345'], ['#ff9a9e', '#fecfef']]
const SOLIDS = ['#ffffff', '#f3efe7', '#111111', '#ffd6e0', '#d6ecff', '#e0f5dc', '#fff3c4', '#e9dcff']
const ASPECTS: [string, number, number][] = [['1:1', 1080, 1080], ['4:5', 1080, 1350], ['9:16', 1080, 1920], ['16:9', 1920, 1080]]

let ui: Lang = 'ja'
let t: Dict = dict.ja
let P: Project | null = null
let sel: string | null = null
let penMode = false
let penColor = '#e53935', penW = 12
let hist: string[] = [], hi = -1
const imgs = new Map<string, HTMLCanvasElement | ImageBitmap>()
const app = document.querySelector<HTMLDivElement>('#app')!
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text) n.textContent = text
  return n
}
function btn(cls: string, text: string, on: () => void, testid?: string): HTMLButtonElement {
  const b = el('button', cls, text)
  b.type = 'button'
  b.addEventListener('click', on)
  if (testid) b.dataset.testid = testid
  return b
}
function pickFile(): Promise<File | null> {
  return new Promise((res) => {
    const i = el('input') as HTMLInputElement
    i.type = 'file'
    i.accept = 'image/*'
    i.dataset.testid = 'file'
    i.style.display = 'none'
    i.onchange = () => { res(i.files?.[0] ?? null); i.remove() }
    i.addEventListener('cancel', () => { res(null); i.remove() })
    document.body.append(i)
    i.click()
  })
}
function toast(msg: string) {
  const n = el('div', 'toast', msg)
  document.body.append(n)
  setTimeout(() => n.remove(), 1800)
}

// ---------- blobs ----------
async function putBlob(b: Blob): Promise<string> {
  const key = `${P!.id}:${uid()}`
  await put('blobs', key, b)
  return key
}
async function ensureImg(key?: string): Promise<void> {
  if (!key || imgs.has(key)) return
  const b = await get<Blob>('blobs', key)
  if (!b) return
  imgs.set(key, await createImageBitmap(b))
}
const ensureAll = () => Promise.all(P!.layers.flatMap((l) => (l.type === 'image' ? [ensureImg(l.blob)] : l.type === 'bg' ? [ensureImg(l.blob)] : [])))

// ---------- geometry ----------
const mctx = document.createElement('canvas').getContext('2d')!
function textFont(l: TextL) { return `${l.bold || l.font === 'maru' ? 700 : 400} ${l.size}px ${FONTS[l.font]}` }
function size(l: Layer): [number, number] {
  if (!P) return [0, 0]
  switch (l.type) {
    case 'image': case 'shape': return [l.w, l.h]
    case 'bg': return [P.W, P.H]
    case 'text': {
      mctx.font = textFont(l)
      const lines = l.text.split('\n')
      const w = Math.max(...lines.map((s) => mctx.measureText(s).width), l.size * 0.5)
      return [w + l.strokeW * 2 + 8, lines.length * l.size * 1.2 + l.strokeW * 2]
    }
    case 'draw': {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const s of l.strokes) for (let i = 0; i < s.p.length; i += 2) {
        x0 = Math.min(x0, s.p[i] - s.w); x1 = Math.max(x1, s.p[i] + s.w)
        y0 = Math.min(y0, s.p[i + 1] - s.w); y1 = Math.max(y1, s.p[i + 1] + s.w)
      }
      if (x0 === Infinity) return [P.W * 0.5, P.H * 0.5]
      return [2 * Math.max(Math.abs(x0), Math.abs(x1)), 2 * Math.max(Math.abs(y0), Math.abs(y1))]
    }
  }
}
function toLocal(l: Layer, x: number, y: number): [number, number] {
  const dx = x - l.x, dy = y - l.y
  const c = Math.cos(-l.r), s = Math.sin(-l.r)
  return [(dx * c - dy * s) / l.s, (dx * s + dy * c) / l.s]
}
function hit(x: number, y: number): Layer | null {
  for (let i = P!.layers.length - 1; i >= 0; i--) {
    const l = P!.layers[i]
    if (l.hidden || l.type === 'bg') continue
    const [w, h] = size(l)
    const [lx, ly] = toLocal(l, x, y)
    if (Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2) return l
  }
  return null
}

// ---------- rendering ----------
const outlineCache = new Map<string, HTMLCanvasElement>()
function outlined(l: ImgL, src: CanvasImageSource): HTMLCanvasElement {
  const key = `${l.blob}|${l.outlineColor}`
  const c0 = outlineCache.get(key)
  if (c0) return c0
  const pad = Math.round(Math.max(l.w, l.h) * 0.025) + 2
  const c = document.createElement('canvas')
  c.width = l.w + pad * 2; c.height = l.h + pad * 2
  const g = c.getContext('2d')!
  for (let a = 0; a < 24; a++) g.drawImage(src, pad + Math.cos((a / 24) * Math.PI * 2) * pad, pad + Math.sin((a / 24) * Math.PI * 2) * pad, l.w, l.h)
  g.globalCompositeOperation = 'source-in'
  g.fillStyle = l.outlineColor
  g.fillRect(0, 0, c.width, c.height)
  g.globalCompositeOperation = 'source-over'
  g.drawImage(src, pad, pad, l.w, l.h)
  outlineCache.set(key, c)
  return c
}
function shapePath(g: CanvasRenderingContext2D, k: ShapeK, w: number, h: number) {
  g.beginPath()
  if (k === 'rect') g.roundRect(-w / 2, -h / 2, w, h, Math.min(w, h) * 0.06)
  else if (k === 'ellipse') g.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2)
  else if (k === 'tri') { g.moveTo(0, -h / 2); g.lineTo(w / 2, h / 2); g.lineTo(-w / 2, h / 2); g.closePath() }
  else if (k === 'star') {
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 0.4 : 1
      g.lineTo((Math.cos(a) * w * r) / 2, (Math.sin(a) * h * r) / 2)
    }
    g.closePath()
  } else {
    g.moveTo(0, h * 0.35)
    g.bezierCurveTo(-w * 0.6, -h * 0.1, -w * 0.25, -h * 0.6, 0, -h * 0.22)
    g.bezierCurveTo(w * 0.25, -h * 0.6, w * 0.6, -h * 0.1, 0, h * 0.35)
    g.closePath()
  }
}
function drawLayer(g: CanvasRenderingContext2D, l: Layer) {
  const W = P!.W, H = P!.H
  g.save()
  g.globalAlpha = l.opacity
  if (l.type === 'bg') {
    if (l.kind === 'solid') { g.fillStyle = l.c1; g.fillRect(0, 0, W, H) }
    else if (l.kind === 'gradient') {
      const gr = g.createLinearGradient(0, 0, W, H)
      gr.addColorStop(0, l.c1); gr.addColorStop(1, l.c2)
      g.fillStyle = gr; g.fillRect(0, 0, W, H)
    } else if (l.kind === 'photo') {
      const im = l.blob ? imgs.get(l.blob) : undefined
      if (im) {
        const k = Math.max(W / im.width, H / im.height) * (l.blur ? 1.08 : 1)
        if (l.blur) g.filter = `blur(${(l.blur * W) / 1000}px)`
        g.drawImage(im, (W - im.width * k) / 2, (H - im.height * k) / 2, im.width * k, im.height * k)
      }
    }
    g.restore()
    return
  }
  g.translate(l.x, l.y); g.rotate(l.r); g.scale(l.s, l.s)
  if (l.type === 'image') {
    const im = imgs.get(l.blob)
    if (im) {
      if (l.flip) g.scale(-1, 1)
      if (l.shadow) { g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = (Math.max(l.w, l.h) * l.s) / 18; g.shadowOffsetY = (Math.max(l.w, l.h) * l.s) / 40 }
      if (l.outline) { const c = outlined(l, im); g.drawImage(c, -c.width / 2, -c.height / 2) }
      else g.drawImage(im, -l.w / 2, -l.h / 2, l.w, l.h)
    }
  } else if (l.type === 'text') {
    g.font = textFont(l)
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round'
    const lines = l.text.split('\n'), lh = l.size * 1.2
    lines.forEach((s, i) => {
      const y = (i - (lines.length - 1) / 2) * lh
      if (l.shadow) { g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = l.size / 6; g.shadowOffsetY = l.size / 14 }
      if (l.strokeW > 0) { g.strokeStyle = l.stroke; g.lineWidth = l.strokeW * 2; g.strokeText(s, 0, y); g.shadowColor = 'transparent' }
      g.fillStyle = l.color
      g.fillText(s, 0, y)
    })
  } else if (l.type === 'draw') {
    g.lineCap = g.lineJoin = 'round'
    for (const s of l.strokes) {
      g.strokeStyle = s.c; g.lineWidth = s.w
      g.beginPath()
      g.moveTo(s.p[0], s.p[1])
      for (let i = 2; i < s.p.length; i += 2) g.lineTo(s.p[i], s.p[i + 1])
      if (s.p.length === 2) g.lineTo(s.p[0] + 0.1, s.p[1])
      g.stroke()
    }
  } else if (l.type === 'shape') {
    shapePath(g, l.kind, l.w, l.h)
    g.fillStyle = l.fill; g.fill()
    if (l.strokeW) { g.strokeStyle = l.stroke; g.lineWidth = l.strokeW; g.stroke() }
  }
  g.restore()
}
function renderTo(g: CanvasRenderingContext2D) {
  g.clearRect(0, 0, P!.W, P!.H)
  for (const l of P!.layers) if (!l.hidden) drawLayer(g, l)
}

// ---------- history / saving ----------
let saveTimer = 0
function snapshot() { return JSON.stringify({ W: P!.W, H: P!.H, layers: P!.layers }) }
function commit() {
  const s = snapshot()
  if (hist[hi] === s) return
  hist = hist.slice(0, hi + 1)
  hist.push(s)
  if (hist.length > 60) hist.shift()
  hi = hist.length - 1
  scheduleSave()
  refreshUI()
}
function restore(i: number) {
  hi = i
  const s = JSON.parse(hist[i]) as Pick<Project, 'W' | 'H' | 'layers'>
  Object.assign(P!, s)
  if (sel && !P!.layers.some((l) => l.id === sel)) sel = null
  void ensureAll().then(() => { scheduleSave(); refreshUI(); resizeStage() })
}
const undo = () => { if (hi > 0) restore(hi - 1) }
const redo = () => { if (hi < hist.length - 1) restore(hi + 1) }
function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => void saveNow(), 350)
}
async function saveNow() {
  if (!P) return
  clearTimeout(saveTimer)
  P.updated = Date.now()
  await put('projects', P.id, JSON.parse(JSON.stringify(P)))
  const c = document.createElement('canvas')
  const k = 240 / Math.max(P.W, P.H)
  c.width = Math.round(P.W * k); c.height = Math.round(P.H * k)
  const g = c.getContext('2d')!
  g.scale(k, k)
  for (const l of P.layers) if (!l.hidden) drawLayer(g, l)
  const meta: Meta = { id: P.id, name: P.name, updated: P.updated, thumb: await toBlob(c) }
  await put('kv', 'meta:' + P.id, meta)
}

// ---------- layer factories ----------
const base = (): Base => ({ id: uid(), hidden: false, locked: false, opacity: 1, x: P!.W / 2, y: P!.H / 2, s: 1, r: 0 })
function fitScale(w: number, h: number, frac = 0.8) { return Math.min((P!.W * frac) / w, (P!.H * frac) / h) }
function addLayer(l: Layer) {
  P!.layers.push(l)
  sel = l.id
  commit()
}
async function addImageFrom(cut: CutResult | null, plain?: Blob) {
  if (cut) {
    const key = await putBlob(cut.cut)
    const orig = await putBlob(cut.orig), mask = await putBlob(cut.mask)
    await ensureImg(key)
    const l: ImgL = { ...base(), type: 'image', blob: key, orig, mask, w: cut.w, h: cut.h, cx: cut.ox, cy: cut.oy, flip: false, shadow: false, outline: false, outlineColor: '#ffffff' }
    l.s = fitScale(cut.w, cut.h)
    addLayer(l)
  } else if (plain) {
    const c = await blobToCanvas(plain)
    const key = await putBlob(await toBlob(c, 'image/jpeg', 0.92))
    await ensureImg(key)
    const l: ImgL = { ...base(), type: 'image', blob: key, w: c.width, h: c.height, flip: false, shadow: false, outline: false, outlineColor: '#ffffff' }
    l.s = fitScale(c.width, c.height, 0.6)
    addLayer(l)
  }
}
async function shrink(f: Blob): Promise<Blob> {
  if (f.size < 1.5e6 && /jpe?g|png|webp/.test(f.type)) return f
  return toBlob(await blobToCanvas(f), 'image/jpeg', 0.92)
}
async function cutFlow(): Promise<CutResult | null> {
  const f = await pickFile()
  if (!f) return null
  return openCutout(t, await shrink(f))
}

// ---------- projects ----------
function newProject(W = 1080, H = 1080): Project {
  return { id: uid(), name: '', W, H, layers: [], updated: Date.now() }
}
async function openProject(p: Project) {
  P = p
  sel = null; penMode = false
  hist = []; hi = -1
  await ensureAll()
  renderEditor()
  commit()
}
async function startFromPhoto() {
  const f = await pickFile()
  if (!f) return
  const orig = await shrink(f).catch(() => null)
  if (!orig) { toast('⚠'); return }
  P = newProject()
  const bg: BgL = { ...base(), type: 'bg', kind: 'solid', c1: '#ffffff', c2: '#ffffff', blur: 0 }
  P.layers.push(bg)
  const cut = await openCutout(t, orig)
  if (!cut) { P = null; return }
  hist = []; hi = -1
  renderEditor()
  await addImageFrom(cut)
}
async function startBlank() {
  P = newProject()
  P.layers.push({ ...base(), type: 'bg', kind: 'solid', c1: '#ffffff', c2: '#ffffff', blur: 0 } as BgL)
  await openProject(P)
}

// ---------- home ----------
async function renderHome() {
  if (P) await saveNow()
  P = null
  document.documentElement.lang = ui
  app.replaceChildren()
  const head = el('header', 'top')
  head.append(el('h1', '', t.app), btn('ghost', t.toggle, () => void setLang(ui === 'ja' ? 'en' : 'ja'), 'lang'))
  const lead = el('p', 'lead', t.lead)
  const main = el('div', 'home')
  main.append(btn('big primary', t.pick, () => void startFromPhoto(), 'pick'), btn('big', t.blank, () => void startBlank(), 'blank'))
  const list = el('section', 'plist')
  list.append(el('h2', '', t.projects))
  const metas = (await all<Meta>('kv').catch(() => [] as Meta[])).filter((m) => m && (m as Meta).id && 'updated' in m).sort((a, b) => b.updated - a.updated)
  if (!metas.length) list.append(el('p', 'small', t.none))
  const grid = el('div', 'grid')
  for (const m of metas) {
    const card = el('div', 'pcard')
    card.dataset.testid = 'project'
    const im = el('img') as HTMLImageElement
    if (m.thumb) im.src = URL.createObjectURL(m.thumb)
    im.alt = ''
    im.onclick = async () => { const p = await get<Project>('projects', m.id); if (p) await openProject(p) }
    const d = el('div', 'prow')
    d.append(el('span', 'small', new Date(m.updated).toLocaleString(ui === 'ja' ? 'ja-JP' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })))
    d.append(btn('ghost tiny', t.del, async () => {
      if (!confirm(t.delQ)) return
      await del('projects', m.id); await del('kv', 'meta:' + m.id); await delPrefix('blobs', m.id + ':')
      void renderHome()
    }))
    card.append(im, d)
    grid.append(card)
  }
  list.append(grid)
  app.append(head, lead, main, list, el('p', 'foot', t.foot), el('p', 'foot', t.credit))
}
async function setLang(l: Lang) {
  ui = l; t = dict[l]
  await put('kv', 'lang', l)
  if (P) renderEditor()
  else void renderHome()
}

// ---------- editor ----------
let stage: HTMLCanvasElement
let sg: CanvasRenderingContext2D
let panel: HTMLElement
let layersBox: HTMLElement
let undoB: HTMLButtonElement, redoB: HTMLButtonElement
let guides = { v: false, h: false }
let sheet: HTMLElement | null = null

function closeSheet() { sheet?.remove(); sheet = null }
function openSheet(build: (s: HTMLElement) => void) {
  closeSheet()
  sheet = el('div', 'sheet')
  const x = btn('ghost close', '×', closeSheet)
  sheet.append(x)
  build(sheet)
  document.body.append(sheet)
}

function renderEditor() {
  document.documentElement.lang = ui
  app.replaceChildren()
  const bar = el('header', 'ebar')
  undoB = btn('icon', '↶', undo, 'undo'); undoB.title = t.undo
  redoB = btn('icon', '↷', redo, 'redo'); redoB.title = t.redo
  bar.append(
    btn('ghost', '‹ ' + t.home, () => void renderHome(), 'home'),
    undoB, redoB,
    btn('ghost', t.size, sizeSheet, 'size'),
    btn('primary', t.exportB, exportSheet, 'export'),
  )
  const body = el('div', 'ebody')
  const wrap = el('div', 'stagewrap')
  stage = el('canvas', 'stage checker')
  stage.dataset.testid = 'stage'
  sg = stage.getContext('2d')!
  wrap.append(stage)
  const side = el('div', 'side')
  const tools = el('div', 'etools')
  tools.append(btn('primary', '＋ ' + t.add, addSheet, 'add'))
  layersBox = el('div', 'layers')
  layersBox.dataset.testid = 'layers'
  panel = el('div', 'props')
  side.append(tools, el('h3', '', t.layers), layersBox, panel)
  body.append(wrap, side)
  app.append(bar, body, el('p', 'tip small', t.tip))
  bindStage()
  resizeStage()
  refreshUI()
}
function resizeStage() {
  if (!P || !stage) return
  stage.width = P.W; stage.height = P.H
  stage.style.aspectRatio = `${P.W} / ${P.H}`
  draw()
}
let rafId = 0
function draw() {
  if (rafId) return
  rafId = requestAnimationFrame(() => {
    rafId = 0
    if (!P) return
    renderTo(sg)
    const l = cur()
    const k = P.W / (stage.clientWidth || P.W)
    sg.save()
    sg.strokeStyle = '#ff3d7f'; sg.lineWidth = 1.5 * k
    if (guides.v) { sg.beginPath(); sg.moveTo(P.W / 2, 0); sg.lineTo(P.W / 2, P.H); sg.stroke() }
    if (guides.h) { sg.beginPath(); sg.moveTo(0, P.H / 2); sg.lineTo(P.W, P.H / 2); sg.stroke() }
    if (l && l.type !== 'bg' && !l.hidden && !penMode) {
      const [w, h] = size(l)
      sg.translate(l.x, l.y); sg.rotate(l.r)
      const hw = (w * l.s) / 2, hh = (h * l.s) / 2
      sg.strokeStyle = l.locked ? '#999' : '#7c5cff'; sg.lineWidth = 2 * k
      sg.setLineDash(l.locked ? [6 * k, 6 * k] : [])
      sg.strokeRect(-hw, -hh, hw * 2, hh * 2)
      if (!l.locked) {
        sg.setLineDash([])
        sg.fillStyle = '#fff'
        const hs = 11 * k
        sg.beginPath(); sg.arc(hw, hh, hs, 0, Math.PI * 2); sg.fill(); sg.stroke()
        sg.beginPath(); sg.moveTo(0, -hh); sg.lineTo(0, -hh - 34 * k); sg.stroke()
        sg.beginPath(); sg.arc(0, -hh - 34 * k, hs, 0, Math.PI * 2); sg.fill(); sg.stroke()
      }
    }
    sg.restore()
  })
}
const cur = () => (P && sel ? P.layers.find((l) => l.id === sel) ?? null : null)

function bindStage() {
  const pts = new Map<number, [number, number]>()
  let g: null | { kind: 'move' | 'scale' | 'rot' | 'pinch' | 'pen'; l: Layer; sx: number; sy: number; ox: number; oy: number; os: number; or: number; d0?: number; a0?: number; c0?: [number, number] } = null
  let changed = false
  const doc = (e: PointerEvent): [number, number] => {
    const r = stage.getBoundingClientRect()
    return [((e.clientX - r.left) * P!.W) / r.width, ((e.clientY - r.top) * P!.H) / r.height]
  }
  const startPinch = () => {
    const l = cur()
    if (!l || l.locked || l.type === 'bg') return
    const [a, b] = [...pts.values()]
    g = { kind: 'pinch', l, sx: 0, sy: 0, ox: l.x, oy: l.y, os: l.s, or: l.r, d0: Math.hypot(b[0] - a[0], b[1] - a[1]), a0: Math.atan2(b[1] - a[1], b[0] - a[0]), c0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] }
  }
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId)
    const p = doc(e)
    pts.set(e.pointerId, p)
    if (pts.size === 2) { startPinch(); return }
    const k = P!.W / stage.clientWidth
    const l = cur()
    if (penMode && l?.type === 'draw') {
      const [lx, ly] = toLocal(l, p[0], p[1])
      l.strokes.push({ c: penColor, w: penW / l.s, p: [lx, ly] })
      g = { kind: 'pen', l, sx: p[0], sy: p[1], ox: 0, oy: 0, os: 0, or: 0 }
      changed = true
      draw()
      return
    }
    if (l && !l.locked && l.type !== 'bg') {
      const [w, h] = size(l)
      const [lx, ly] = toLocal(l, p[0], p[1])
      const tol = (22 * k) / l.s
      if (Math.hypot(lx - w / 2, ly - h / 2) < tol) { g = { kind: 'scale', l, sx: p[0], sy: p[1], ox: l.x, oy: l.y, os: l.s, or: l.r }; return }
      if (Math.hypot(lx, ly - (-h / 2 - (34 * k) / l.s)) < tol) { g = { kind: 'rot', l, sx: p[0], sy: p[1], ox: l.x, oy: l.y, os: l.s, or: l.r }; return }
    }
    const h = hit(p[0], p[1])
    if (h) {
      if (sel !== h.id) { sel = h.id; refreshUI() }
      if (!h.locked) g = { kind: 'move', l: h, sx: p[0], sy: p[1], ox: h.x, oy: h.y, os: h.s, or: h.r }
    } else if (sel) { sel = null; refreshUI() }
    draw()
  })
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return
    const p = doc(e)
    pts.set(e.pointerId, p)
    if (!g) return
    const l = g.l
    const k = P!.W / stage.clientWidth
    if (g.kind === 'pen' && l.type === 'draw') {
      const [lx, ly] = toLocal(l, p[0], p[1])
      l.strokes[l.strokes.length - 1].p.push(lx, ly)
    } else if (g.kind === 'move') {
      let nx = g.ox + p[0] - g.sx, ny = g.oy + p[1] - g.sy
      guides.v = Math.abs(nx - P!.W / 2) < 14 * k
      guides.h = Math.abs(ny - P!.H / 2) < 14 * k
      if (guides.v) nx = P!.W / 2
      if (guides.h) ny = P!.H / 2
      l.x = nx; l.y = ny
    } else if (g.kind === 'scale') {
      const d0 = Math.hypot(g.sx - g.ox, g.sy - g.oy), d1 = Math.hypot(p[0] - g.ox, p[1] - g.oy)
      l.s = Math.max(0.02, (g.os * d1) / (d0 || 1))
    } else if (g.kind === 'rot') {
      let a = Math.atan2(p[1] - l.y, p[0] - l.x) + Math.PI / 2
      const snap = Math.round(a / (Math.PI / 4)) * (Math.PI / 4)
      if (Math.abs(a - snap) < 0.06) a = snap
      l.r = a
    } else if (g.kind === 'pinch' && pts.size >= 2) {
      const [a, b] = [...pts.values()]
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]), ang = Math.atan2(b[1] - a[1], b[0] - a[0])
      const c: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
      l.s = Math.max(0.02, (g.os * d) / (g.d0 || 1))
      l.r = g.or + ang - (g.a0 ?? 0)
      l.x = g.ox + c[0] - g.c0![0]; l.y = g.oy + c[1] - g.c0![1]
    }
    changed = true
    draw()
  })
  const end = (e: PointerEvent) => {
    pts.delete(e.pointerId)
    if (pts.size === 1 && g?.kind === 'pinch') { g = null }
    if (pts.size === 0) {
      g = null
      guides = { v: false, h: false }
      if (changed) { changed = false; outlineCache.clear(); commit() }
      draw()
    }
  }
  stage.addEventListener('pointerup', end)
  stage.addEventListener('pointercancel', end)
  stage.addEventListener('wheel', (e) => {
    const l = cur()
    if (!l || l.locked || l.type === 'bg') return
    e.preventDefault()
    if (e.shiftKey) l.r += e.deltaY * 0.002
    else l.s = Math.max(0.02, l.s * Math.exp(-e.deltaY * 0.0015))
    draw()
    clearTimeout(wheelT)
    wheelT = window.setTimeout(commit, 300)
  }, { passive: false })
}
let wheelT = 0

function layerName(l: Layer) {
  if (l.type === 'text') return l.text.split('\n')[0].slice(0, 14) || t.names.text
  if (l.type === 'image') return l.mask ? `${t.names.image} ✂` : t.names.image
  return t.names[l.type]
}
const ICON: Record<Layer['type'], string> = { image: '🖼', text: 'T', draw: '✎', shape: '◆', bg: '▦' }

function move(id: string, to: number) {
  const arr = P!.layers
  const i = arr.findIndex((l) => l.id === id)
  if (i < 0) return
  to = Math.max(0, Math.min(arr.length - 1, to))
  if (to === i) return
  const [l] = arr.splice(i, 1)
  arr.splice(to, 0, l)
  commit()
}

function refreshUI() {
  if (!P || !layersBox) return
  undoB.disabled = hi <= 0
  redoB.disabled = hi >= hist.length - 1
  layersBox.replaceChildren()
  const list = [...P.layers].reverse()
  list.forEach((l) => {
    const row = el('div', 'lrow' + (l.id === sel ? ' sel' : '') + (l.hidden ? ' off' : ''))
    row.dataset.id = l.id
    row.dataset.testid = 'layer-' + l.type
    const grip = el('span', 'grip', '⋮⋮')
    const name = el('button', 'lname', `${ICON[l.type]}  ${layerName(l)}`)
    name.onclick = () => { sel = l.id; penMode = false; refreshUI() }
    const eye = btn('icon sm', l.hidden ? '◌' : '👁', () => { l.hidden = !l.hidden; commit() })
    eye.title = l.hidden ? t.show : t.hide
    const lock = btn('icon sm', l.locked ? '🔒' : '🔓', () => { l.locked = !l.locked; commit() })
    lock.title = l.locked ? t.unlock : t.lock
    row.append(grip, name, eye, lock)
    // drag to reorder
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      grip.setPointerCapture(e.pointerId)
      row.classList.add('drag')
      const rows = [...layersBox.children] as HTMLElement[]
      const mv = (ev: PointerEvent) => {
        rows.forEach((r) => r.classList.remove('over'))
        const tgt = rows.find((r) => { const b = r.getBoundingClientRect(); return ev.clientY >= b.top && ev.clientY < b.bottom })
        tgt?.classList.add('over')
      }
      const upH = (ev: PointerEvent) => {
        grip.removeEventListener('pointermove', mv)
        grip.removeEventListener('pointerup', upH)
        const ti = rows.findIndex((r) => { const b = r.getBoundingClientRect(); return ev.clientY >= b.top && ev.clientY < b.bottom })
        rows.forEach((r) => r.classList.remove('over', 'drag'))
        if (ti >= 0) move(l.id, P!.layers.length - 1 - ti)
      }
      grip.addEventListener('pointermove', mv)
      grip.addEventListener('pointerup', upH)
    })
    layersBox.append(row)
  })
  renderProps()
  draw()
}

function swatches(cur: string, on: (c: string) => void, extra = true) {
  const box = el('div', 'sw')
  for (const c of SWATCH) {
    const b = btn('swb' + (c === cur ? ' on' : ''), '', () => on(c))
    b.style.background = c
    b.setAttribute('aria-label', c)
    box.append(b)
  }
  if (extra) {
    const i = el('input', 'swc') as HTMLInputElement
    i.type = 'color'; i.value = /^#[0-9a-f]{6}$/i.test(cur) ? cur : '#000000'
    i.onchange = () => on(i.value)
    box.append(i)
  }
  return box
}
function range(label: string, min: number, max: number, step: number, v: number, on: (n: number) => void, done = commit) {
  const l = el('label', 'sl')
  l.append(el('span', '', label))
  const i = el('input') as HTMLInputElement
  i.type = 'range'; i.min = String(min); i.max = String(max); i.step = String(step); i.value = String(v)
  i.oninput = () => { on(Number(i.value)); draw() }
  i.onchange = () => done()
  l.append(i)
  return l
}
function toggle(label: string, v: boolean, on: (b: boolean) => void) {
  return btn('chip' + (v ? ' on' : ''), label, () => { on(!v); outlineCache.clear(); commit() })
}

function renderProps() {
  panel.replaceChildren()
  const l = cur()
  if (!l) return
  const row = el('div', 'row')
  const i = P!.layers.indexOf(l)
  row.append(
    btn('chip', '▲ ' + t.up, () => move(l.id, i + 1), 'up'),
    btn('chip', '▼ ' + t.down, () => move(l.id, i - 1), 'down'),
    btn('chip', t.dup, () => { const c = JSON.parse(JSON.stringify(l)) as Layer; c.id = uid(); if (c.type !== 'bg') { c.x += 30; c.y += 30 } P!.layers.splice(i + 1, 0, c); sel = c.id; commit() }, 'dup'),
    btn('chip danger', t.del, () => { P!.layers.splice(i, 1); sel = null; commit() }, 'del'),
  )
  panel.append(row, range(t.opacity, 0, 1, 0.01, l.opacity, (n) => (l.opacity = n)))
  if (l.type === 'image') {
    const r = el('div', 'row')
    r.append(toggle(t.shadow, l.shadow, (b) => (l.shadow = b)), toggle(t.outline, l.outline, (b) => (l.outline = b)), toggle(t.flip, l.flip, (b) => (l.flip = b)))
    panel.append(r)
    if (l.outline) panel.append(swatches(l.outlineColor, (c) => { l.outlineColor = c; outlineCache.clear(); commit() }))
    panel.append(btn('chip wide', l.mask ? t.refine : t.cutThis, async () => {
      const src = await get<Blob>('blobs', l.orig ?? l.blob)
      if (!src) return
      const m = l.mask ? await get<Blob>('blobs', l.mask) : undefined
      const res = await openCutout(t, src, m)
      if (!res) return
      const key = await putBlob(res.cut)
      await ensureImg(key)
      if (!l.orig) l.orig = await putBlob(res.orig)
      l.mask = await putBlob(res.mask)
      // keep the subject where it was: shift by the change in crop centre
      const dx = (res.ox - (l.cx ?? 0)) * l.s * (l.flip ? -1 : 1), dy = (res.oy - (l.cy ?? 0)) * l.s
      l.x += dx * Math.cos(l.r) - dy * Math.sin(l.r); l.y += dx * Math.sin(l.r) + dy * Math.cos(l.r)
      l.cx = res.ox; l.cy = res.oy
      l.blob = key; l.w = res.w; l.h = res.h
      outlineCache.clear()
      commit()
    }, 'refine'))
  } else if (l.type === 'text') {
    const ta = el('textarea') as HTMLTextAreaElement
    ta.value = l.text
    ta.dataset.testid = 'text-input'
    ta.onfocus = () => { if (ta.value === t.textDefault) ta.select() }
    ta.oninput = () => { l.text = ta.value; draw() }
    ta.onchange = () => commit()
    panel.append(ta)
    const fr = el('div', 'row')
    for (const f of Object.keys(FONTS) as FontK[]) {
      const b = btn('chip' + (l.font === f ? ' on' : ''), t.fonts[f], async () => { l.font = f; await document.fonts.load(textFont(l)).catch(() => {}); commit() })
      b.style.fontFamily = FONTS[f]
      fr.append(b)
    }
    fr.append(toggle(t.bold, l.bold, (b) => (l.bold = b)), toggle(t.shadow, l.shadow, (b) => (l.shadow = b)))
    panel.append(fr, el('h4', '', t.color), swatches(l.color, (c) => { l.color = c; commit() }))
    panel.append(el('h4', '', t.outline), swatches(l.stroke, (c) => { l.stroke = c; if (!l.strokeW) l.strokeW = 6; commit() }), range(t.strokeW, 0, 30, 1, l.strokeW, (n) => (l.strokeW = n)))
  } else if (l.type === 'draw') {
    panel.append(btn('chip wide' + (penMode ? ' on' : ''), '✎ ' + t.pen, () => { penMode = !penMode; refreshUI() }, 'pen'))
    panel.append(el('h4', '', t.color), swatches(penColor, (c) => { penColor = c; penMode = true; refreshUI() }), range(t.penW, 2, 80, 1, penW, (n) => (penW = n), () => {}))
  } else if (l.type === 'shape') {
    const r = el('div', 'row')
    for (const k of Object.keys(t.shapes) as ShapeK[]) r.append(btn('chip' + (l.kind === k ? ' on' : ''), t.shapes[k], () => { l.kind = k; commit() }))
    panel.append(r, el('h4', '', t.fill), swatches(l.fill, (c) => { l.fill = c; commit() }), el('h4', '', t.outline), swatches(l.stroke, (c) => { l.stroke = c; if (!l.strokeW) l.strokeW = 8; commit() }), range(t.strokeW, 0, 40, 1, l.strokeW, (n) => (l.strokeW = n)))
  } else if (l.type === 'bg') {
    panel.append(bgPicker(l))
  }
}

function bgPicker(l: BgL): HTMLElement {
  const box = el('div', 'bgp')
  const set = (p: Partial<BgL>) => { Object.assign(l, p); commit() }
  const none = btn('bgb checker' + (l.kind === 'none' ? ' on' : ''), '', () => set({ kind: 'none' }))
  none.title = t.bgNone
  none.dataset.testid = 'bg-none'
  box.append(none)
  for (const c of SOLIDS) { const b = btn('bgb', '', () => set({ kind: 'solid', c1: c })); b.style.background = c; box.append(b) }
  for (const [a, b2] of GRADS) { const b = btn('bgb', '', () => set({ kind: 'gradient', c1: a, c2: b2 })); b.style.background = `linear-gradient(135deg, ${a}, ${b2})`; box.append(b) }
  const ci = el('input', 'swc') as HTMLInputElement
  ci.type = 'color'; ci.value = /^#[0-9a-f]{6}$/i.test(l.c1) ? l.c1 : '#ffffff'
  ci.onchange = () => set({ kind: 'solid', c1: ci.value })
  box.append(ci)
  const wrap = el('div', '')
  wrap.append(box)
  const r = el('div', 'row')
  const origSrc = P!.layers.find((x): x is ImgL => x.type === 'image' && !!x.orig)
  if (origSrc) r.append(btn('chip', t.bgBlur, async () => { await ensureImg(origSrc.orig); set({ kind: 'photo', blob: origSrc.orig, blur: 24 }) }, 'bg-blur'))
  r.append(btn('chip', t.bgPhoto, async () => {
    const f = await pickFile()
    if (!f) return
    const key = await putBlob(await toBlob(await blobToCanvas(f), 'image/jpeg', 0.9))
    await ensureImg(key)
    set({ kind: 'photo', blob: key, blur: 0 })
  }))
  wrap.append(r)
  if (l.kind === 'photo') wrap.append(range(t.blur, 0, 60, 1, l.blur, (n) => (l.blur = n)))
  return wrap
}

function addSheet() {
  openSheet((s) => {
    s.append(el('h3', '', t.add))
    const g = el('div', 'addgrid')
    const go = (f: () => void | Promise<void>) => () => { closeSheet(); void Promise.resolve().then(f).catch((e) => { console.warn(e); toast('⚠') }) }
    g.append(
      btn('tile', '✂ ' + t.addCut, go(async () => { const c = await cutFlow(); if (c) await addImageFrom(c) }), 'add-cut'),
      btn('tile', '🖼 ' + t.addPhoto, go(async () => { const f = await pickFile(); if (f) await addImageFrom(null, f) }), 'add-photo'),
      btn('tile', 'T ' + t.addText, go(async () => {
        const l: TextL = { ...base(), type: 'text', text: t.textDefault, font: 'maru', size: Math.round(P!.W / 9), color: '#ffffff', stroke: '#111111', strokeW: 6, shadow: false, bold: true }
        await document.fonts.load(textFont(l)).catch(() => {})
        addLayer(l)
      }), 'add-text'),
      btn('tile', '✎ ' + t.addDraw, go(() => { penMode = true; addLayer({ ...base(), type: 'draw', strokes: [] }) }), 'add-draw'),
      btn('tile', '◆ ' + t.addShape, go(() => { const w = P!.W * 0.35; addLayer({ ...base(), type: 'shape', kind: 'ellipse', w, h: w, fill: '#fdd835', stroke: '#111111', strokeW: 0 }) }), 'add-shape'),
      btn('tile', '▦ ' + t.addBg, go(() => {
        const ex = P!.layers.find((x) => x.type === 'bg')
        if (ex) { sel = ex.id; refreshUI() }
        else { P!.layers.unshift({ ...base(), type: 'bg', kind: 'solid', c1: '#ffffff', c2: '#ffffff', blur: 0 }); sel = P!.layers[0].id; commit() }
      }), 'add-bg'),
    )
    s.append(g)
  })
}

function setSize(W: number, H: number) {
  const dx = (W - P!.W) / 2, dy = (H - P!.H) / 2
  for (const l of P!.layers) if (l.type !== 'bg') { l.x += dx; l.y += dy }
  P!.W = W; P!.H = H
  resizeStage()
  commit()
}
function sizeSheet() {
  openSheet((s) => {
    s.append(el('h3', '', t.size))
    const r = el('div', 'row')
    for (const [n, W, H] of ASPECTS) r.append(btn('chip' + (P!.W === W && P!.H === H ? ' on' : ''), n, () => { setSize(W, H); closeSheet() }, 'aspect-' + n))
    s.append(r, el('h4', '', t.custom))
    const c = el('div', 'row')
    const wi = el('input') as HTMLInputElement, hi2 = el('input') as HTMLInputElement
    for (const [i, v, ph] of [[wi, P!.W, t.width], [hi2, P!.H, t.height]] as const) { i.type = 'number'; i.min = '64'; i.max = '4096'; i.value = String(v); i.placeholder = ph; i.className = 'num' }
    c.append(wi, el('span', '', '×'), hi2, btn('chip', t.apply, () => {
      const W = Math.round(Math.min(4096, Math.max(64, Number(wi.value) || 1080))), H = Math.round(Math.min(4096, Math.max(64, Number(hi2.value) || 1080)))
      setSize(W, H); closeSheet()
    }))
    s.append(c)
  })
}

async function exportBlob(type: 'png' | 'jpg'): Promise<Blob> {
  await ensureAll()
  const c = document.createElement('canvas')
  c.width = P!.W; c.height = P!.H
  const g = c.getContext('2d')!
  if (type === 'jpg') { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height) }
  for (const l of P!.layers) if (!l.hidden) drawLayer(g, l)
  return toBlob(c, type === 'png' ? 'image/png' : 'image/jpeg', 0.92)
}
function exportSheet() {
  let type: 'png' | 'jpg' = 'png'
  openSheet((s) => {
    s.append(el('h3', '', t.exportB))
    const r = el('div', 'row')
    const pb = btn('chip on', t.png, () => { type = 'png'; pb.classList.add('on'); jb.classList.remove('on') }, 'fmt-png')
    const jb = btn('chip', t.jpg, () => { type = 'jpg'; jb.classList.add('on'); pb.classList.remove('on') }, 'fmt-jpg')
    r.append(pb, jb)
    const name = () => `kirinuki-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${type}`
    const a = el('div', 'row')
    a.append(btn('big primary', t.save, async () => {
      const b = await exportBlob(type)
      const u = URL.createObjectURL(b)
      const link = el('a') as HTMLAnchorElement
      link.href = u; link.download = name()
      document.body.append(link); link.click(); link.remove()
      setTimeout(() => URL.revokeObjectURL(u), 4000)
      toast(t.saved)
    }, 'save'))
    if ('share' in navigator) a.append(btn('big', t.share, async () => {
      const b = await exportBlob(type)
      const f = new File([b], name(), { type: b.type })
      try { if (navigator.canShare?.({ files: [f] })) await navigator.share({ files: [f] }) } catch { /* cancelled */ }
    }))
    s.append(r, a)
  })
}

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (!P || (e.target as HTMLElement).matches('input, textarea')) return
  const mod = e.ctrlKey || e.metaKey
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo() }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo() }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
    const i = P.layers.findIndex((l) => l.id === sel)
    if (i >= 0) { P.layers.splice(i, 1); sel = null; commit() }
  }
})
window.addEventListener('resize', () => draw())
document.addEventListener('visibilitychange', () => { if (document.hidden) void saveNow() })

// test/debug hook (read-only info)
;(window as unknown as { __kirinuki: unknown }).__kirinuki = { get project() { return P }, timings, save: () => saveNow() }

async function boot() {
  void askPersist()
  const l = await get<Lang>('kv', 'lang').catch(() => undefined)
  if (l === 'en' || l === 'ja') { ui = l; t = dict[l] }
  await renderHome()
}
void boot()
