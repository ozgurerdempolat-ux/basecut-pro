import { _electron as electron } from 'playwright';
import { join } from 'node:path';
const [media, out, w, h] = process.argv.slice(2);
const app = await electron.launch({ args: ['--no-sandbox', 'out/main/index.js'], env: { ...process.env, KURGU_FFMPEG: 'ffmpeg', KURGU_FFPROBE: 'ffprobe' } });
const page = await app.firstWindow();
await page.setViewportSize({ width: Number(w), height: Number(h) });
await page.waitForSelector('.timeline');
await page.evaluate(() => window.__kurgu.store.useStore.setState({ dialog: null, toasts: [] }));
await page.screenshot({ path: join(out, `a00-home-${w}.png`) });
await page.evaluate(() => window.__kurgu.store.useStore.setState({ home: false }));
await page.screenshot({ path: join(out, `a0-empty-${w}.png`) });
await page.evaluate((p) => window.__kurgu.store.importPaths(p, { createSequence: true }), ['kamera-1.mp4', 'logo.png', 'muzik.wav'].map((f) => join(media, f)));
await page.waitForTimeout(3000);
await page.evaluate(() => { const k = window.__kurgu.store; const s = k.committedSeq(); const c = Object.values(s.clips).find((x) => x.stream === 'video'); k.selectClips([c.id]); k.setPlayhead(40); k.useStore.setState({ toasts: [] }); });
for (const tab of ['project', 'effects', 'fx', 'color', 'captions', 'mixer']) {
  await page.evaluate((t) => window.__kurgu.store.useStore.setState({ leftTab: t }), tab);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, `a1-${tab}-${w}.png`) });
}
await page.evaluate(() => window.__kurgu.store.useStore.setState({ mode: 'export' }));
await page.waitForTimeout(500);
await page.screenshot({ path: join(out, `a2-export-${w}.png`) });
await page.evaluate(() => window.__kurgu.store.useStore.setState({ mode: 'edit', dialog: { kind: 'shortcuts' } }));
await page.waitForTimeout(300);
await page.screenshot({ path: join(out, `a3-shortcuts-${w}.png`) });
await app.close();
