(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const scanStatus = $('scanStatus');
  const gunX = $('gunX'), gunY = $('gunY'), targetX = $('targetX'), targetY = $('targetY');
  if (!scanStatus || !gunX || !gunY || !targetX || !targetY) return;

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
    try { return await createImageBitmap(file, {imageOrientation:'from-image'}); }
    catch { return await createImageBitmap(file); }
  }

  async function preprocess(file, mode='focus', threshold=185) {
    const bmp = await bitmap(file), W = bmp.width, H = bmp.height;
    const r = mode === 'focus'
      ? {x:.16, y:.25, w:.68, h:.38}
      : {x:.06, y:.13, w:.88, h:.68};
    const sx = Math.round(W*r.x), sy = Math.round(H*r.y);
    const sw = Math.round(W*r.w), sh = Math.round(H*r.h);
    const scale = Math.min(3.4, 2400/sw);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw*scale));
    c.height = Math.max(1, Math.round(sh*scale));
    const ctx = c.getContext('2d', {willReadFrequently:true});
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
    bmp.close?.();

    const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
    for (let i=0; i<d.length; i+=4) {
      const lum = .299*d[i] + .587*d[i+1] + .114*d[i+2];
      const spread = Math.max(d[i],d[i+1],d[i+2]) - Math.min(d[i],d[i+1],d[i+2]);
      const whiteish = lum >= threshold && spread < 85;
      const v = whiteish ? 0 : 255;
      d[i]=d[i+1]=d[i+2]=v; d[i+3]=255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  function norm(s) {
    return String(s||'')
      .replace(/[OoQ]/g,'0')
      .replace(/[Il|]/g,'1')
      .replace(/[,:;]/g,'.')
      .replace(/[^xyXY0-9.\s]/g,' ');
  }

  function token(v) {
    v = String(v||'').trim().replace(/\s+/g,'');
    let m = v.match(/^(\d{1,3})\.(\d{2})$/);
    if (m) return Number(`${m[1]}.${m[2]}`);
    m = v.match(/^(\d{4,5})$/);
    return m ? Number(m[1])/100 : null;
  }

  function parse(data) {
    const text = norm(data?.text);
    let x=null, y=null;
    for (const m of text.matchAll(/([xy])\s*[:=]?\s*(\d{1,3}\s*[.]\s*\d{2}|\d{4,5})/gi)) {
      const v = token(m[2]);
      if (v === null || v >= 200) continue;
      if (m[1].toLowerCase() === 'x') x=v; else y=v;
    }
    if (x !== null && y !== null) return {x,y,mode:'labels'};

    const vals=[];
    for (const m of text.matchAll(/(?<!\d)(\d{1,3}\s*[.]\s*\d{2}|\d{4,5})(?!\d)/g)) {
      const v = token(m[1]);
      if (v !== null && v >= 0 && v < 200 && !vals.some(n=>Math.abs(n-v)<.001)) vals.push(v);
    }
    if (vals.length >= 2) return {x:vals[1], y:vals[0], mode:'numbers'};

    const words=(data?.words||[])
      .map(w=>({t:norm(w.text).replace(/^[xy]\s*/i,''),box:w.bbox}))
      .map(w=>({...w,v:token(w.t)}))
      .filter(w=>w.v!==null && w.v<200);
    if (words.length>=2) {
      words.sort((a,b)=>((a.box?.y0||0)+(a.box?.y1||0))-((b.box?.y0||0)+(b.box?.y1||0)));
      return {x:words[words.length-1].v, y:words[0].v, mode:'position'};
    }
    return null;
  }

  async function makeWorker() {
    await ensureOCR();
    const worker = await Tesseract.createWorker('eng', 1, {
      logger:m => {
        if (m.status === 'recognizing text') show(`OCR v2… ${Math.round((m.progress||0)*100)}%`, 'busy');
      }
    });
    await worker.setParameters({
      tessedit_char_whitelist:'xyXY0123456789.,',
      tessedit_pageseg_mode:'11',
      preserve_interword_spaces:'1',
      user_defined_dpi:'300'
    });
    return worker;
  }

  function put(kind,p) {
    const xEl = kind==='gun' ? gunX : targetX;
    const yEl = kind==='gun' ? gunY : targetY;
    xEl.value = p.x.toFixed(2);
    yEl.value = p.y.toFixed(2);
    xEl.dispatchEvent(new Event('input',{bubbles:true}));
    yEl.dispatchEvent(new Event('input',{bubbles:true}));
  }

  async function scan(file, kind) {
    if (!file) return;
    let worker=null, lastText='';
    try {
      show('OCR v2: подготавливаю фото…','busy');
      worker = await makeWorker();
      const attempts = [
        ['focus',205], ['focus',185], ['focus',160], ['broad',190]
      ];
      let p=null;
      for (let i=0; i<attempts.length && !p; i++) {
        const [mode,thr] = attempts[i];
        show(`OCR v2: проход ${i+1}/${attempts.length}…`,'busy');
        const canvas = await preprocess(file,mode,thr);
        const result = await worker.recognize(canvas);
        lastText = String(result.data?.text||'').trim();
        p = parse(result.data);
      }
      if (!p) throw new Error('coords');
      put(kind,p);
      navigator.vibrate?.(60);
      show(`Готово: X ${p.x.toFixed(2)} · Y ${p.y.toFixed(2)}${p.mode!=='labels'?' · x/y восстановлены по расположению':''}`,'good');
    } catch (e) {
      const seen = lastText.replace(/\s+/g,' ').slice(0,100);
      show(`Не прочитал X/Y.${seen?` OCR увидел: «${seen}»`:''} Наведи пересечение линий примерно в центр кадра и сними чуть ближе.`,'bad');
    } finally {
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
    e.target.value='';
    scan(file,kind);
  }, true);

  const sub=document.querySelector('.sub');
  if (sub && !sub.textContent.includes('OCR v2')) sub.textContent += ' · OCR v2';
})();
