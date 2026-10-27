// End-to-end: launch the real app, import real media, edit with the keyboard
// and mouse like a user, play, export, and check the exported file.
// Run: xvfb-run -a node tests/e2e.mjs <media-dir> <out-dir>
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const mediaDir = process.argv[2];
const outDir = process.argv[3];
mkdirSync(outDir, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(outDir, `${name}.png`) });
const log = (...a) => console.log('[e2e]', ...a);
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); log(ok ? 'PASS' : 'FAIL', name, detail); };

// KURGU_EXE=path/to/packaged/app tests the installed build with its bundled ffmpeg
const app = process.env.KURGU_EXE
  ? await electron.launch({ executablePath: process.env.KURGU_EXE, args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
  : await electron.launch({
    args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', 'out/main/index.js'],
    env: { ...process.env, KURGU_FFMPEG: 'ffmpeg', KURGU_FFPROBE: 'ffprobe', ELECTRON_ENABLE_LOGGING: '1' },
  });
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/status of 404/.test(m.text())) errors.push(m.text()); });
page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${decodeURIComponent(r.url()).slice(-80)}`); });
await page.setViewportSize({ width: 1600, height: 960 });
await page.waitForSelector('.timeline');
await page.waitForTimeout(800);
// dismiss recovery / info if shown
await page.evaluate(() => window.__kurgu.store.useStore.setState({ dialog: null }));
const homeShown = await page.waitForSelector('.home-card', { timeout: 5000 }).then(() => true).catch(() => false);
await shot(page, '00-baslangic-ekrani');
check('Başlangıç ekranı açılıyor', homeShown);
await page.click('.home-skip');
await shot(page, '01-bos-proje');

// ---- import
const files = ['kamera-1.mp4', 'kamera-2.mp4', 'prores-master.mov', 'muzik.wav', 'logo.png'].map((f) => join(mediaDir, f));
await page.evaluate((p) => window.__kurgu.store.importPaths(p), files);
await page.waitForFunction(() => Object.keys(window.__kurgu.store.useStore.getState().project.media).length === 5, null, { timeout: 30000 });
check('5 dosya içe aktarıldı', true);
// thumbnails, waveforms and the ProRes proxy
await page.waitForFunction(() => {
  const s = window.__kurgu.store.useStore.getState();
  const m = Object.values(s.project.media);
  const prores = m.find((x) => x.name.endsWith('.mov'));
  return m.filter((x) => s.assets[x.path]).length >= 4 && !!s.proxies[prores.path];
}, null, { timeout: 120000 });
const seqInfo = await page.evaluate(() => { const st = window.__kurgu.store.useStore.getState(); const s = window.__kurgu.store.committedSeq(st); return { w: s.width, h: s.height, fps: s.fps }; });
check('Sekans ilk klibe uydu', seqInfo.w === 1920 && seqInfo.h === 1080 && seqInfo.fps === 30, JSON.stringify(seqInfo));
check('ProRes için proxy üretildi', true);
await shot(page, '02-ice-aktarildi');

// ---- open kamera-1 in source monitor, mark in/out, insert with ","
await page.dblclick('.media-card:has-text("kamera-1.mp4")');
await page.waitForTimeout(600);
await page.evaluate(() => {
  const st = window.__kurgu.store;
  const m = Object.values(st.useStore.getState().project.media).find((x) => x.name === 'kamera-1.mp4');
  st.editProject('test marks', (p) => { p.media[m.id].markIn = 1; p.media[m.id].markOut = 5; });
});
await page.keyboard.press(',');
await page.waitForTimeout(200);
let clips = await page.evaluate(() => Object.values(window.__kurgu.store.committedSeq().clips).map((c) => ({ s: c.stream, start: c.start, d: c.duration, src: c.srcIn })));
check('Kaynaktan ekleme (,) — 4 sn bağlı A/V', clips.length === 2 && clips.every((c) => c.d === 120 && Math.abs(c.src - 1) < 1e-6), JSON.stringify(clips));

// ---- drag kamera-2 from project panel to the end of V1
const v1 = await page.evaluate(() => {
  const s = window.__kurgu.store.committedSeq();
  return s.tracks.find((t) => t.kind === 'video' && t.name === 'V1').id;
});
async function dragMedia(name, frame, laneIndexFromTop) {
  const card = await page.$(`.media-card:has-text("${name}")`);
  const lanes = await page.$$('.lane');
  const lane = lanes[laneIndexFromTop];
  const lb = await lane.boundingBox();
  const zoom = await page.evaluate(() => window.__kurgu.store.useStore.getState().zoom);
  const scrollLeft = await page.evaluate(() => document.querySelector('.tl-scroll').scrollLeft);
  const x = lb.x + frame * zoom - scrollLeft + 2;
  const y = lb.y + lb.height / 2;
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await card.dispatchEvent('dragstart', { dataTransfer });
  const target = await page.$('.tl-scroll');
  await target.dispatchEvent('dragover', { dataTransfer, clientX: x, clientY: y });
  await target.dispatchEvent('drop', { dataTransfer, clientX: x, clientY: y });
}
// lanes from top: V3, V2, V1, A1, A2, A3
await dragMedia('kamera-2.mp4', 120, 2);
await page.waitForTimeout(200);
clips = await page.evaluate(() => Object.values(window.__kurgu.store.committedSeq().clips).length);
check('Proje panelinden timeline\'a sürükle-bırak', clips === 4, `${clips} klip`);
await dragMedia('muzik.wav', 0, 4);
await dragMedia('logo.png', 30, 1);
await dragMedia('prores-master.mov', 360, 2);
await page.waitForTimeout(300);
const counts = await page.evaluate(() => {
  const s = window.__kurgu.store.committedSeq();
  const by = {};
  for (const c of Object.values(s.clips)) { const t = s.tracks.find((x) => x.id === c.trackId).name; by[t] = (by[t] ?? 0) + 1; }
  return by;
});
check('Müzik A2\'ye, logo V2\'ye, ProRes V1\'e düştü', counts.A2 === 1 && counts.V2 === 1 && counts.V1 === 3, JSON.stringify(counts));

// ---- keyboard editing: playhead to 60, Ctrl+K cut, select right part, ripple delete
await page.click('.tl-scroll', { position: { x: 5, y: 200 } }); // focus timeline (empty area)
await page.evaluate(() => { window.__kurgu.store.setPlayhead(60); });
await page.keyboard.press('Control+k');
await page.waitForTimeout(100);
const afterCut = await page.evaluate(() => Object.values(window.__kurgu.store.committedSeq().clips).filter((c) => c.mediaId && c.start === 60).length);
check('Ctrl+K oynatma kafasında kesti', afterCut >= 2, `${afterCut} yeni parça`);

// razor tool click on kamera-2 at frame 200
await page.keyboard.press('c');
const tool = await page.evaluate(() => window.__kurgu.store.useStore.getState().tool);
check('C → jilet aracı', tool === 'razor');
{
  const zoom = await page.evaluate(() => window.__kurgu.store.useStore.getState().zoom);
  const lanes = await page.$$('.lane');
  const lb = await lanes[2].boundingBox();
  await page.mouse.click(lb.x + 200 * zoom + 1, lb.y + lb.height / 2);
}
const v1Count = await page.evaluate(() => { const s = window.__kurgu.store.committedSeq(); const v1 = s.tracks.find((t) => t.name === 'V1').id; return Object.values(s.clips).filter((c) => c.trackId === v1).length; });
check('Jilet ile fareyle kesim', v1Count === 5, `V1'de ${v1Count} klip`);

// selection tool: drag the in-edge of the last kamera-2 piece (ripple with B tool)
await page.keyboard.press('v');
await page.evaluate(() => window.__kurgu.ops && null);
const before = await page.evaluate(() => window.__kurgu.store.committedSeq());
const target = Object.values(before.clips).filter((c) => c.trackId === before.tracks.find((t) => t.name === 'V1').id).sort((a, b) => a.start - b.start)[1];
await page.evaluate((id) => window.__kurgu.store.selectClips([id]), target.id);
// with the overlay track sync-locked, ripple delete must refuse (protects sync)
await page.keyboard.press('Shift+Delete');
const refused = await page.evaluate((id) => !!window.__kurgu.store.committedSeq().clips[id], target.id);
check('Dalgalı silme senkronu bozacaksa reddediyor', refused);
// unlock sync on V2/A2 → now it must close the gap
await page.evaluate(() => window.__kurgu.store.edit('sync off', (s) => { for (const t of s.tracks) if (t.name === 'V2' || t.name === 'A2') t.syncLock = false; }));
await page.evaluate((id) => window.__kurgu.store.selectClips([id]), target.id);
await page.keyboard.press('Shift+Delete');
await page.waitForTimeout(100);
const afterRipple = await page.evaluate(() => { const s = window.__kurgu.store.committedSeq(); const v1 = s.tracks.find((t) => t.name === 'V1').id; return Object.values(s.clips).filter((c) => c.trackId === v1).sort((a, b) => a.start - b.start).map((c) => [c.start, c.duration]); });
const gone = await page.evaluate((id) => !window.__kurgu.store.committedSeq().clips[id], target.id);
check('Klip dalgalı silindi', gone);
const noGap = afterRipple.every((c, i) => i === 0 || c[0] === afterRipple[i - 1][0] + afterRipple[i - 1][1]);
check('Shift+Delete dalgalı sil — boşluk kalmadı', noGap, JSON.stringify(afterRipple));

// undo / redo
await page.keyboard.press('Control+z');
const undone = await page.evaluate((id) => !!window.__kurgu.store.committedSeq().clips[id], target.id);
check('Ctrl+Z geri aldı', undone);
await page.keyboard.press('Control+Shift+z');
const redone = await page.evaluate((id) => !window.__kurgu.store.committedSeq().clips[id], target.id);
check('Ctrl+Shift+Z yineledi', redone);

// trim by dragging an edge with the ripple tool (B)
await page.keyboard.press('b');
{
  const seq = await page.evaluate(() => window.__kurgu.store.committedSeq());
  const v1id = seq.tracks.find((t) => t.name === 'V1').id;
  const first = Object.values(seq.clips).filter((c) => c.trackId === v1id).sort((a, b) => a.start - b.start)[0];
  const zoom = await page.evaluate(() => window.__kurgu.store.useStore.getState().zoom);
  const lanes = await page.$$('.lane');
  const lb = await lanes[2].boundingBox();
  const x = lb.x + (first.start + first.duration) * zoom - 2;
  const y = lb.y + lb.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 15 * zoom, y, { steps: 6 });
  await shot(page, '03-ripple-kirpma-surukleme');
  await page.mouse.up();
  const after = await page.evaluate((id) => window.__kurgu.store.committedSeq().clips[id].duration, first.id);
  check('Ripple aracıyla kenar sürükleyerek kırpma', after < first.duration, `${first.duration} → ${after}`);
}
await page.keyboard.press('v');

// logo: scale + opacity + keyframed position via effect controls state
await page.evaluate(() => {
  const st = window.__kurgu.store;
  const s = st.committedSeq();
  const logo = Object.values(s.clips).find((c) => c.name === 'logo.png');
  st.edit('logo fx', (q) => {
    const c = q.clips[logo.id];
    c.transform.scale.value = 30; c.transform.opacity.value = 80;
    c.transform.posX.keyframes = [{ frame: 0, value: -600, ease: 'ease' }, { frame: 60, value: 600, ease: 'linear' }];
  });
  st.selectClips([logo.id]);
});
await page.click('.tab:has-text("Efekt Kontrolleri")');
await page.evaluate(() => window.__kurgu.store.setPlayhead(60));
await page.waitForTimeout(400);
await shot(page, '04-efekt-kontrolleri');

// speed dialog: kamera-2 piece at 50%
await page.evaluate(() => {
  const st = window.__kurgu.store;
  const s = st.committedSeq();
  const c = Object.values(s.clips).find((x) => x.name === 'kamera-2.mp4' && x.stream === 'video');
  st.selectClips([c.id]);
});
await page.keyboard.press('Control+r');
await page.waitForSelector('.modal');
await page.click('.modal button:has-text("%50")');
await shot(page, '05-hiz-penceresi');
await page.click('.modal button:has-text("Uygula")');
const sp = await page.evaluate(() => Object.values(window.__kurgu.store.committedSeq().clips).filter((x) => x.name === 'kamera-2.mp4').map((x) => x.speed));
check('Hız/Süre penceresi %50 (seçili klip + bağlı sesi)', sp.filter((x) => Math.abs(x - 0.5) < 1e-6).length === 2, JSON.stringify(sp));

// playback
await page.evaluate(() => { window.__kurgu.store.setPlayhead(0); window.__kurgu.store.useStore.setState({ selection: [] }); });
await page.keyboard.press('Space');
await page.waitForTimeout(1500);
const ph = await page.evaluate(() => window.__kurgu.store.committedSeq().playhead);
await shot(page, '06-oynatma');
await page.keyboard.press('Space');
check('Oynatma ilerliyor (Boşluk)', ph > 20, `1.5 sn sonra kare ${ph}`);

// fit + screenshot of the whole edit
await page.keyboard.press('\\');
await page.evaluate(() => window.__kurgu.store.setPlayhead(75));
await page.waitForTimeout(600);
await shot(page, '07-kurgu');

// save project
const projFile = join(outDir, 'test-projesi.kurgu');
const saved = await page.evaluate(async (p) => window.kurgu.saveProject(window.__kurgu.store.useStore.getState().project, p), projFile);
check('Proje kaydedildi', saved === projFile && existsSync(projFile));

// ---- captions
await page.click('.modes button:has-text("Kurgu")').catch(() => {});
{
  // speech audio for recognition: 16 kHz mono mix of the chosen tracks
  const wav = await page.evaluate(async () => {
    const st = window.__kurgu.store.useStore.getState();
    const s = window.__kurgu.store.committedSeq(st);
    const a1 = s.tracks.find((t) => t.name === 'A1').id;
    return window.kurgu.speechAudio({ project: st.project, sequenceId: s.id, trackIds: [a1] });
  });
  const w = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=sample_rate,channels:format=duration', '-of', 'json', wav]).toString());
  check('Konuşma sesi 16 kHz mono çıkarıldı', w.streams[0].sample_rate === '16000' && w.streams[0].channels === 1, JSON.stringify(w.streams[0]));
  // full automatic run: here the model server is unreachable, so it must fail gracefully
  await page.evaluate(() => window.__kurgu.store.useStore.setState({ toasts: [] }));
  await page.click('.tab:has-text("Altyazı")');
  await page.waitForSelector('button:has-text("Altyazı oluştur")');
  await shot(page, '11-altyazi-paneli');
  await page.click('button:has-text("Altyazı oluştur")');
  await page.waitForFunction(() => window.__kurgu.store.useStore.getState().toasts.some((t) => /Altyazı|altyazı/.test(t.text)), null, { timeout: 120000 });
  const msg = await page.evaluate(() => window.__kurgu.store.useStore.getState().toasts.map((t) => t.text).join(' | '));
  check('Model indirilemezse anlaşılır mesaj, uygulama çalışmaya devam ediyor', /internet|indirilemedi|oluşturulamadı/i.test(msg), msg.slice(0, 160));
  // inject recognised words (what the model returns) and check the whole caption pipeline
  await page.evaluate(() => {
    const k = window.__kurgu;
    const text = "Merhaba arkadaşlar bugün size Ankara'nın en güzel kahvaltı mekanını tanıtıyoruz. Hadi başlayalım!";
    let f = 6;
    const words = text.split(' ').map((x) => { const w = { text: x, start: f, end: f + 9 }; f += 11; return w; });
    k.store.edit('test captions', (s) => {
      const tr = k.capcore.emptyCaptions('tr');
      tr.items = k.capcore.groupWords(words, k.capcore.fitted(tr.style, s.width, s.height), s.fps);
      s.captions = tr;
    });
    k.store.setPlayhead(30);
  });
  await page.waitForTimeout(500);
  const lane = await page.$$eval('.tl-scroll [title]', (els) => els.filter((e) => e.textContent && /Merhaba|ANKARA|Ankara/.test(e.textContent)).length);
  check('Altyazı timeline satırında görünüyor', lane > 0, `${lane} blok`);
  await shot(page, '12-altyazi-onizleme');
  // program monitor shows caption pixels (bright text in the middle band)
  const bright = await page.evaluate(() => {
    const c = document.querySelector('.viewer canvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, Math.floor(c.height * 0.35), c.width, Math.floor(c.height * 0.3)).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 235 && d[i + 1] > 200) n++;
    return n;
  });
  check('Program monitöründe altyazı çiziliyor', bright > 200, `${bright} parlak piksel`);
  // export frame (canvas must be readable, not tainted)
  const framePath = join(outDir, 'kare.png');
  await page.evaluate(async (p) => {
    const c = document.querySelector('.viewer canvas');
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    await window.kurgu.writeBinary(p, new Uint8Array(await blob.arrayBuffer()));
  }, framePath);
  check('Kareyi dışa aktar çalışıyor', existsSync(framePath));
  // export with burn-in
  const capOut = join(outDir, 'altyazili-export.mp4');
  const capJob = await page.evaluate(async (out) => {
    const k = window.__kurgu;
    const st = k.store.useStore.getState();
    const s = k.store.committedSeq(st);
    const b = await k.captions.prepareBurn(s, 0);
    return window.kurgu.exportSequence({ project: st.project, sequenceId: s.id, settings: { output: out, container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', rateControl: 'quality', quality: 26, videoBitrateKbps: 8000, audioBitrateKbps: 128, range: 'all', hardware: 'none', preset: 'ultrafast', burnSubtitles: b.ass, subtitlesFontsDir: b.fonts }, useProxies: false });
  }, capOut);
  await page.waitForFunction((id) => window.__kurgu.store.useStore.getState().jobs[id]?.done, capJob.jobId, { timeout: 300000 });
  const capState = await page.evaluate((id) => window.__kurgu.store.useStore.getState().jobs[id], capJob.jobId);
  check('Altyazılı export tamamlandı', !capState.error && existsSync(capOut), capState.error ?? '');
  if (existsSync(capOut)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '1.0', '-i', capOut, '-frames:v', '1', join(outDir, '13-altyazili-export-karesi.png')]);
}

// ---- titles
{
  await page.evaluate(() => window.__kurgu.store.setPlayhead(150));
  const clipId = await page.evaluate(() => window.__kurgu.titles.createTitle('kanca'));
  await page.waitForTimeout(300);
  const info = await page.evaluate((id) => {
    const st = window.__kurgu.store.useStore.getState();
    const s = window.__kurgu.store.committedSeq(st);
    const c = s.clips[id];
    const m = st.project.media[c.mediaId];
    return { track: s.tracks.find((t) => t.id === c.trackId).name, path: m.path, title: !!m.title, dur: c.duration };
  }, clipId);
  check('Başlık şablonu klip olarak eklendi', info.title && existsSync(info.path) && info.dur === 90 && info.track !== 'V1', JSON.stringify(info).slice(0, 120));
  const mid = await page.evaluate((id) => window.__kurgu.store.committedSeq().clips[id].mediaId, clipId);
  await page.evaluate((m) => window.__kurgu.titles.updateTitle(m, { text: 'İNDİRİM BAŞLADI', color: '#ffd400' }), mid);
  const path2 = await page.evaluate((m) => window.__kurgu.store.useStore.getState().project.media[m].path, mid);
  check('Başlık metni düzenlenince görsel yeniden üretildi', path2 !== info.path && existsSync(path2));
  await page.evaluate((id) => { window.__kurgu.store.selectClips([id]); window.__kurgu.store.useStore.setState({ leftTab: 'fx' }); }, clipId);
  await page.waitForTimeout(500);
  await shot(page, '14-baslik');
  // yellow title pixels in the program monitor
  const yellow = await page.evaluate(() => {
    const c = document.querySelector('.viewer canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, Math.floor(c.height * 0.4)).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 220 && d[i + 1] > 180 && d[i + 2] < 60) n++;
    return n;
  });
  check('Başlık program monitöründe görünüyor', yellow > 300, `${yellow} sarı piksel`);
}

// ---- graphics: layered template, shapes, strokes/shadows, monitor handles
{
  await page.evaluate(() => window.__kurgu.store.setPlayhead(40));
  const cid = await page.evaluate(() => window.__kurgu.titles.createTitle('lower'));
  await page.waitForTimeout(400);
  const g0 = await page.evaluate((id) => { const st = window.__kurgu.store.useStore.getState(); const c = window.__kurgu.store.committedSeq().clips[id]; const m = st.project.media[c.mediaId]; return { n: m.title.layers.length, mid: m.id, path: m.path }; }, cid);
  check('Alt bant şablonu çok katmanlı grafik olarak eklendi', g0.n === 4, JSON.stringify(g0));
  await page.evaluate((id) => { window.__kurgu.store.selectClips([id]); window.__kurgu.store.useStore.setState({ leftTab: 'fx' }); }, cid);
  await page.waitForSelector('.graphics .g-layer');
  await page.click('.graphics .g-add button[title="Elips"]');
  await page.waitForFunction((m) => window.__kurgu.store.useStore.getState().project.media[m].title.layers.length === 5, g0.mid, { timeout: 10000 }).catch(() => {});
  await page.click('.graphics .g-sub:has-text("Konturlar") button');
  await page.click('.graphics .g-sub:has-text("Gölgeler") button');
  await page.waitForTimeout(600);
  const g1 = await page.evaluate((m) => { const mm = window.__kurgu.store.useStore.getState().project.media[m]; const l = mm.title.layers[mm.title.layers.length - 1]; return { n: mm.title.layers.length, kind: l.kind, strokes: l.strokes.length, shadows: l.shadows.length, path: mm.path }; }, g0.mid);
  check('Grafiğe şekil + kontur + gölge eklendi, görsel yenilendi', g1.n === 5 && g1.kind === 'ellipse' && g1.strokes === 1 && g1.shadows === 1 && g1.path !== g0.path && existsSync(g1.path), JSON.stringify(g1));
  // font picker lists bundled fonts
  await page.click('.graphics .g-layer:has-text("Ad Soyad")');
  await page.waitForSelector('.font-current');
  await page.click('.font-current');
  const fonts = await page.$$eval('.font-item', (x) => x.length);
  await page.click('.font-item:has-text("Bebas Neue")').catch(() => {});
  await page.waitForTimeout(500);
  const font = await page.evaluate((m) => window.__kurgu.store.useStore.getState().project.media[m].title.layers.find((l) => l.text === 'Ad Soyad')?.font, g0.mid);
  check('Yazı tipi seçici (gömülü yazı tipleri) çalışıyor', fonts >= 17 && font === 'Bebas Neue', `${fonts} yazı tipi · seçilen ${font}`);
  await shot(page, '14b-grafik-editoru');
  // drag the clip in the program monitor
  const body = await page.$('.xf-overlay .xf-body');
  const bb = await body.boundingBox();
  const x0 = await page.evaluate((id) => window.__kurgu.store.committedSeq().clips[id].transform.posX.value, cid);
  await page.mouse.move(bb.x + 8, bb.y + 8); await page.mouse.down(); await page.mouse.move(bb.x + 60, bb.y + 8, { steps: 4 }); await page.mouse.up();
  const x1 = await page.evaluate((id) => window.__kurgu.store.committedSeq().clips[id].transform.posX.value, cid);
  check('Program monitöründe klibi sürükleyerek taşıma', x1 - x0 > 50, `${x0} → ${x1}`);
  // drag one layer
  const lay = await page.$('.xf-overlay .xf-layer.on');
  if (lay) {
    const lb = await lay.boundingBox();
    const lx0 = await page.evaluate((m) => window.__kurgu.store.useStore.getState().project.media[m].title.layers.find((l) => l.text === 'Ad Soyad').x, g0.mid);
    await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2); await page.mouse.down(); await page.mouse.move(lb.x + lb.width / 2 + 40, lb.y + lb.height / 2, { steps: 4 }); await page.mouse.up();
    await page.waitForTimeout(700);
    const lx1 = await page.evaluate((m) => window.__kurgu.store.useStore.getState().project.media[m].title.layers.find((l) => l.text === 'Ad Soyad').x, g0.mid);
    check('Monitörde tek katmanı sürükleme', lx1 > lx0, `${lx0} → ${lx1}`);
  } else check('Monitörde tek katmanı sürükleme', false, 'katman kutusu yok');
  // in/out animation preset
  await page.selectOption('.graphics .g-row:has-text("Giriş") select', 'up');
  await page.click('.graphics .g-row:has-text("Süre") button:has-text("Uygula")');
  const anim = await page.evaluate((id) => { const t = window.__kurgu.store.committedSeq().clips[id].transform; return { op: t.opacity.keyframes.length, y: t.posY.keyframes.length }; }, cid);
  check('Metin giriş animasyonu anahtar kare olarak eklendi', anim.op >= 2 && anim.y >= 2, JSON.stringify(anim));
  await page.evaluate((id) => { window.__kurgu.store.edit('grafik test sil', (s) => window.__kurgu.ops.deleteClips(s, [id])); window.__kurgu.store.useStore.setState({ selection: [] }); }, cid);
}

// ---- colour
{
  const target = await page.evaluate(() => {
    const k = window.__kurgu.store;
    const s = k.committedSeq();
    const c = Object.values(s.clips).filter((x) => x.stream === 'video' && x.name === 'kamera-1.mp4').sort((a, b) => a.start - b.start)[0];
    k.setPlayhead(c.start + 10);
    k.selectClips([c.id]);
    k.useStore.setState({ leftTab: 'color' });
    return c.id;
  });
  await page.waitForSelector('text=Temel düzeltme');
  await page.evaluate((id) => window.__kurgu.store.edit('test grade', (s) => {
    s.clips[id].color = { ...window.__kurgu.colorcore.neutralGrade(), look: 'siyah-beyaz', exposure: 0.3 };
  }), target);
  await page.waitForTimeout(700);
  await shot(page, '15-renk-paneli');
  const grey = await page.evaluate(() => {
    const c = document.querySelector('.viewer canvas');
    const d = c.getContext('2d').getImageData(0, Math.floor(c.height * 0.1), c.width, Math.floor(c.height * 0.3)).data;
    let colourful = 0, n = 0;
    for (let i = 0; i < d.length; i += 16) { n++; if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 30) colourful++; }
    return colourful / n;
  });
  check('Renk düzeltme önizlemede GPU ile uygulanıyor (siyah-beyaz)', grey < 0.05, `renkli piksel oranı ${grey.toFixed(3)}`);
  // export just that clip's range and verify the graded colours
  const gOut = join(outDir, 'renk-export.mp4');
  const gJob = await page.evaluate(async ([out, id]) => {
    const k = window.__kurgu.store;
    const st = k.useStore.getState();
    const s = k.committedSeq(st);
    const c = s.clips[id];
    const p = { ...st.project, sequences: { ...st.project.sequences, [s.id]: { ...s, inPoint: c.start, outPoint: c.start + 20 } } };
    return window.kurgu.exportSequence({ project: p, sequenceId: s.id, settings: { output: out, container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', rateControl: 'quality', quality: 20, videoBitrateKbps: 8000, audioBitrateKbps: 128, range: 'inout', hardware: 'none', preset: 'ultrafast' }, useProxies: false });
  }, [gOut, target]);
  await page.waitForFunction((id) => window.__kurgu.store.useStore.getState().jobs[id]?.done, gJob.jobId, { timeout: 300000 });
  if (existsSync(gOut)) {
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', '0.2', '-i', gOut, '-frames:v', '1', '-vf', 'crop=iw:ih*0.3:0:ih*0.1,scale=160:-2', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    let colourful = 0, n = 0;
    for (let i = 0; i < raw.length; i += 3) { n++; if (Math.max(raw[i], raw[i + 1], raw[i + 2]) - Math.min(raw[i], raw[i + 1], raw[i + 2]) > 30) colourful++; }
    check('Renk düzeltme export\'a aynen yansıdı', colourful / n < 0.05, `renkli piksel oranı ${(colourful / n).toFixed(3)}`);
  } else check('Renk düzeltme export\'a aynen yansıdı', false, 'dosya yok');
  await page.evaluate((id) => window.__kurgu.store.edit('undo grade', (s) => { delete s.clips[id].color; }), target);
}

// ---- effects & transitions
{
  await page.evaluate(() => window.__kurgu.store.useStore.setState({ leftTab: 'effects', selection: [], toasts: [] }));
  await page.waitForSelector('.fx-item');
  const counts = await page.evaluate(() => ({ items: document.querySelectorAll('.fx-item').length }));
  check('Efekt kütüphanesi dolu (30+ geçiş, 20+ efekt)', counts.items >= 50, `${counts.items} öğe`);
  await shot(page, '16-efektler-kutuphanesi');
  // drag "Çapraz geçiş" onto the first cut of V1
  const cut = await page.evaluate(() => {
    const s = window.__kurgu.store.committedSeq();
    const v1 = s.tracks.find((t) => t.name === 'V1').id;
    const cs = Object.values(s.clips).filter((c) => c.trackId === v1).sort((a, b) => a.start - b.start);
    return { frame: cs[1].start, id: cs[1].id };
  });
  async function dragFx(selector, frame, laneIndex) {
    const item = await page.$(selector);
    const lanes = await page.$$('.lane');
    const lb = await lanes[laneIndex].boundingBox();
    const zoom = await page.evaluate(() => window.__kurgu.store.useStore.getState().zoom);
    const sl = await page.evaluate(() => document.querySelector('.tl-scroll').scrollLeft);
    const x = lb.x + frame * zoom, y = lb.y + lb.height / 2; // the lane box already moves with the scroll
    void sl;
    const dt = await page.evaluateHandle(() => new DataTransfer());
    await item.dispatchEvent('dragstart', { dataTransfer: dt });
    const target = await page.$('.tl-scroll');
    await target.dispatchEvent('dragover', { dataTransfer: dt, clientX: x, clientY: y });
    await target.dispatchEvent('drop', { dataTransfer: dt, clientX: x, clientY: y });
  }
  await page.evaluate(() => { const el = document.querySelector('.tl-scroll'); el.scrollLeft = 0; });
  const lanesNow = await page.$$eval('.lane', (ls) => ls.length);
  const v1Index = await page.evaluate(() => { const s = window.__kurgu.store.committedSeq(); const vids = s.tracks.filter((t) => t.kind === 'video'); return vids.length - 1 - vids.findIndex((t) => t.name === 'V1'); });
  await dragFx('.fx-item:has-text("Çapraz geçiş")', cut.frame, v1Index);
  await page.waitForTimeout(200);
  const tr = await page.evaluate((id) => window.__kurgu.store.committedSeq().clips[id].transIn, cut.id);
  check('Geçiş sürükle-bırak ile kesime eklendi', tr && tr.type === 'cross' && tr.duration === 30, JSON.stringify(tr) + ` (lanes ${lanesNow})`);
  const blocks = await page.$$eval('.trans-block', (b) => b.length);
  check('Geçiş timeline\'da görünüyor', blocks >= 1, `${blocks} blok`);
  // effect on the clip after the cut
  await page.evaluate(() => window.__kurgu.store.useStore.setState({ leftTab: 'effects' }));
  await page.waitForSelector('.fx-item');
  await dragFx('.fx-item:has-text("Siyah beyaz")', cut.frame + 40, v1Index);
  await page.waitForTimeout(200);
  const fx = await page.evaluate((id) => (window.__kurgu.store.committedSeq().clips[id].effects ?? []).map((e) => e.type), cut.id);
  check('Efekt sürükle-bırak ile klibe eklendi', fx.includes('bw'), JSON.stringify(fx));
  // preview mid-transition is a mix, then black-and-white after it
  await page.evaluate((f) => window.__kurgu.store.setPlayhead(f + 60), cut.frame);
  await page.waitForTimeout(900);
  const sat = await page.evaluate(() => {
    const c = document.querySelector('.viewer canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let col = 0, n = 0;
    for (let i = 0; i < d.length; i += 40) { n++; if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 30) col++; }
    return col / n;
  });
  check('Siyah-beyaz efekti önizlemede uygulanıyor', sat < 0.05, `renkli oran ${sat.toFixed(3)}`);
  await page.evaluate((f) => window.__kurgu.store.setPlayhead(f), cut.frame);
  await page.waitForTimeout(900);
  await page.evaluate((id) => window.__kurgu.store.useStore.setState({ selection: [id], leftTab: 'fx' }), cut.id);
  await page.waitForTimeout(300);
  await shot(page, '17-gecis-ve-efekt');
  // Ctrl+D somewhere else
  const before = await page.evaluate(() => Object.values(window.__kurgu.store.committedSeq().clips).filter((c) => c.transIn).length);
  await page.evaluate(() => { const k = window.__kurgu.store; k.useStore.setState({ selection: [] }); const s = k.committedSeq(); const v1 = s.tracks.find((t) => t.name === 'V1').id; const cs = Object.values(s.clips).filter((c) => c.trackId === v1).sort((a, b) => a.start - b.start); k.setPlayhead(cs[2].start + 2); });
  await page.click('.tl-scroll', { position: { x: 5, y: 120 } });
  await page.keyboard.press('Control+d');
  const after = await page.evaluate(() => Object.values(window.__kurgu.store.committedSeq().clips).filter((c) => c.transIn).length);
  check('Ctrl+D varsayılan geçiş ekledi', after === before + 1, `${before} → ${after}`);
  // closing transition: drop "Siyaha geçiş" on the END of the last V1 clip
  const tail = await page.evaluate(() => {
    const s = window.__kurgu.store.committedSeq();
    const v1 = s.tracks.find((t) => t.name === 'V1').id;
    const cs = Object.values(s.clips).filter((c) => c.trackId === v1).sort((a, b) => a.start - b.start);
    const last = cs[cs.length - 1];
    return { id: last.id, end: last.start + last.duration };
  });
  await page.evaluate(() => window.__kurgu.store.useStore.setState({ leftTab: 'effects' }));
  await page.waitForSelector('.fx-item');
  await page.evaluate((f) => { const z = window.__kurgu.store.useStore.getState().zoom; document.querySelector('.tl-scroll').scrollLeft = Math.max(0, f * z - 300); }, tail.end);
  await dragFx('.fx-item:has-text("Siyaha geçiş")', tail.end - 3, v1Index);
  await page.waitForTimeout(200);
  const tout = await page.evaluate((id) => window.__kurgu.store.committedSeq().clips[id].transOut, tail.id);
  const dbg = await page.evaluate(() => { const s = window.__kurgu.store.committedSeq(); return JSON.stringify({ toasts: window.__kurgu.store.useStore.getState().toasts?.map((t) => t.text), clips: Object.values(s.clips).filter((c) => c.transIn || c.transOut).map((c) => [c.name, c.start, c.duration, c.transIn?.type, c.transOut?.type]) }); });
  check('Klibin SONUNA kapanış geçişi bırakılabiliyor', tout && tout.type === 'black', JSON.stringify(tout) + ' ' + dbg + ' ' + JSON.stringify(tail));
  const tailBlock = await page.$$eval('.trans-block.tail', (b) => b.length);
  check('Kapanış geçişi timeline\'da görünüyor', tailBlock >= 1, `${tailBlock}`);
  const lum = async (f) => {
    await page.evaluate((x) => window.__kurgu.store.setPlayhead(x), f);
    await page.waitForTimeout(900);
    return page.evaluate(() => {
      const c = document.querySelector('.viewer canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let t = 0, n = 0;
      for (let i = 0; i < d.length; i += 40) { t += d[i] + d[i + 1] + d[i + 2]; n++; }
      return t / n / 3;
    });
  };
  const lBefore = await lum(tail.end - 40), lEnd = await lum(tail.end - 2);
  check('Kapanış geçişi önizlemede kararıyor', lEnd < lBefore * 0.5 || lEnd < 20, `${lBefore.toFixed(1)} → ${lEnd.toFixed(1)}`);
  await page.evaluate((id) => window.__kurgu.store.useStore.setState({ selection: [id], leftTab: 'fx' }), tail.id);
  await page.waitForTimeout(300);
  const hasTailCtl = await page.$$eval('.fx-group .gh', (g) => g.some((x) => x.textContent.includes('Kapanış geçişi')));
  check('Efekt Kontrolleri kapanış geçişini gösteriyor', hasTailCtl);
  await shot(page, '17b-kapanis-gecisi');
  // Ctrl+Shift+D: audio fade/crossfade at the playhead
  const aBefore = await page.evaluate(() => Object.values(window.__kurgu.store.committedSeq().clips).filter((c) => c.stream === 'audio' && (c.transIn || c.transOut)).length);
  await page.evaluate(() => window.__kurgu.store.useStore.setState({ selection: [] }));
  await page.click('.tl-scroll', { position: { x: 5, y: 120 } });
  await page.evaluate(() => window.__kurgu.store.useStore.setState({ selection: [] }));
  await page.keyboard.press('Control+Shift+d');
  const aAfter = await page.evaluate(() => Object.values(window.__kurgu.store.committedSeq().clips).filter((c) => c.stream === 'audio' && (c.transIn || c.transOut)).length);
  check('Ctrl+Shift+D ses geçişi ekledi', aAfter === aBefore + 1, `${aBefore} → ${aAfter}`);
  // impact transition: turn the Ctrl+D cut into a spin and remember what the preview shows mid-way
  globalThis.__impact = await page.evaluate(async () => {
    const k = window.__kurgu.store;
    const s = k.committedSeq();
    const v1 = s.tracks.find((t) => t.name === 'V1').id;
    const cs = Object.values(s.clips).filter((c) => c.trackId === v1).sort((a, b) => a.start - b.start);
    const B = cs[2];
    k.edit('impact', (q) => { q.clips[B.id].transIn = { type: 'imp-spin', duration: 24 }; });
    const f = B.start - 12 + 9;
    k.setPlayhead(f);
    await new Promise((r) => setTimeout(r, 1200));
    k.setPlayhead(f);
    await new Promise((r) => setTimeout(r, 600));
    const c = document.querySelector('.viewer canvas');
    const t = document.createElement('canvas'); t.width = 16; t.height = 9;
    t.getContext('2d').drawImage(c, 0, 0, 16, 9);
    return { frame: f, fps: s.fps, px: Array.from(t.getContext('2d').getImageData(0, 0, 16, 9).data) };
  });
  await shot(page, '17c-impact-spin');
  // a few more effects for the export test
  await page.evaluate((id) => {
    const k = window.__kurgu.store;
    const s = k.committedSeq();
    const v2 = Object.values(s.clips).find((c) => c.name === 'logo.png');
    k.edit('fx test', (q) => {
      q.clips[v2.id].effects = [{ id: 'g', type: 'glitch', enabled: true, params: { amount: 60 } }, { id: 's', type: 'shake', enabled: true, params: { amount: 1, speed: 1 } }];
    });
  }, cut.id);
}

// ---- context menus, frame hold, paste attributes, keyframe interpolation
{
  await page.evaluate(() => window.__kurgu.store.useStore.setState({ leftTab: 'fx' }));
  const info = await page.evaluate(() => {
    const k = window.__kurgu.store; const s = k.committedSeq();
    const v1 = s.tracks.find((t) => t.name === 'V1').id;
    const cs = Object.values(s.clips).filter((c) => c.trackId === v1).sort((a, b) => a.start - b.start);
    const withFx = cs.find((c) => (c.effects ?? []).length);
    const other = cs.find((c) => !(c.effects ?? []).length && c.freeze === undefined);
    k.setPlayhead(cs[0].start + 10);
    return { first: cs[0].id, withFx: withFx?.id, other: other?.id, nBefore: Object.keys(s.clips).length };
  });
  await page.evaluate(() => { document.querySelector('.tl-scroll').scrollLeft = 0; });
  await page.waitForTimeout(200);
  const el = await page.$(`.clip.video >> nth=0`);
  const box = await el.boundingBox();
  await page.mouse.click(box.x + Math.min(40, box.width / 2), box.y + box.height / 2, { button: 'right' });
  await page.waitForSelector('.ctx-menu');
  const labels = await page.$$eval('.ctx-menu .ctx-label', (x) => x.map((y) => y.textContent));
  check('Klipte sağ tık menüsü açılıyor', labels.includes('Kare Dondurma Ekle') && labels.includes('Özellikleri Yapıştır…'), labels.slice(0, 6).join(' | '));
  await shot(page, '19-sag-tik-menusu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  check('Esc menüyü kapatıyor', !(await page.$('.ctx-menu')));
  // frame hold from the menu
  const target = await page.evaluate(() => { const k = window.__kurgu.store; const s = k.committedSeq(); const c = Object.values(s.clips).filter((x) => x.stream === 'video' && x.freeze === undefined).sort((a, b) => a.start - b.start)[0]; k.selectClips([c.id]); k.setPlayhead(c.start + 10); return c.id; });
  await page.mouse.click(box.x + Math.min(40, box.width / 2), box.y + box.height / 2, { button: 'right' });
  await page.click('.ctx-menu .ctx-item:has-text("Kare Dondurma Ekle")');
  const held = await page.evaluate(() => Object.values(window.__kurgu.store.committedSeq().clips).filter((c) => c.freeze !== undefined).length);
  check('Kare dondurma eklendi', held >= 1, `${held} donmuş klip (${target})`);
  await page.keyboard.press('Control+z');
  // paste attributes
  if (info.withFx && info.other) {
    await page.evaluate((id) => window.__kurgu.store.selectClips([id], false), info.withFx);
    await page.click('.tl-scroll', { position: { x: 5, y: 120 } });
    await page.evaluate((id) => window.__kurgu.store.selectClips([id], false), info.withFx);
    await page.keyboard.press('Control+c');
    await page.evaluate((id) => window.__kurgu.store.selectClips([id], false), info.other);
    await page.keyboard.press('Control+Alt+v');
    await page.waitForSelector('.modal:has-text("Özellikleri Yapıştır")');
    await page.click('.modal button:has-text("Yapıştır")');
    const fx = await page.evaluate((id) => (window.__kurgu.store.committedSeq().clips[id].effects ?? []).map((e) => e.type), info.other);
    check('Özellikleri yapıştır efektleri taşıdı', fx.length > 0, JSON.stringify(fx));
  }
  // keyframe lane + interpolation menu
  await page.evaluate((id) => { const k = window.__kurgu.store; k.selectClips([id], false); const c = k.committedSeq().clips[id]; k.setPlayhead(c.start + 2); k.useStore.setState({ leftTab: 'fx' }); }, info.first);
  await page.waitForTimeout(200);
  await page.click('.fx-row:has-text("Ölçek") .stopwatch');
  await page.evaluate((id) => { const c = window.__kurgu.store.committedSeq().clips[id]; window.__kurgu.store.setPlayhead(c.start + 20); }, info.first);
  await page.waitForTimeout(150);
  await page.click('.fx-row:has-text("Ölçek") button[title="Anahtar kare ekle/sil"]');
  await page.waitForSelector('.key-lane .key-dot');
  const dots = await page.$$('.key-lane .key-dot');
  await dots[0].click({ button: 'right' });
  await page.click('.ctx-menu .ctx-item:has-text("Yumuşak")');
  const eases = await page.evaluate((id) => window.__kurgu.store.committedSeq().clips[id].transform.scale.keyframes.map((x) => x.ease), info.first);
  check('Anahtar kare şeridi + ara değer menüsü', dots.length === 2 && eases[0] === 'ease', JSON.stringify(eases));
  await shot(page, '20-anahtar-kare-seridi');
}

// ---- speed ramp preset
{
  const id = await page.evaluate(() => { const k = window.__kurgu.store; const s = k.committedSeq(); const st = k.useStore.getState(); const c = Object.values(s.clips).filter((x) => x.stream === 'video' && st.project.media[x.mediaId]?.kind === 'video' && x.speed > 0 && x.freeze === undefined).sort((a, b) => b.duration - a.duration)[0]; k.selectClips([c.id], false); k.setPlayhead(c.start + 3); k.useStore.setState({ leftTab: 'fx' }); return c.id; });
  await page.waitForSelector('.ramp-presets button:has-text("Hızlı–yavaş–hızlı")');
  await page.click('.ramp-presets button:has-text("Hızlı–yavaş–hızlı")');
  const rk = await page.evaluate((cid) => window.__kurgu.store.committedSeq().clips[cid].remap?.keyframes.length ?? 0, id);
  const badge = await page.$$eval('.clip .speed', (x) => x.some((y) => y.textContent.includes('rampa')));
  check('Hız rampası hazır ayarla uygulandı', rk === 5 && badge, `${rk} anahtar kare`);
  await shot(page, '27-hiz-rampasi');
}

// ---- adjustment layer + blend mode
{
  await page.evaluate(() => { const k = window.__kurgu.store; k.setPlayhead(40); k.useStore.setState({ leftTab: 'project' }); });
  await page.waitForSelector('select[title="Yeni öğe"]');
  await page.selectOption('select[title="Yeni öğe"]', 'adjustment');
  await page.waitForFunction(() => Object.values(window.__kurgu.store.useStore.getState().project.media).some((m) => m.synthetic?.type === 'adjustment'));
  const adj = await page.evaluate(() => { const k = window.__kurgu.store; const id = k.useStore.getState().selection[0]; k.edit('bw', (s) => { s.clips[id].effects = [{ id: 'x', type: 'bw', enabled: true, params: { amount: 100 } }]; }); return id; });
  await page.evaluate(() => window.__kurgu.store.setPlayhead(60));
  await page.waitForTimeout(900);
  const colorful = await page.evaluate(() => {
    const c = document.querySelector('.viewer canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let col = 0, n = 0;
    for (let i = 0; i < d.length; i += 40) { n++; if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 30) col++; }
    return col / n;
  });
  check('Ayar katmanı alttaki her şeyi etkiliyor (önizleme)', colorful < 0.05, `renkli oran ${colorful.toFixed(3)}`);
  await shot(page, '23-ayar-katmani');
  await page.evaluate((id) => window.__kurgu.store.edit('sil', (s) => { delete s.clips[id]; }), adj);
  // blend mode select in Effect Controls
  await page.evaluate(() => { const k = window.__kurgu.store; const s = k.committedSeq(); const c = Object.values(s.clips).find((x) => x.name === 'logo.png'); k.selectClips([c.id], false); k.setPlayhead(c.start + 10); k.useStore.setState({ leftTab: 'fx' }); });
  await page.waitForSelector('.fx-row:has-text("Karışım modu") select');
  await page.selectOption('.fx-row:has-text("Karışım modu") select', 'screen');
  const bm = await page.evaluate(() => Object.values(window.__kurgu.store.committedSeq().clips).find((x) => x.name === 'logo.png').blend);
  check('Karışım modu seçilebiliyor', bm === 'screen', String(bm));
  // mask: ellipse on the logo clip, overlay on the monitor, preview cut outside, export uses the same image
  await page.selectOption('.fx-row:has-text("Karışım modu") select', 'normal');
  await page.click('.mask-add button:has-text("Elips")');
  await page.waitForSelector('.mask-overlay .mask-handle');
  const nh = await page.$$eval('.mask-overlay .mask-handle', (x) => x.length);
  // drag a corner handle outwards
  const h0 = await page.$('.mask-overlay .mask-handle >> nth=2');
  const hb = await h0.boundingBox();
  await page.mouse.move(hb.x + 5, hb.y + 5); await page.mouse.down(); await page.mouse.move(hb.x + 25, hb.y + 15, { steps: 4 }); await page.mouse.up();
  const pts = await page.evaluate(() => Object.values(window.__kurgu.store.committedSeq().clips).find((x) => x.name === 'logo.png').masks[0].pts);
  check('Maske monitörde tutamaçla düzenleniyor', nh === 8 && pts[1][0] > 0.22, `${nh} tutamaç · ${JSON.stringify(pts)}`);
  await page.waitForFunction(() => !!Object.values(window.__kurgu.store.committedSeq().clips).find((x) => x.name === 'logo.png').maskImage, null, { timeout: 10000 });
  check('Maske görüntüsü dışa aktarım için hazırlandı', true);
  await shot(page, '24-maske');
  await page.evaluate(() => window.__kurgu.store.useStore.setState({ selMask: null }));

}

// ---- Warp Stabilizer (background analysis + render)
{
  const cid = await page.evaluate(() => {
    const k = window.__kurgu.store; const s = k.committedSeq();
    const c = Object.values(s.clips).filter((x) => x.stream === 'video' && k.useStore.getState().project.media[x.mediaId]?.kind === 'video' && x.freeze === undefined).sort((a, b) => b.duration - a.duration)[0];
    k.selectClips([c.id], false); k.setPlayhead(c.start + 5);
    k.useStore.setState({ leftTab: 'effects' });
    return c.id;
  });
  await page.waitForSelector('.fx-item:has-text("Warp Stabilizer")');
  await page.dblclick('.fx-item:has-text("Warp Stabilizer")');
  await page.waitForSelector('.stab-badge', { timeout: 5000 });
  const sawBanner = await page.waitForSelector('.stab-banner', { timeout: 5000 }).then(() => true).catch(() => false);
  await shot(page, '21-warp-analiz');
  const t0 = Date.now();
  await page.waitForFunction((id) => !!window.__kurgu.store.committedSeq().clips[id]?.stab, cid, { timeout: 240000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  await page.waitForTimeout(800);
  const status = await page.$eval('.stab-status', (x) => x.textContent).catch(() => '');
  check('Warp Stabilizer arka planda analiz edip uyguladı', status.includes('Sabitlendi') && sawBanner, `${secs} sn · ${status}`);
  // changing smoothness re-renders without re-analysing (fast) and keeps working
  await page.evaluate((id) => window.__kurgu.store.edit('pürüzsüzlük', (s) => { s.clips[id].effects.find((e) => e.type === 'warpstab').params.smooth = 80; }), cid);
  const t1 = Date.now();
  await page.waitForFunction((id) => { const c = window.__kurgu.store.committedSeq().clips[id]; return c.stab && c.stab.key.includes('|80|'); }, cid, { timeout: 240000 });
  check('Ayar değişince yeniden analiz etmeden günceller', true, `${((Date.now() - t1) / 1000).toFixed(1)} sn`);
  await shot(page, '22-warp-hazir');
}

// ---- audio mixer, ducking, voice-over
{
  await page.click('.panel-tabs .tab:has-text("Mikser")');
  await page.waitForSelector('.mix-strip');
  const nStrips = await page.$$eval('.mix-strip:not(.master)', (x) => x.length);
  const nAud = await page.evaluate(() => window.__kurgu.store.committedSeq().tracks.filter((t) => t.kind === 'audio').length);
  check('Ses mikseri her ses kanalı için şerit gösteriyor', nStrips === nAud, `${nStrips}/${nAud}`);
  const db = await page.$('.mix-strip[data-track="A2"] .mix-db');
  await db.click(); await page.keyboard.press('Control+a'); await page.keyboard.type('-6'); await page.keyboard.press('Enter');
  const a2 = await page.evaluate(() => window.__kurgu.store.committedSeq().tracks.find((t) => t.name === 'A2').volumeDb);
  check('Mikser kanal seviyesi değişiyor', a2 === -6, String(a2));
  // ducking: music (A2) under speech (A1)
  const duck = await page.evaluate(async () => {
    const k = window.__kurgu.store;
    const s = k.committedSeq();
    const A1 = s.tracks.find((t) => t.name === 'A1').id, A2 = s.tracks.find((t) => t.name === 'A2').id;
    const st = k.useStore.getState();
    for (const m of Object.values(st.project.media)) if (!st.assets[m.path]?.peaks) await k.loadAssets(m);
    return { a2: A2, a1: A1 };
  });
  await page.selectOption('.mix-card:has-text("otomatik kıs") select', duck.a2);
  await page.click('.mix-card button:has-text("Uygula")');
  await page.waitForTimeout(200);
  const kf = await page.evaluate((a2) => Object.values(window.__kurgu.store.committedSeq().clips).filter((c) => c.trackId === a2).map((c) => c.volumeDb.keyframes.length), duck.a2);
  check('Otomatik ses kısma müziğe anahtar kare yazdı', kf.some((n) => n >= 3), JSON.stringify(kf));
  // loudness: measure the sequence, match a clip to −14 LUFS
  await page.click('.mix-card button:has-text("Sekansı ölç")');
  await page.waitForSelector('.lufs-hint:has-text("Sekans:")', { timeout: 120000 });
  const lufs = await page.$eval('.lufs-hint:has-text("Sekans:")', (x) => x.textContent);
  const music = await page.evaluate(() => { const k = window.__kurgu.store; const s = k.committedSeq(); const a2 = s.tracks.find((t) => t.name === 'A2').id; const c = Object.values(s.clips).find((x) => x.trackId === a2); k.selectClips([c.id], false); return { id: c.id, v: c.volumeDb.value }; });
  await page.click('.mix-card button:has-text("Seçili klipleri hedefe eşle")');
  await page.waitForFunction((m) => window.__kurgu.store.committedSeq().clips[m.id].volumeDb.value !== m.v, music, { timeout: 60000 });
  const matched = await page.evaluate((id) => window.__kurgu.store.committedSeq().clips[id].volumeDb.value, music.id);
  check('LUFS: sekans ölçüldü ve klip hedefe eşlendi', /-?\d+\.\d LUFS/.test(lufs), `${lufs} · müzik ${music.v} → ${matched} dB`);
  // rubber band on the music clip: drag down, Ctrl+click adds a key
  await page.evaluate(() => { document.querySelector('.tl-scroll').scrollLeft = 0; });
  const sig = (id) => page.evaluate((cid) => { const p = window.__kurgu.store.committedSeq().clips[cid].volumeDb; return { v: p.value, n: p.keyframes.length, sum: p.keyframes.reduce((a, k) => a + k.value, 0) }; }, id);
  const name = await page.evaluate((id) => window.__kurgu.store.committedSeq().clips[id].name, music.id);
  let mEl = null;
  for (const el of await page.$$('.lane.kind-audio .clip')) { const t = await el.getAttribute('title'); if (t && t.startsWith(name)) mEl = el; }
  if (mEl) {
    const s0 = await sig(music.id);
    const lb = await (await mEl.$('.rubber-hit')).boundingBox();
    const x = lb.x + Math.min(40, lb.width / 4);
    // y of the line at x: probe around the hit path's bbox
    const y = await page.evaluate(([px, top, h]) => { for (let yy = top; yy <= top + h; yy++) { const el = document.elementFromPoint(px, yy); if (el && el.classList.contains('rubber-hit')) return yy; } return top + h / 2; }, [x, lb.y, lb.height]);
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, y + 12, { steps: 3 }); await page.mouse.up();
    const s1 = await sig(music.id);
    await page.keyboard.down('Control'); await page.mouse.click(x + 25, y + 12); await page.keyboard.up('Control');
    const s2 = await sig(music.id);
    check('Ses çizgisi (rubber band) sürüklenip anahtar kare eklenebiliyor', (s1.v < s0.v || s1.sum < s0.sum) && s2.n === s1.n + 1, `${JSON.stringify(s0)} → ${JSON.stringify(s1)} → ${s2.n} anahtar`);
  } else check('Ses çizgisi (rubber band) sürüklenip anahtar kare eklenebiliyor', false, 'klip bulunamadı');
  await shot(page, '18-ses-mikseri');
  // voice-over from the (fake) microphone
  const before = await page.evaluate(() => Object.keys(window.__kurgu.store.committedSeq().clips).length);
  await page.evaluate(() => window.__kurgu.store.setPlayhead(30));
  await page.click('.mix-card button:has-text("Kaydı başlat")');
  await page.waitForSelector('.mix-card button:has-text("Durdur")', { timeout: 10000 });
  await page.waitForTimeout(1600);
  await page.click('.mix-card button:has-text("Durdur")');
  await page.waitForSelector('.mix-card button:has-text("Kaydı başlat")', { timeout: 20000 });
  const vo = await page.evaluate(() => {
    const k = window.__kurgu.store; const st = k.useStore.getState(); const s = k.committedSeq();
    const c = Object.values(s.clips).find((x) => st.project.media[x.mediaId]?.path.includes('seslendirme'));
    return c ? { start: c.start, dur: c.duration, path: st.project.media[c.mediaId].path } : null;
  });
  const after = await page.evaluate(() => Object.keys(window.__kurgu.store.committedSeq().clips).length);
  check('Mikrofonla seslendirme kaydı timeline\'a eklendi', !!vo && vo.start === 30 && vo.dur > 20 && after === before + 1, JSON.stringify(vo));
}

// ---- export through the real worker
await page.click('.modes button:has-text("Dışa Aktar")');
await page.waitForTimeout(500);
await shot(page, '08-disa-aktar');
const outFile = join(outDir, 'kurgu-export.mp4');
const job = await page.evaluate(async (out) => {
  const st = window.__kurgu.store.useStore.getState();
  const s = window.__kurgu.store.committedSeq(st);
  return window.kurgu.exportSequence({ project: st.project, sequenceId: s.id, settings: { output: out, container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', rateControl: 'quality', quality: 23, videoBitrateKbps: 8000, audioBitrateKbps: 192, range: 'all', hardware: 'none', preset: 'veryfast', loudnessTarget: -14 }, useProxies: false });
}, outFile);
await page.waitForFunction((id) => window.__kurgu.store.useStore.getState().jobs[id]?.done, job.jobId, { timeout: 300000 });
const jobState = await page.evaluate((id) => window.__kurgu.store.useStore.getState().jobs[id], job.jobId);
await shot(page, '09-disa-aktarma-bitti');
check('Dışa aktarma tamamlandı', !jobState.error && existsSync(outFile), jobState.error ?? '');
if (existsSync(outFile)) {
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', outFile]).toString());
  const expected = await page.evaluate(() => { const s = window.__kurgu.store.committedSeq(); return Math.max(...Object.values(s.clips).map((c) => c.start + c.duration)) / s.fps; });
  check('Export süresi sekansla aynı', Math.abs(Number(info.format.duration) - expected) < 0.15, `${info.format.duration} vs ${expected.toFixed(3)}`);
  check('Export 1920×1080 + ses', info.streams.some((x) => x.codec_type === 'video' && x.width === 1920) && info.streams.some((x) => x.codec_type === 'audio'));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '2', '-i', outFile, '-frames:v', '1', join(outDir, '10-export-karesi.png')]);
  const im = globalThis.__impact;
  if (im) {
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String((im.frame + 0.25) / im.fps), '-i', outFile, '-frames:v', '1', '-vf', 'scale=16:9:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    let diff = 0, n = 0;
    for (let i = 0, j = 0; i < raw.length; i += 3, j += 4) { for (let c = 0; c < 3; c++) diff += Math.abs(raw[i + c] - im.px[j + c]); n += 3; }
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String((im.frame + 0.25) / im.fps), '-i', outFile, '-frames:v', '1', '-vf', 'scale=640:-2', join(outDir, '17d-impact-export.png')]);
    check('Impact geçişi: önizleme = dışa aktarım', diff / n < 35, `ortalama fark ${(diff / n).toFixed(1)}`);
  }
}

// ---- text-based editing (transcript injected: speech recognition needs the model download)
{
  const before = await page.evaluate(() => {
    const k = window.__kurgu.store;
    const words = 'Merhaba arkadaşlar ııı bugün size yeni editörümüzü eee anlatacağım çok hızlı ve ücretsiz'.split(' ');
    k.edit('test transkript', (s) => {
      let f = 15;
      s.transcript = { language: 'tr', words: words.map((t, i) => { const w = { text: t, start: f, end: f + 12 }; f += i === 4 ? 70 : 16; return w; }) };
    });
    k.useStore.setState({ leftTab: 'text', mode: 'edit' });
    const s = k.committedSeq();
    return Math.max(...Object.values(s.clips).map((c) => c.start + c.duration));
  });
  await page.waitForSelector('.tr-w');
  const nWords = await page.$$eval('.tr-w', (x) => x.length);
  // select "yeni editörümüzü" by dragging and press Delete
  const w1 = await page.$('.tr-w[data-w="6"]'), w2 = await page.$('.tr-w[data-w="7"]');
  const b1 = await w1.boundingBox(), b2 = await w2.boundingBox();
  await page.mouse.move(b1.x + 3, b1.y + 5); await page.mouse.down(); await page.mouse.move(b2.x + 5, b2.y + 5, { steps: 3 }); await page.mouse.up();
  const selTxt = await page.$eval('.tr-sel', (x) => x.textContent).catch(() => '');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);
  const after1 = await page.evaluate(() => { const s = window.__kurgu.store.committedSeq(); return { end: Math.max(...Object.values(s.clips).map((c) => c.start + c.duration)), words: s.transcript.words.map((w) => w.text).join(' ') }; });
  check('Metinden kelime silmek videoyu da kesiyor', nWords === 13 && selTxt.includes('2 kelime') && after1.end < before && !after1.words.includes('editörümüzü'), `${before} → ${after1.end} · ${after1.words}`);
  // fillers
  await page.click('.tr-bar button:has-text("Dolgu sesleri")');
  await page.waitForSelector('.tr-w.filler');
  await shot(page, '25-metinle-kurgu');
  await page.click('.tr-tool button:has-text("Kaldır")');
  const after2 = await page.evaluate(() => window.__kurgu.store.committedSeq().transcript.words.map((w) => w.text).join(' '));
  check('Dolgu sesleri tek tıkla temizlendi', !/ııı|eee/.test(after2), after2);
  // pauses
  await page.click('.tr-bar button:has-text("Duraklamalar")');
  const info = await page.$eval('.tr-tool-foot span', (x) => x.textContent);
  await page.click('.tr-tool button:has-text("Kaldır")');
  const gaps = await page.evaluate(() => { const w = window.__kurgu.store.committedSeq().transcript.words; let mx = 0; for (let i = 1; i < w.length; i++) mx = Math.max(mx, w[i].start - w[i - 1].end); return mx; });
  check('Uzun duraklamalar kaldırıldı', gaps < 30, `${info} · en uzun boşluk ${gaps} kare`);
}

// ---- auto reframe to 9:16
{
  await page.evaluate(() => window.__kurgu.store.useStore.setState({ mode: 'edit', dialog: { kind: 'reframe' } }));
  await page.waitForSelector('.modal:has-text("Otomatik Yeniden Kadrajla")');
  const srcId = await page.evaluate(() => window.__kurgu.store.committedSeq().id);
  await page.click('.modal button:has-text("Yeni sekans oluştur")');
  await page.waitForFunction((id) => window.__kurgu.store.committedSeq().id !== id, srcId, { timeout: 120000 });
  const rf = await page.evaluate(() => {
    const s = window.__kurgu.store.committedSeq();
    const st = window.__kurgu.store.useStore.getState();
    const v = Object.values(s.clips).filter((c) => c.stream === 'video' && st.project.media[c.mediaId]?.kind === 'video');
    return { w: s.width, h: s.height, name: s.name, scales: v.map((c) => Math.round(c.transform.scale.value)), keyed: v.filter((c) => c.transform.posX.keyframes.length > 1).length, n: v.length };
  });
  check('Otomatik yeniden kadraj 9:16 sekans oluşturdu', rf.w === 1080 && rf.h === 1920 && rf.scales.every((x) => x >= 300), JSON.stringify(rf));
  await page.evaluate(() => window.__kurgu.store.setPlayhead(45));
  await page.waitForTimeout(900);
  await shot(page, '26-otomatik-kadraj-9x16');
}

// ---- multicam
{
  const ids = await page.evaluate(() => {
    const k = window.__kurgu.store; const st = k.useStore.getState();
    const ms = Object.values(st.project.media).filter((m) => m.name.startsWith('kamera-')).map((m) => m.id);
    k.useStore.setState({ mode: 'edit', selectedMedia: ms, dialog: { kind: 'multicam' } });
    k.setPlayhead(k.committedSeq().clips ? Math.max(...Object.values(k.committedSeq().clips).map((c) => c.start + c.duration)) : 0);
    return ms;
  });
  await page.waitForSelector('.modal:has-text("Çoklu Kamera")');
  await page.click('.modal input[type=radio] >> nth=2');
  await page.click('.modal button:has-text("Oluştur")');
  await page.waitForSelector('.mc-grid .mc-cell', { timeout: 20000 });
  const cells = await page.$$eval('.mc-cell', (x) => x.length);
  await page.evaluate(() => { const k = window.__kurgu.store; const c = Object.values(k.committedSeq().clips).find((x) => x.mc && x.stream === 'video'); k.setPlayhead(c.start + 10); });
  await page.waitForTimeout(500);
  await shot(page, '28-coklu-kamera');
  await page.click('.tl-scroll', { position: { x: 5, y: 120 } });
  await page.keyboard.press('2');
  const angle = await page.evaluate(() => Object.values(window.__kurgu.store.committedSeq().clips).find((x) => x.mc && x.stream === 'video').mc.angle);
  check('Çoklu kamera: ızgara ve 1–9 ile açı değiştirme', ids.length === 2 && cells === 2 && angle === 1, `${cells} hücre · açı ${angle}`);
  // live cut while playing
  await page.evaluate(() => window.__kurgu.player.play(1));
  await page.waitForTimeout(700);
  await page.keyboard.press('1');
  await page.evaluate(() => window.__kurgu.player.pause());
  const segs = await page.evaluate(() => Object.values(window.__kurgu.store.committedSeq().clips).filter((x) => x.mc && x.stream === 'video').map((x) => x.mc.angle).sort().join(','));
  check('Oynatırken tuşla canlı kesme', segs === '0,1', segs);
  await page.evaluate(() => window.__kurgu.store.useStore.setState({ multicamView: false }));
}

// ---- nest
{
  const r = await page.evaluate(() => {
    const k = window.__kurgu.store;
    const st = k.useStore.getState();
    // back to the main edit
    const main = Object.values(st.project.sequences).find((s) => s.name === 'Sekans 01');
    k.editProject('aç', (p) => { p.activeSequenceId = main.id; });
    const s = k.committedSeq();
    const v = Object.values(s.clips).filter((c) => c.stream === 'video' && !c.mc).sort((a, b) => a.start - b.start).slice(0, 2);
    k.selectClips(v.map((c) => c.id));
    return { before: Object.keys(s.clips).length, end: Math.max(...Object.values(s.clips).map((c) => c.start + c.duration)) };
  });
  await page.evaluate(() => window.__kurgu.app.runCommand('nest'));
  const after = await page.evaluate(() => { const s = window.__kurgu.store.committedSeq(); const n = Object.values(s.clips).find((c) => c.nest); return { has: !!n, end: Math.max(...Object.values(s.clips).map((c) => c.start + c.duration)), id: n?.id }; });
  await page.waitForTimeout(600);
  const dark = await page.evaluate(() => { const c = document.querySelector('.viewer canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let t = 0; for (let i = 0; i < d.length; i += 40) t += d[i] + d[i + 1] + d[i + 2]; return t / (d.length / 40) / 3; });
  check('İç içe yerleştir: klipler yeni sekansa taşındı, görüntü aynı kaldı', after.has && after.end === r.end && dark > 10, JSON.stringify({ ...after, dark: Math.round(dark) }));
  const clipEl = await page.$(`.clip:has-text("İç içe sekans")`);
  if (clipEl) await clipEl.dblclick();
  const opened = await page.evaluate(() => window.__kurgu.store.committedSeq().name);
  check('İç içe sekans çift tıkla açılıyor', opened.startsWith('İç içe sekans'), opened);
}

// ---- colour curves + HSL secondary
{
  await page.evaluate(() => { const k = window.__kurgu.store; const st = k.useStore.getState(); const main = Object.values(st.project.sequences).find((s) => s.name === 'Sekans 01'); k.editProject('aç', (p) => { p.activeSequenceId = main.id; }); const s = k.committedSeq(); const c = Object.values(s.clips).find((x) => x.stream === 'video' && st.project.media[x.mediaId]?.kind === 'video' && !x.mc && !x.nest); k.selectClips([c.id], false); k.setPlayhead(c.start + 5); k.useStore.setState({ leftTab: 'color', mode: 'edit' }); });
  await page.waitForSelector('.curve-box');
  await (await page.$('.curve-box')).scrollIntoViewIfNeeded();
  const box = await (await page.$('.curve-box')).boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.7); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5, { steps: 4 }); await page.mouse.up();
  const curves = await page.evaluate(() => { const s = window.__kurgu.store.committedSeq(); const id = window.__kurgu.store.useStore.getState().selection[0]; return s.clips[id].color?.curves?.master; });
  check('Renk eğrisi noktası eklendi ve sürüklendi', !!curves && curves.length === 3 && curves[1][1] > 0.4, JSON.stringify(curves));
  await page.click('.btn:has-text("Damlalık")');
  const vb = await (await page.$('.viewer canvas')).boundingBox();
  await page.mouse.click(vb.x + vb.width * 0.5, vb.y + vb.height * 0.5);
  const sec = await page.evaluate(() => { const s = window.__kurgu.store.committedSeq(); const id = window.__kurgu.store.useStore.getState().selection[0]; return s.clips[id].color?.secondary; });
  check('HSL ikincil damlalıkla renk seçti', !!sec && Number.isFinite(sec.hue), JSON.stringify(sec));
  await shot(page, '29-egriler-ikincil');
}

// ---- shortcut editor
{
  await page.evaluate(() => window.__kurgu.store.useStore.setState({ dialog: { kind: 'shortcuts' }, tool: 'select' }));
  await page.waitForSelector('.key-row');
  await page.click('.key-row:has-text("Jilet") .key-cap');
  await page.keyboard.press('g');
  const cap = await page.$eval('.key-row:has-text("Jilet") .key-cap', (x) => x.textContent);
  await page.click('.modal button:has-text("Kapat")');
  await page.click('.tl-scroll', { position: { x: 5, y: 120 } });
  await page.keyboard.press('g');
  const t1 = await page.evaluate(() => window.__kurgu.store.useStore.getState().tool);
  await page.keyboard.press('v');
  await page.keyboard.press('c');
  const t2 = await page.evaluate(() => window.__kurgu.store.useStore.getState().tool);
  check('Kısayol değiştirilebiliyor (Jilet → G)', cap === 'G' && t1 === 'razor' && t2 === 'select', `${cap} · G→${t1} · C→${t2}`);
  await page.evaluate(() => window.__kurgu.store.useStore.setState({ dialog: { kind: 'shortcuts' } }));
  await page.click('.modal button:has-text("Varsayılanlara dön")');
  await page.click('.modal button:has-text("Kapat")');
}

// ---- drop real files from the OS onto the timeline; heavy media get proxies on their own
{
  const big = join(outDir, 'heavy-4k.mp4');
  if (!existsSync(big)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=3840x2160:r=30:d=2', '-f', 'lavfi', '-i', 'sine=f=500:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', big]);
  await page.click('.modes button:has-text("Kurgu")').catch(() => {});
  await page.evaluate(() => { window.__kurgu.store.useStore.setState({ dialog: null, home: false }); document.querySelector('.tl-scroll').scrollLeft = 0; });
  // real File objects (with disk paths) come from a file input, like Explorer/Finder hands them over
  await page.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = '__dropsrc'; i.style.display = 'none'; document.body.appendChild(i); });
  await page.setInputFiles('#__dropsrc', big);
  const before = await page.evaluate(() => Object.keys(window.__kurgu.store.committedSeq().clips).length);
  const lb = await (await page.$$('.lane.kind-video'))[0].boundingBox();
  await page.evaluate(({ x, y }) => {
    const dt = new DataTransfer();
    for (const f of document.getElementById('__dropsrc').files) dt.items.add(f);
    const el = document.elementFromPoint(x, y);
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
  }, { x: lb.x + 30, y: lb.y + lb.height / 2 });
  await page.waitForFunction((n) => Object.keys(window.__kurgu.store.committedSeq().clips).length > n, before, { timeout: 20000 }).catch(() => {});
  const after = await page.evaluate(() => Object.keys(window.__kurgu.store.committedSeq().clips).length);
  check('Explorer/Finder\'dan timeline\'a bırakılan video ekleniyor', after > before, `${before} → ${after} klip`);
  const pinfo = await page.evaluate(async (p) => {
    const st = window.__kurgu.store.useStore.getState();
    const deadline = Date.now() + 60000;
    while (!window.__kurgu.store.useStore.getState().proxies[p] && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
    const s2 = window.__kurgu.store.useStore.getState();
    return { heavy: st.heavy[p], proxy: s2.proxies[p] ?? null };
  }, big);
  check('4K video ağır olarak algılandı ve proxy kendiliğinden yapıldı', pinfo.heavy === true && !!pinfo.proxy && existsSync(pinfo.proxy), JSON.stringify(pinfo));
  if (pinfo.proxy) {
    const h = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', pinfo.proxy]).toString());
    check('Proxy hafif (540p)', h === 540, `${h}p`);
  }
  // Proxy switch: off then on builds proxies for every video
  await page.evaluate(() => window.__kurgu.store.useStore.setState({ useProxies: false }));
  await page.click('label:has-text("Proxy") input');
  const all = await page.evaluate(async () => {
    const deadline = Date.now() + 120000;
    const pending = () => { const st = window.__kurgu.store.useStore.getState(); return Object.values(st.project.media).filter((m) => m.kind === 'video' && !m.synthetic && m.online !== false && !st.proxies[m.path]).length; };
    while (pending() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
    return { pending: pending(), use: window.__kurgu.store.useStore.getState().useProxies };
  });
  check('Proxy düğmesi tüm videolar için proxy hazırlıyor', all.pending === 0 && all.use, JSON.stringify(all));
  // adaptive playback: simulated slow machine → lower preview resolution
  const res = await page.evaluate(() => {
    const k = window.__kurgu;
    k.store.useStore.setState({ playing: true, rate: 1, playbackRes: 1 });
    k.player.fpsMeter.value = 5; k.player.adapted = false; k.player.slowSeconds = 0;
    k.player.watchPerformance(30); k.player.watchPerformance(30);
    const r = k.store.useStore.getState().playbackRes;
    k.store.useStore.setState({ playing: false });
    return r;
  });
  check('Oynatma takılınca önizleme kendiliğinden hafifliyor', res === 0.5, `çözünürlük ${res}`);
}

// ---- crash isolation: kill the worker mid-job and keep editing
const pid = await app.evaluate(async ({ app }) => app.getAppMetrics().find((m) => m.type === 'Utility' && /Kurgu Media Worker|NodeService/.test(m.serviceName ?? m.name ?? ''))?.pid ?? null);
if (pid) {
  process.kill(pid, 'SIGKILL');
  await page.waitForTimeout(1500);
  const alive = await page.evaluate(() => !!document.querySelector('.app .header'));
  const probe = await page.evaluate(async (p) => window.kurgu.probe([p]), files[0]);
  const pid2 = await app.evaluate(async ({ app }) => app.getAppMetrics().find((m) => m.type === 'Utility' && /Kurgu Media Worker|NodeService/.test(m.serviceName ?? m.name ?? ''))?.pid ?? null);
  check('Medya işçisi öldürülünce editör ayakta kaldı ve işçi yeniden başladı', alive && probe[0] && !('error' in probe[0]) && pid2 && pid2 !== pid, `eski pid ${pid} → yeni ${pid2}; ${probe[0]?.error ?? 'probe ok'}`);
}

check('Konsolda hata yok', errors.length === 0, errors.slice(0, 5).join(' | '));
await app.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n[e2e] ${results.length - failed.length}/${results.length} geçti`);
process.exit(failed.length ? 1 : 0);
