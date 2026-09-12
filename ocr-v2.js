(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const scanStatus = $('scanStatus');
  const gunX = $('gunX'), gunY = $('gunY'), targetX = $('targetX'), targetY = $('targetY');
  if (!scanStatus || !gunX || !gunY || !targetX || !targetY) return;

  const VERSION = 'OCR v4';
  let ocrPromise = null;

  const show = (text, cls='') => {
    scanStatus.textContent = text;
    scanStatus.className = 'scan-status show ' + cls;
  };

  function ensureOCR() {
    if (window.Tesseract) return Promise.resolve();
    if (ocrPromise) return ocrPromise;
    ocrPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('OCR engine не загрузился'));
      document.head.appendChild(s);
    });
    return ocrPromise;
  }

  async function bitmap(file) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { return await createImageBitmap(file); }
  }

  function makeCanvas(bmp, region, threshold=180, mode='binary') {
    const W = bmp.width, H = bmp.height;
    const sx = Math.max(0, Math.round(W * region.x));
    const sy = Math.max(0, Math.round(H * region.y));
    const sw = Math.max(1, Math.min(W - sx, Math.round(W * region.w)));
    const sh = Math.max(1, Math.min(H - sy, Math.round(H * region.h)));
    const scale = Math.min(5, 2100 / sw);

    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * scale));
    c.height = Math.max(1, Math.round(sh * scale));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);

    const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i+1], b = d[i+2];
      const lum = .299*r + .587*g + .114*b;
      const spread = Math.max(r,g,b) - Math.min(r,g,b);
      let v;
      if (mode === 'contrast') {
        const boosted = Math.max(0, Math.min(255, (lum - 82) * 2.0));
        v = 255 - boosted;
      } else {
        const whiteish = lum >= threshold && spread < 120;
        v = whiteish ? 0 : 255;
      }
      d[i] = d[i+1] = d[i+2] = v;
      d[i+3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  function normalizeText(s) {
    return String(s || '')
      .replace(/[OoQ]/g, '0')
      .replace(/[Il|]/g, '1')
      .replace(/[,:;]/g, '.')
      .replace(/[^xyXY0-9.\s]/g, ' ');
  }

  function validValue(n) {
    return Number.isFinite(n) && n >= 0 && n < 200 && Math.abs(n - 2) > 0.001;
  }

  function tokenValue(raw) {
    const s = String(raw || '').trim().replace(/,/g, '.').replace(/\s+/g, ' ');

    let m = s.match(/^(\d{1,3})\s*\.\s*(\d{2})$/);
    if (m) {
      const n = Number(`${m[1]}.${m[2]}`);
      return validValue(n) ? n : null;
    }

    // Tesseract often sees the decimal point as a gap: "67 07" -> 67.07.
    m = s.match(/^(\d{1,3})\s+(\d{2})$/);
    if (m) {
      const n = Number(`${m[1]}.${m[2]}`);
      return validValue(n) ? n : null;
    }

    m = s.replace(/\s+/g, '').match(/^(\d{4,5})$/);
    if (m) {
      const n = Number(m[1]) / 100;
      return validValue(n) ? n : null;
    }
    return null;
  }

  function axisCandidates(text, axis=null) {
    const t = normalizeText(text);
    const out = [];

    const push = (raw, score, source) => {
      const value = tokenValue(raw);
      if (value === null) return;
      if (Math.abs(value - 200) < 0.001) return;
      const existing = out.find(x => Math.abs(x.value - value) < 0.001);
      const bonus = value >= 10 ? 1 : 0;
      const item = { value, score: score + bonus, raw, source };
      if (!existing) out.push(item);
      else if (item.score > existing.score) Object.assign(existing, item);
    };

    if (axis) {
      // Strongest signal: explicit x/y label. Accept a real point OR a missing
      // point represented by whitespace, e.g. "y 67 07".
      const re = new RegExp(`${axis}\\s*[:=]?\\s*(\\d{1,3}\\s*[.]\\s*\\d{2}|\\d{1,3}\\s+\\d{2}|\\d{4,5})(?!\\d)`, 'gi');
      for (const m of t.matchAll(re)) push(m[1], 12, 'label');
    }

    // Exact decimal anywhere in the OCR line.
    for (const m of t.matchAll(/(?<!\d)(\d{1,3}\s*[.]\s*\d{2})(?!\d)/g)) push(m[1], 8, 'decimal');

    // Missing decimal point. Require at least a two-digit integer part to avoid
    // junk such as "1 11" from the grid/crosshair becoming 1.11.
    for (const m of t.matchAll(/(?<!\d)(\d{2,3}\s+\d{2})(?!\d)/g)) push(m[1], 6, 'gap-decimal');

    // Compact coordinate such as 8154 / 10147.
    for (const m of t.matchAll(/(?<!\d)(\d{4,5})(?!\d)/g)) push(m[1], 4, 'compact');

    return out.sort((a,b) => b.score - a.score);
  }

  function parseLabeled(text) {
    const xs = axisCandidates(text, 'x').filter(c => c.source === 'label');
    const ys = axisCandidates(text, 'y').filter(c => c.source === 'label');
    if (!xs.length || !ys.length) return null;
    return { x: xs[0].value, y: ys[0].value };
  }

  async function makeWorker() {
    await ensureOCR();
    const worker = await Tesseract.createWorker('eng', 1, {
      logger: m => {
        if (m.status === 'recognizing text') {
          show(`${VERSION}… ${Math.round((m.progress || 0) * 100)}%`, 'busy');
        }
      }
    });
    await worker.setParameters({
      tessedit_char_whitelist: 'xyXY0123456789.,',
      preserve_interword_spaces: '1',
      user_defined_dpi: '300'
    });
    return worker;
  }

  async function recognizeLabels(worker, bmp) {
    await worker.setParameters({
      tessedit_pageseg_mode: '11',
      tessedit_char_whitelist: 'xyXY0123456789.,'
    });

    // Broad central crops first. This is now the primary path because WARDOGS
    // already prints explicit x/y labels, and it is safer than guessing by order.
    const regions = [
      { x:.12, y:.24, w:.76, h:.48 },
      { x:.05, y:.14, w:.90, h:.68 }
    ];
    const passes = [
      { thr:195, mode:'binary' },
      { thr:165, mode:'binary' },
      { thr:0, mode:'contrast' }
    ];

    const seen = [];
    for (let ri=0; ri<regions.length; ri++) {
      for (let pi=0; pi<passes.length; pi++) {
        show(`${VERSION}: ищу подписи x/y ${ri+1}/${regions.length}, ${pi+1}/${passes.length}…`, 'busy');
        const p = passes[pi];
        const canvas = makeCanvas(bmp, regions[ri], p.thr, p.mode);
        const result = await worker.recognize(canvas);
        const text = String(result.data?.text || '').trim();
        if (text) seen.push(text.replace(/\s+/g, ' '));
        const coords = parseLabeled(text);
        if (coords) return { ...coords, debug: seen.join(' | ') };
      }
    }
    return { x:null, y:null, debug:seen.join(' | ') };
  }

  async function recognizeAxis(worker, bmp, axis) {
    // Fallback: OCR separate Y/X areas. Zones are deliberately generous because
    // the phone framing moves a bit between shots.
    const zones = axis === 'y'
      ? [
          { x:.18, y:.28, w:.65, h:.27 },
          { x:.08, y:.18, w:.84, h:.43 }
        ]
      : [
          { x:.24, y:.46, w:.65, h:.25 },
          { x:.12, y:.36, w:.82, h:.38 }
        ];

    const passes = [
      { thr:195, mode:'binary' },
      { thr:165, mode:'binary' },
      { thr:0, mode:'contrast' }
    ];

    await worker.setParameters({
      tessedit_pageseg_mode: '11',
      tessedit_char_whitelist: 'xyXY0123456789.,'
    });

    let best = null;
    const seen = [];
    for (let zi=0; zi<zones.length; zi++) {
      for (let pi=0; pi<passes.length; pi++) {
        show(`${VERSION}: ${axis.toUpperCase()} fallback ${zi+1}/${zones.length}, ${pi+1}/${passes.length}…`, 'busy');
        const p = passes[pi];
        const canvas = makeCanvas(bmp, zones[zi], p.thr, p.mode);
        const result = await worker.recognize(canvas);
        const text = String(result.data?.text || '').trim();
        if (text) seen.push(text.replace(/\s+/g, ' '));

        const labeled = axisCandidates(text, axis).filter(c => c.source === 'label');
        const generic = axisCandidates(text, null);
        const cand = labeled[0] || generic[0];
        if (!cand) continue;

        const score = cand.score + (zi === 0 ? 2 : 0);
        if (!best || score > best.score) best = { value:cand.value, score, source:cand.source };
        if (labeled.length && labeled[0].score >= 12) {
          return { value:labeled[0].value, debug:seen.join(' | '), source:'label' };
        }
      }
    }
    return best
      ? { value:best.value, debug:seen.join(' | '), source:best.source }
      : { value:null, debug:seen.join(' | '), source:null };
  }

  function put(kind, p) {
    const xEl = kind === 'gun' ? gunX : targetX;
    const yEl = kind === 'gun' ? gunY : targetY;
    xEl.value = p.x.toFixed(2);
    yEl.value = p.y.toFixed(2);
    xEl.dispatchEvent(new Event('input', { bubbles:true }));
    yEl.dispatchEvent(new Event('input', { bubbles:true }));
  }

  async function scan(file, kind) {
    if (!file) return;
    let worker = null, bmp = null;
    try {
      show(`${VERSION}: загружаю OCR…`, 'busy');
      worker = await makeWorker();
      bmp = await bitmap(file);

      // 1) Prefer explicit labels. In the user's real camera shots this also
      // recovers cases like "x81.54" + "y67 07" (lost decimal point).
      const labels = await recognizeLabels(worker, bmp);
      let p = null;
      let debug = `labels: ${labels.debug || '—'}`;
      let mode = 'labels';

      if (labels.x !== null && labels.y !== null) {
        p = { x:labels.x, y:labels.y };
      } else {
        // 2) Only if labels fail, inspect X/Y zones independently.
        const yRes = await recognizeAxis(worker, bmp, 'y');
        const xRes = await recognizeAxis(worker, bmp, 'x');
        debug += ` / Y: ${yRes.debug || '—'} / X: ${xRes.debug || '—'}`;
        if (xRes.value !== null && yRes.value !== null) {
          p = { x:xRes.value, y:yRes.value };
          mode = 'zones';
        }
      }

      if (!p) throw new Error(debug);
      put(kind, p);
      navigator.vibrate?.(60);
      show(`Готово: X ${p.x.toFixed(2)} · Y ${p.y.toFixed(2)} · ${mode === 'labels' ? 'прочитаны подписи x/y' : 'раздельные зоны X/Y'}`, 'good');
    } catch (e) {
      const seen = String(e?.message || '').replace(/\s+/g, ' ').slice(0, 260);
      show(`Не уверен в координатах — ничего не вставил.${seen ? ` OCR: «${seen}»` : ''} Держи координаты и крестик в центральной части кадра.`, 'bad');
    } finally {
      try { bmp?.close?.(); } catch {}
      try { await worker?.terminate(); } catch {}
    }
  }

  document.addEventListener('change', e => {
    const id = e.target?.id;
    if (id !== 'scanGunInput' && id !== 'scanTargetInput') return;
    const file = e.target.files?.[0];
    e.stopImmediatePropagation();
    e.preventDefault();
    const kind = id === 'scanGunInput' ? 'gun' : 'target';
    e.target.value = '';
    scan(file, kind);
  }, true);

  const sub = document.querySelector('.sub');
  if (sub) {
    sub.textContent = sub.textContent.replace(/OCR v\d+/g, VERSION);
    if (!sub.textContent.includes(VERSION)) sub.textContent += ` · ${VERSION}`;
  }
})();
