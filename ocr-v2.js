(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const scanStatus = $('scanStatus');
  const gunX = $('gunX'), gunY = $('gunY'), targetX = $('targetX'), targetY = $('targetY');
  if (!scanStatus || !gunX || !gunY || !targetX || !targetY) return;

  let ocrPromise = null;
  const VERSION = 'OCR v3';

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

  function makeCanvas(bmp, region, threshold=180, mode='binary') {
    const W=bmp.width, H=bmp.height;
    const sx=Math.max(0,Math.round(W*region.x));
    const sy=Math.max(0,Math.round(H*region.y));
    const sw=Math.max(1,Math.min(W-sx,Math.round(W*region.w)));
    const sh=Math.max(1,Math.min(H-sy,Math.round(H*region.h)));
    const scale=Math.min(5, 1900/sw);
    const c=document.createElement('canvas');
    c.width=Math.max(1,Math.round(sw*scale));
    c.height=Math.max(1,Math.round(sh*scale));
    const ctx=c.getContext('2d',{willReadFrequently:true});
    ctx.imageSmoothingEnabled=true;
    ctx.drawImage(bmp,sx,sy,sw,sh,0,0,c.width,c.height);

    const img=ctx.getImageData(0,0,c.width,c.height), d=img.data;
    for(let i=0;i<d.length;i+=4){
      const r=d[i],g=d[i+1],b=d[i+2];
      const lum=.299*r+.587*g+.114*b;
      const spread=Math.max(r,g,b)-Math.min(r,g,b);
      let v;
      if(mode==='contrast'){
        // White HUD text becomes dark on a white background.
        const boosted=Math.max(0,Math.min(255,(lum-95)*2.15));
        v=255-boosted;
      }else{
        // Coordinates are nearly white. Ignore most coloured map detail.
        const whiteish=lum>=threshold && spread<105;
        v=whiteish?0:255;
      }
      d[i]=d[i+1]=d[i+2]=v; d[i+3]=255;
    }
    ctx.putImageData(img,0,0);
    return c;
  }

  function normalizeText(s){
    return String(s||'')
      .replace(/[OoQ]/g,'0')
      .replace(/[Il|]/g,'1')
      .replace(/[,:;]/g,'.')
      .replace(/[^xyXY0-9.\s]/g,' ');
  }

  function valueFromToken(v){
    const s=String(v||'').replace(/\s+/g,'').replace(',','.');
    let m=s.match(/^(\d{1,3})\.(\d{2})$/);
    if(m){
      const n=Number(`${m[1]}.${m[2]}`);
      return n>=0 && n<200 ? n : null;
    }
    m=s.match(/^(\d{4,5})$/);
    if(m){
      const n=Number(m[1])/100;
      return n>=0 && n<200 ? n : null;
    }
    return null;
  }

  function candidatesFromText(text){
    const t=normalizeText(text);
    const out=[];
    const push=(raw,score)=>{
      const v=valueFromToken(raw);
      if(v===null) return;
      // Reject the game's $200 marker if OCR drops the dollar sign.
      if(Math.abs(v-2.00)<0.0001 || Math.abs(v-200)<0.0001) return;
      if(!out.some(x=>Math.abs(x.value-v)<0.001)) out.push({value:v,score,raw});
    };
    for(const line0 of t.split(/\n+/)){
      const line=line0.trim();
      if(!line) continue;
      for(const m of line.matchAll(/(?<!\d)(\d{1,3}\s*[.]\s*\d{2})(?!\d)/g)) push(m[1],5);
      for(const m of line.matchAll(/(?<!\d)(\d{4,5})(?!\d)/g)) push(m[1],3);
      // Tesseract sometimes inserts a space around the decimal or splits the number.
      const compact=line.replace(/\s+/g,'');
      for(const m of compact.matchAll(/(?<!\d)(\d{1,3}\.\d{2})(?!\d)/g)) push(m[1],4);
    }
    return out.sort((a,b)=>b.score-a.score);
  }

  function parseExplicitLabels(text){
    const t=normalizeText(text);
    let x=null,y=null;
    for(const m of t.matchAll(/([xy])\s*[:=]?\s*(\d{1,3}\s*[.]\s*\d{2}|\d{4,5})/gi)){
      const v=valueFromToken(m[2]);
      if(v===null) continue;
      if(m[1].toLowerCase()==='x') x=v; else y=v;
    }
    return x!==null&&y!==null?{x,y}:null;
  }

  async function makeWorker(){
    await ensureOCR();
    const worker=await Tesseract.createWorker('eng',1,{
      logger:m=>{
        if(m.status==='recognizing text') show(`${VERSION}… ${Math.round((m.progress||0)*100)}%`,'busy');
      }
    });
    await worker.setParameters({
      tessedit_char_whitelist:'xyXY0123456789.,',
      preserve_interword_spaces:'1',
      user_defined_dpi:'300'
    });
    return worker;
  }

  async function recognizeBand(worker,bmp,axis){
    // In WARDOGS the coordinate HUD is anchored around the map crosshair:
    // Y is the upper line, X is the lower line. These overlapping zones are
    // deliberately generous so the crosshair does not have to be pixel-perfect.
    const zones=axis==='y'
      ? [
          {x:.25,y:.27,w:.58,h:.23},
          {x:.18,y:.20,w:.70,h:.34}
        ]
      : [
          {x:.31,y:.40,w:.58,h:.20},
          {x:.22,y:.34,w:.70,h:.31}
        ];
    const passes=[
      {thr:205,mode:'binary'},
      {thr:180,mode:'binary'},
      {thr:155,mode:'binary'},
      {thr:0,mode:'contrast'}
    ];
    let best=null;
    const seen=[];
    await worker.setParameters({tessedit_pageseg_mode:'7',tessedit_char_whitelist:'0123456789.,'});
    for(let zi=0;zi<zones.length;zi++){
      for(let pi=0;pi<passes.length;pi++){
        show(`${VERSION}: ${axis.toUpperCase()} ${zi+1}/${zones.length}, проход ${pi+1}/${passes.length}…`,'busy');
        const p=passes[pi];
        const canvas=makeCanvas(bmp,zones[zi],p.thr,p.mode);
        const result=await worker.recognize(canvas);
        const text=String(result.data?.text||'').trim();
        if(text) seen.push(text.replace(/\s+/g,' '));
        const cands=candidatesFromText(text);
        if(cands.length){
          const cand=cands[0];
          const bonus=zi===0?2:0;
          const score=cand.score+bonus;
          if(!best||score>best.score) best={value:cand.value,score,text};
          // Exact decimal in the tight zone is strong enough to stop early.
          if(zi===0 && cand.score>=5) return {value:cand.value,debug:seen.join(' | ')};
        }
      }
    }
    return best?{value:best.value,debug:seen.join(' | ')}:{value:null,debug:seen.join(' | ')};
  }

  async function explicitFallback(worker,bmp){
    await worker.setParameters({
      tessedit_pageseg_mode:'11',
      tessedit_char_whitelist:'xyXY0123456789.,'
    });
    const regions=[
      {x:.14,y:.20,w:.72,h:.47},
      {x:.06,y:.12,w:.88,h:.65}
    ];
    const seen=[];
    for(const r of regions){
      for(const thr of [195,170]){
        const canvas=makeCanvas(bmp,r,thr,'binary');
        const result=await worker.recognize(canvas);
        const text=String(result.data?.text||'').trim();
        if(text) seen.push(text.replace(/\s+/g,' '));
        const p=parseExplicitLabels(text);
        if(p) return {...p,debug:seen.join(' | ')};
      }
    }
    return {x:null,y:null,debug:seen.join(' | ')};
  }

  function put(kind,p){
    const xEl=kind==='gun'?gunX:targetX;
    const yEl=kind==='gun'?gunY:targetY;
    xEl.value=p.x.toFixed(2);
    yEl.value=p.y.toFixed(2);
    xEl.dispatchEvent(new Event('input',{bubbles:true}));
    yEl.dispatchEvent(new Event('input',{bubbles:true}));
  }

  async function scan(file,kind){
    if(!file) return;
    let worker=null,bmp=null;
    try{
      show(`${VERSION}: загружаю OCR…`,'busy');
      worker=await makeWorker();
      bmp=await bitmap(file);

      const yRes=await recognizeBand(worker,bmp,'y');
      const xRes=await recognizeBand(worker,bmp,'x');

      let p=null, mode='zones', debug=`Y: ${yRes.debug||'—'} / X: ${xRes.debug||'—'}`;
      if(xRes.value!==null && yRes.value!==null){
        p={x:xRes.value,y:yRes.value};
      }else{
        show(`${VERSION}: проверяю подписи x/y…`,'busy');
        const fb=await explicitFallback(worker,bmp);
        debug += ` / labels: ${fb.debug||'—'}`;
        if(fb.x!==null&&fb.y!==null){p={x:fb.x,y:fb.y};mode='labels';}
      }

      if(!p) throw new Error(debug);
      put(kind,p);
      navigator.vibrate?.(60);
      show(`Готово: X ${p.x.toFixed(2)} · Y ${p.y.toFixed(2)} · ${mode==='zones'?'раздельные зоны X/Y':'прочитаны подписи x/y'}`,'good');
    }catch(e){
      const seen=String(e?.message||'').replace(/\s+/g,' ').slice(0,220);
      show(`Не уверен в координатах — ничего не вставил.${seen?` OCR: «${seen}»`:''} Держи игровой крестик ближе к центру кадра и сними чуть ближе.`,'bad');
    }finally{
      try{bmp?.close?.();}catch{}
      try{await worker?.terminate();}catch{}
    }
  }

  document.addEventListener('change',e=>{
    const id=e.target?.id;
    if(id!=='scanGunInput'&&id!=='scanTargetInput') return;
    const file=e.target.files?.[0];
    e.stopImmediatePropagation();
    e.preventDefault();
    const kind=id==='scanGunInput'?'gun':'target';
    e.target.value='';
    scan(file,kind);
  },true);

  const sub=document.querySelector('.sub');
  if(sub){
    sub.textContent=sub.textContent.replace(/OCR v\d+/g,VERSION);
    if(!sub.textContent.includes(VERSION)) sub.textContent+=` · ${VERSION}`;
  }
})();
