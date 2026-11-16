// NG Maps fix.js — исправления v6 (поиск + диагностика маршрутов). Подключается одной строкой в index.html
(function(){ const st = document.createElement('style');
  st.textContent = '[class*="-gotoymaps"],[class*="-gototech"]{display:none!important}';
  document.head.appendChild(st);
  const d = document.createElement('div'); d.id = 'diagBox';
  d.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:8px;z-index:99999;max-width:50vw;font:14px/1.3 monospace;color:#fff;background:rgba(0,0,0,.65);padding:4px 8px;border-radius:8px;pointer-events:none;word-break:break-all';
  d.textContent = 'fix.js v6 OK';
  document.body.appendChild(d); })();
window.setDiag = function(t){ const d = document.getElementById('diagBox'); if (d) d.textContent = 'fix.js v6 | ' + t; };

function nomSearch(q){
  const c = pos || map.getCenter();
  const vb = [c[1]-1.5, c[0]+1.5, c[1]+1.5, c[0]-1.5].join(',');
  return fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=' + lang + '&viewbox=' + vb + '&q=' + encodeURIComponent(q))
    .then(r => r.json()).then(a => a.map(d => ({ name: d.name || d.display_name.split(',')[0], addr: d.display_name, lat: +d.lat, lng: +d.lon })));
}
function ygeo(q){
  return ymaps.geocode(q, { results: 5, boundedBy: map.getBounds() }).then(res => {
    const out = [], n = res.geoObjects.getLength();
    for (let i = 0; i < n; i++){
      const g = res.geoObjects.get(i), c = g.geometry.getCoordinates();
      out.push({ name: g.properties.get('name') || q, addr: g.getAddressLine ? g.getAddressLine() : '', lat: c[0], lng: c[1] });
    }
    return out;
  });
}
// запасной поиск: геокодер Яндекса + OpenStreetMap одновременно
function fallbackSearch(q, my){
  showMsg(T().searching);
  Promise.all([ygeo(q).catch(e => { console.warn('ygeo', e); return []; }), nomSearch(q).catch(e => { console.warn('nominatim', e); return []; })]).then(r => {
    if (my !== sugSeq) return;
    const out = r[0].slice();
    r[1].forEach(x => { if (!out.some(o => hav([o.lat, o.lng], [x.lat, x.lng]) < 80)) out.push(x); });
    if (!out.length){ showMsg(T().nothing); return; }
    const box = $('results'); box.innerHTML = '';
    out.forEach(it => box.appendChild(placeRow(it)));
    box.classList.remove('hidden');
  });
}
function suggest(v){
  const my = ++sugSeq;
  let p;
  try { p = ymaps.suggest(v, { boundedBy: map.getBounds(), results: 7 }); } catch(e){ console.warn('suggest', e); fallbackSearch(v, my); return; }
  p.then(items => {
    if (my !== sugSeq) return;
    if (!items.length){ fallbackSearch(v, my); return; }
    lastSug = items.map(i => { const parts = String(i.displayName).split(', '); return { name: parts[0], addr: parts.slice(1).join(', '), value: i.value }; });
    const box = $('results'); box.innerHTML = '';
    lastSug.forEach(s => box.appendChild(placeRow(s, { onPick: geocodePick })));
    box.classList.remove('hidden');
  }, err => { console.warn('suggest failed', err); if (my === sugSeq) fallbackSearch(v, my); });
}
function geocodePick(it){
  showMsg(T().searching);
  ymaps.geocode(it.value, { results: 1, boundedBy: map.getBounds() }).then(res => {
    const g = res.geoObjects.get(0);
    if (!g){ fallbackSearch(it.value, ++sugSeq); return; }
    const c = g.geometry.getCoordinates();
    choose({ name: it.name, addr: it.addr || g.getAddressLine(), lat: c[0], lng: c[1] });
  }, () => fallbackSearch(it.value, ++sugSeq));
}
function searchEnter(){
  const q = $('q').value.trim(); if (!q) return;
  const cm = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (cm){ choose({ name: T().coords, addr: cm[1] + ', ' + cm[2], lat: +cm[1], lng: +cm[2] }); return; }
  clearTimeout(sugT);
  if (lastSug.length) geocodePick(lastSug[0]); else fallbackSearch(q, ++sugSeq);
}

function routeMulti(points){
  return new Promise((resolve, reject) => {
    let done = false, model;
    const fin = (ok, v) => { if (done) return; done = true; clearTimeout(timer); (ok ? resolve : reject)(v); };
    const timer = setTimeout(() => fin(false, new Error('timeout')), 12000);
    try { model = new ymaps.multiRouter.MultiRouteModel(points, { results: 3, avoidTrafficJams: true, routingMode: 'auto' }); }
    catch(e){ fin(false, e); return; }
    model.events.add('requestsuccess', () => {
      try {
        const list = arr(model.getRoutes()).map(r => { try { return parseMulti(r, points[0]); } catch(e){ return null; } }).filter(Boolean);
        if (!list.length) throw new Error('empty');
        fin(true, list);
      } catch(e){ fin(false, e); }
    });
    model.events.add('requestfail', ev => { let m = 'requestfail'; try { const e = ev.get('error'); m = 'requestfail: ' + ((e && (e.message || e.name)) || JSON.stringify(e)); } catch(x){} fin(false, new Error(m)); });
  });
}

async function fetchRoutes(yandexOnly){
  const from = pos || map.getCenter();
  const pts = [from].concat(stops.map(s => [s.lat, s.lng]));
  let list, src = 'yandex';
  window.routeDiag = ''; setDiag('routing…');
  try { list = await routeMulti(pts); }
  catch(e){
    window.routeDiag = 'multi: ' + (e && e.message || e);
    try { list = [await routeOld(pts)]; }
    catch(e1){
      window.routeDiag += ' | route: ' + (e1 && (e1.message || e1.name) || e1);
      console.warn('yandex routing failed', window.routeDiag);
      if (yandexOnly) return null;
      try { list = await routeOSRM(pts); src = 'osrm'; } catch(e2){ return null; }
    }
  }
  if (src === 'osrm' && window.routeDiag){ try { toast('Yandex: ' + String(window.routeDiag).slice(0, 140), 9000); } catch(e){} }
  setDiag(src === 'osrm' ? 'OSRM (no traffic). ' + String(window.routeDiag).slice(0, 300) : 'Yandex routing OK');
  const names = stops.map(s => s.name);
  list.forEach(r => r.steps.forEach(s => { if (s.act === 'stop') s.name = names[s.n] || ''; }));
  return { list, src };
}
