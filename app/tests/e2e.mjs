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

const app = await electron.launch({
  args: ['--no-sandbox', '--disable-gpu-sandbox', 'out/main/index.js'],
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
