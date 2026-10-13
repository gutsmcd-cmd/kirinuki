# きりぬき / Cutout

写真の背景を消して、組み合わせる。Remove backgrounds and build new pictures.

- On-device background removal (BRIA RMBG-1.4, 8-bit quantized ONNX, ~44 MB, via transformers.js / onnxruntime-web; WebGPU fp16 when available, WASM otherwise). Downloaded once from Hugging Face, then cached for offline use. Your photos never leave the device.
- Keep/erase refine brush and edge softening.
- Layer editor: cutouts, photos, text (incl. Zen Maru Gothic), drawing, shapes, solid/gradient/photo/blurred backgrounds; move, pinch-zoom/rotate, handles, snap to centre, shadow, outline, opacity, lock, hide, reorder, duplicate, undo/redo.
- Projects saved locally (IndexedDB). Export PNG (transparent) or JPG, share or save.
- Free, no ads, no login, no analytics.

Model licence: RMBG-1.4 is released by BRIA AI under a non-commercial licence; this app is free and non-commercial.
App code: MIT.
