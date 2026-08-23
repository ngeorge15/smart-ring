/* ---------------- secondary scores ---------------- */
function miniRing(score,label,sub){
  const b=band(score), C=2*Math.PI*19;
  const el=$(`<div class="mini">
    <div class="ring">
      <svg viewBox="0 0 44 44" width="44" height="44">
        <circle cx="22" cy="22" r="19" fill="none" stroke="var(--raise)" stroke-width="4.5"/>
        <circle class="arc" cx="22" cy="22" r="19" fill="none" stroke="${b.c}" stroke-width="4.5"
          stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C}"/>
      </svg>
      <span>${score==null?'—':Math.round(score)}</span>
    </div>
    <div class="txt"><b>${esc(label)}</b><i>${esc(sub)}</i></div>
  </div>`);
  requestAnimationFrame(()=>{if(score!=null)el.querySelector('.arc').style.strokeDashoffset=C*(1-score/100)});
  return el;
}
const sleepComps=R.components.filter(c=>c.name.startsWith('sleep')&&c.available);
const sleepScore=sleepComps.length
  ? sleepComps.reduce((s,c)=>s+c.score*c.weight,0)/sleepComps.reduce((s,c)=>s+c.weight,0):null;
const night=(DATA.sleep.nights||[]).find(n=>n.night_of===DATA.sleep.latest_night);
const hm=m=>`${Math.floor(m/60)}h ${String(Math.round(m%60)).padStart(2,'0')}m`;
const row2=anim($(`<div class="row2"></div>`));
row2.append(miniRing(sleepScore,'Sleep',night?hm(night.asleep_min):'no data'));
const rhr=R.components.find(c=>c.name==='resting_hr');
row2.append(miniRing(rhr&&rhr.available?rhr.score:null,'Resting HR',
  rhr&&rhr.value!=null?`${Math.round(rhr.value)} bpm`:'no data'));
app.append(row2);

/* ---------------- contributors ---------------- */
const comps=anim($(`<div class="card"><h2>Contributors <span class="r">tap for detail</span></h2></div>`));
R.components.forEach(c=>{
  if(c.available){
    const b=band(c.score);
    const row=$(`<div class="comp">
      <div class="row"><span class="nm">${esc(c.name.replace(/_/g,' '))}</span>
        <span class="sc" style="color:${b.c}">${Math.round(c.score)} <span class="chev">▾</span></span></div>
      <div class="ex">${esc(c.explain)}</div>
      <div class="bar"><i style="width:0;background:${b.c}"></i></div>
      <div class="more">Weight ${(c.weight*100).toFixed(0)}% of the total score ·
        confidence ${Math.round(c.confidence*100)}% ·
        scored against your own baseline, not a population average.</div>
    </div>`);
    row.onclick=()=>row.classList.toggle('open');
    requestAnimationFrame(()=>row.querySelector('.bar i').style.width=c.score+'%');
    comps.append(row);
  }else{
    comps.append($(`<div class="comp off">
      <div class="row"><span class="nm">${esc(c.name.replace(/_/g,' '))}</span><span class="sc">—</span></div>
      <div class="ex">dropped: ${esc(c.explain)} — weight redistributed, never scored 50</div>
    </div>`));
  }
});
R.caveats.forEach(w=>comps.append($(`<div class="warn">${esc(w)}</div>`)));
app.append(comps);

/* ---------------- sleep hypnogram ---------------- */
const S=DATA.sleep, segs=S.latest_segments||[];
const sleepCard=anim($(`<div class="card"><h2>Sleep
  <span class="r">${esc(S.latest_night||'')}</span></h2></div>`));
if(!segs.length){
  sleepCard.append($(`<div class="empty">No sleep recorded yet. Wear the ring overnight.</div>`));
}else{
  const ROWS=['awake','REM','light','deep'];
  const COLOR={awake:'var(--awake)',REM:'var(--rem)',light:'var(--light)',deep:'var(--deep)'};
  const t0=new Date(segs[0].start_ts), total=segs.reduce((s,x)=>s+x.minutes,0);
  const W=1000,H=164,PL=46,PB=22,rowH=(H-PB)/ROWS.length;
  let x=0,rects='',ticks='';
  segs.forEach(sg=>{
    const w=sg.minutes/total*(W-PL), y=ROWS.indexOf(sg.stage)*rowH;
    rects+=`<rect x="${(PL+x).toFixed(1)}" y="${(y+4).toFixed(1)}"
      width="${Math.max(1.5,w-2).toFixed(1)}" height="${(rowH-8).toFixed(1)}" rx="3.5"
      fill="${COLOR[sg.stage]||'var(--muted)'}" data-s="${esc(sg.stage)}"
      data-m="${sg.minutes}" data-t="${esc(sg.start_ts.slice(11,16))}"/>`;
    x+=w;
  });
  ROWS.forEach((r,i)=>ticks+=`<text x="${PL-10}" y="${i*rowH+rowH/2+4}" text-anchor="end"
    font-size="11.5" fill="var(--muted)">${r}</text>`);
  const end=new Date(t0.getTime()+total*6e4), fmt=dt=>dt.toTimeString().slice(0,5);
  const svg=$(`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Sleep stages through the night">
    ${ticks}${rects}
    <text x="${PL}" y="${H-3}" font-size="11.5" fill="var(--muted)">${fmt(t0)}</text>
    <text x="${W}" y="${H-3}" font-size="11.5" fill="var(--muted)" text-anchor="end">${fmt(end)}</text>
  </svg>`);
  svg.querySelectorAll('rect').forEach(r=>bindTip(r,
    `${r.dataset.s} · ${r.dataset.m} min · from ${r.dataset.t}`));
  sleepCard.append(svg);
  sleepCard.append($(`<div class="legend">${ROWS.map(r=>
    `<span><i style="background:${COLOR[r]}"></i>${r}</span>`).join('')}</div>`));
  const tot={}; segs.forEach(s=>tot[s.stage]=(tot[s.stage]||0)+s.minutes);
  sleepCard.append($(`<table>
    <tr><th>Stage</th><th>Time</th><th>Share</th></tr>
    ${ROWS.filter(r=>tot[r]).map(r=>`<tr><td>${r}</td><td><b>${hm(tot[r])}</b></td>
      <td><b>${Math.round(tot[r]/total*100)}%</b></td></tr>`).join('')}
    <tr><td>asleep</td><td><b>${hm(night?.asleep_min||0)}</b></td>
        <td><b>${Math.round(night?.efficiency||0)}%</b> eff.</td></tr>
  </table>`));
  sleepCard.append($(`<div class="note">${esc(DATA.gaps.sleep_stages)}</div>`));
}
app.append(sleepCard);

/* ---------------- heart rate ---------------- */
const HR=DATA.hr, pts=HR.points||[];
const hrCard=anim($(`<div class="card"><h2>Heart rate <span class="r">last 3 days</span></h2></div>`));
if(pts.length<2){
  hrCard.append($(`<div class="empty">Not enough heart-rate data yet.</div>`));
}else{
  const W=1000,HT=196,PL=36,PR=6,PT=12,PB=24;
  const xs=pts.map(p=>new Date(p.t).getTime()), ys=pts.map(p=>p.v);
  const x0=Math.min(...xs),x1=Math.max(...xs);
  const lo=Math.floor(Math.min(...ys)/10)*10-5, hi=Math.ceil(Math.max(...ys)/10)*10+5;
  const X=t=>PL+(t-x0)/(x1-x0)*(W-PL-PR), Y=v=>PT+(1-(v-lo)/(hi-lo))*(HT-PT-PB);
  let runs=[],cur=null;
  pts.forEach(p=>{if(!cur||cur.i!==p.i){cur={i:p.i,pts:[]};runs.push(cur)}cur.pts.push(p)});
  runs.forEach((r,k)=>{if(k>0)r.pts.unshift(runs[k-1].pts.at(-1))});
  const path=r=>'M'+r.pts.map(p=>`${X(new Date(p.t).getTime()).toFixed(1)},${Y(p.v).toFixed(1)}`).join('L');
  let grid='';
  for(let v=lo;v<=hi;v+=Math.max(10,Math.round((hi-lo)/4/10)*10)){
    grid+=`<line x1="${PL}" x2="${W-PR}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--grid)"/>
      <text x="${PL-8}" y="${Y(v)+4}" text-anchor="end" font-size="11.5" fill="var(--muted)">${v}</text>`;
  }
  const svg=$(`<svg viewBox="0 0 ${W} ${HT}" role="img" aria-label="Heart rate, last three days">
    ${grid}${runs.map(r=>`<path d="${path(r)}" fill="none" stroke="var(--brand)" stroke-width="2.2"
      stroke-linejoin="round" stroke-linecap="round"
      ${r.i?'stroke-dasharray="4 5" opacity=".4"':''}/>`).join('')}
    <text x="${PL}" y="${HT-3}" font-size="11.5" fill="var(--muted)">
      ${new Date(x0).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</text>
    <text x="${W-PR}" y="${HT-3}" font-size="11.5" fill="var(--muted)" text-anchor="end">
      ${new Date(x1).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</text>
  </svg>`);
  pts.forEach(p=>{
    const c=document.createElementNS('http://www.w3.org/2000/svg','circle');
    c.setAttribute('cx',X(new Date(p.t).getTime()));c.setAttribute('cy',Y(p.v));
    c.setAttribute('r',10);c.setAttribute('fill','transparent');
    bindTip(c,`${p.v} bpm · ${p.t.slice(5).replace('T',' ')}${p.i?' · interpolated':''}`);
    svg.append(c);
  });
  hrCard.append(svg);
  hrCard.append($(`<div class="legend">
    <span><i style="background:var(--brand)"></i>measured</span>
    <span><i style="background:var(--brand);opacity:.4"></i>interpolated — a drawing aid, not data</span></div>`));
  hrCard.append($(`<div class="note">Coverage ${Math.round(HR.coverage*100)}% ·
    ${HR.n_outliers} spike${HR.n_outliers===1?'':'s'} removed by MAD filter ·
    gaps over 15 min left empty rather than smoothed.</div>`));
}
app.append(hrCard);

/* ---------------- trends ---------------- */
const SER=DATA.series||{};
const META={hrv:{t:'HRV',u:' ms'},stress:{t:'Stress',u:''},spo2:{t:'Blood oxygen',u:'%'}};
const trend=anim($(`<div class="card"><h2>Trends <span class="r">vs your baseline</span></h2></div>`));
let any=false;
Object.entries(META).forEach(([k,m])=>{
  const rows=SER[k]; if(!rows||!rows.length) return; any=true;
  const b=DATA.baselines[k]||{}, W=1000,HT=50;
  const stepX=rows.length>1?W/(rows.length-1):0, vs=rows.map(r=>r.mean);
  const lo=Math.min(...vs,b.mean??Infinity), hi=Math.max(...vs,b.mean??-Infinity), rng=(hi-lo)||1;
  const Y=v=>9+(1-(v-lo)/rng)*(HT-18);
  const pathD=rows.length>1?'M'+rows.map((r,i)=>`${(i*stepX).toFixed(1)},${Y(r.mean).toFixed(1)}`).join('L'):'';
  const wrap=$(`<div style="margin-bottom:17px">
    <div style="display:flex;justify-content:space-between;align-items:baseline">
      <span style="font-size:13.5px;font-weight:560">${m.t}</span>
      <span style="font-variant-numeric:tabular-nums;font-weight:660;font-size:15px">
        ${rows.at(-1).mean}${m.u}</span></div>
    <svg viewBox="0 0 ${W} ${HT}" preserveAspectRatio="none" style="height:${HT}px;margin-top:4px">
      ${b.mean!=null?`<line x1="0" x2="${W}" y1="${Y(b.mean)}" y2="${Y(b.mean)}"
        stroke="var(--axis)" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>`:''}
      ${pathD?`<path d="${pathD}" fill="none" stroke="var(--brand)" stroke-width="2.4"
        stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`:''}
      ${rows.map((r,i)=>`<circle cx="${(i*stepX).toFixed(1)}" cy="${Y(r.mean).toFixed(1)}"
        r="4.5" fill="var(--brand)"/>`).join('')}
    </svg>
    <div class="note" style="margin-top:3px">baseline ${b.mean??'—'}${m.u} ·
      ${esc(b.note||b.source||'')}</div></div>`);
  wrap.querySelectorAll('circle').forEach((c,i)=>bindTip(c,
    `${rows[i].day} · mean ${rows[i].mean}${m.u} (${rows[i].n} samples)`));
  trend.append(wrap);
});
if(!any) trend.append($(`<div class="empty">No trend data yet.</div>`));
app.append(trend);

/* ---------------- steps + calibration ---------------- */
const ST=DATA.steps||[];
if(ST.length){
  const last=ST.at(-1), cal=DATA.calibration.steps;
  app.append(anim($(`<div class="tiles">
    <div class="tile"><div class="k">Steps today</div><div class="v">${num(last.steps)}</div>
      <div class="d">${last.partial?`partial — ${last.hours}h recorded`:`${last.hours}h recorded`}</div></div>
    <div class="tile"><div class="k">Calibration</div>
      <div class="v">${cal.ready?(cal.scale?.toFixed(2)??'ready'):`${cal.n}<span style="font-size:15px;color:var(--muted)">/${cal.required}</span>`}</div>
      <div class="d">${cal.ready?'scale vs Watch':'matched hours vs Watch'}</div></div>
  </div>`)));
}

/* ---------------- known limits ---------------- */
const gapCard=anim($(`<div class="card"><h2>Known limits</h2></div>`));
Object.entries(DATA.gaps).forEach(([k,v])=>
  gapCard.append($(`<div class="gap"><b>${esc(k.replace(/_/g,' '))}</b>${esc(v)}</div>`)));
gapCard.append($(`<div class="gap"><b>step calibration</b>${esc(DATA.calibration.steps.note)}</div>`));
gapCard.append($(`<div class="note">Listing what this can't do is deliberate. An app that
  hides its limits is easier to trust and harder to rely on.</div>`));
app.append(gapCard);
