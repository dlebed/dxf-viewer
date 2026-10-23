// End-to-end check of dxf-viewer.html in headless Chrome: loads fixtures, drives the real UI with mouse
// clicks and keys (snapping, every measurement tool, panels) and checks the results. Screenshots go to
// tests/out/. The page must not make a single network request.
//
//   cd tests && npm install && npm run e2e
// Chrome path: $CHROME, else the default macOS / Linux locations.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'out');
fs.mkdirSync(outDir, { recursive: true });
const EXPECTED = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'expected.json'), 'utf8'));

const chrome = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => fs.existsSync(p));
if (!chrome) throw new Error('Chrome not found; set $CHROME');

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? '✔' : '✖'} ${msg}`);
  if (!cond) failures++;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: chrome, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1400,900'],
  defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
const errors = [], external = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('request', (r) => { if (!/^(file|blob|data):/.test(r.url())) external.push(r.url()); });

await page.goto(pathToFileURL(path.join(here, '..', 'dxf-viewer.html')).href);
await page.waitForFunction(() => window.dxfViewer);

async function loadFixture(name) {
  const b64 = fs.readFileSync(path.join(here, 'fixtures', name)).toString('base64');
  const t0 = Date.now();
  await page.evaluate(async (b64, name) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await window.dxfViewer.load(bin.buffer, name);
  }, b64, name);
  await sleep(150);
  return Date.now() - t0;
}
const pageOf = (p) => page.evaluate((p) => window.dxfViewer.pageOf(p), p);
async function clickAt(p, opts) {
  const s = await pageOf(p);
  await page.mouse.move(s.x, s.y);
  await sleep(30);
  await page.mouse.click(s.x, s.y, opts);
  await sleep(40);
}
const tool = (k) => page.keyboard.press(k);
const measurements = () => page.evaluate(() => window.dxfViewer.measurements());
const last = async () => (await measurements()).at(-1);

// ------------------------------------------------------------ plate: every tool through the mouse
const v = EXPECTED['plate.dxf'].values;
await loadFixture('plate.dxf');
check(await page.$eval('#file-name', (e) => e.textContent) === 'plate.dxf', 'file name shown');
check(await page.evaluate(() => window.dxfViewer.usesWorker()), 'parsing runs in the Web Worker');

await tool('d');
await clickAt([0.3, 0.25]); // near the corner: endpoint snap must win
await clickAt([99.7, 0.3]);
let m = await last();
check(m && m.type === 'distance' && near(m.num, 100, 1e-9), `Distance: snapped endpoints 100 (got ${m?.num})`);
check(m?.value === '100.000 mm', `label "${m?.value}"`);

await clickAt([10.15, 10.1]); // hole centre (centre / intersection snap)
await clickAt([89.9, 10.1]);
m = await last();
check(near(m.num, 80, 1e-9), `Distance centre → centre 80 (got ${m.num})`);

await tool('r');
await clickAt([10 + 3.25, 10.6]);
m = await last();
check(m.type === 'radius' && near(m.num, v.holeRadius, 1e-12), `Radius tool on a hole: R ${m.num}`);
check(m.value === 'R 3.250 · Ø 6.500 mm', `label "${m.value}"`);
await clickAt([97.5 + 1.0, 47.5 + 1.0]); // R5 corner arc of the outline (a polyline bulge)
m = await last();
check(near(m.num, 5, 1e-12) && m.rows.some((r) => r[0] === 'Sweep' && r[1] === '90.000°'), `Radius tool on a polyline arc: R ${m.num}, sweep 90°`);

await tool('a');
await clickAt([50, 0.2]); // on the outline edge → that contour
m = await last();
check(m.type === 'area' && near(m.num, v.outlineArea, 1e-8), `Area of the outline contour ${m.num}`);
check(near(m.perimeter, v.outlinePerimeter, 1e-8), `outline perimeter ${m.perimeter}`);
await clickAt([30, 5]); // inside the plate → region minus holes and slot
m = await last();
check(near(m.num, v.netArea, 1e-7) && m.rows.some((r) => r[0] === 'Holes' && r[1] === '5'), `Region area (plate − 4 holes − slot) ${m.num}`);

await tool('g');
await clickAt([50, 0.2]);
await clickAt([0.2, 25]);
m = await last();
check(m.type === 'angle' && near(m.num, 90, 1e-9), `Angle between two edges ${m.num}°`);
await clickAt([0.15, 49.85]); // vertex, then two points (snapped endpoints)
await clickAt([0.2, 0.2]);
await clickAt([94.8, 49.8]);
m = await last();
check(near(m.num, 90, 1e-9) && m.rows.some((r) => r[0] === 'Vertex' && r[1] === '0.000, 50.000 mm'), `Angle from three snapped points ${m.num}° at vertex (0, 50)`);

await tool('m');
await clickAt([10 + 3.25, 10.5]);
await clickAt([90 - 3.25, 10.5]);
m = await last();
check(m.type === 'min' && near(m.num, v.holeGap, 1e-9), `Min distance hole ↔ hole ${m.num}`);
check(m.rows.some((r) => r[0] === 'Centre distance' && r[1] === '80.000 mm'), 'centre distance row');
await clickAt([50, 0.2]); await clickAt([50, 49.8]);
m = await last();
check(near(m.num, 50, 1e-9) && m.rows.some((r) => r[0] === 'Perpendicular gap'), `Min distance between two edges of one outline ${m.num}`);

await tool('l');
for (const p of [[0.2, 0.2], [99.8, 0.2], [99.8, 44.8]]) await clickAt(p);
await page.keyboard.press('Enter');
m = await last();
check(m.type === 'path' && near(m.num, 145, 1e-9), `Path length ${m.num}`);

await tool('p');
for (const p of [[0.2, 0.2], [99.8, 0.2], [0.2, 49.8]]) await clickAt(p);
await clickAt([0.3, 0.3]); // click the first point again to close
m = await last();
check(m.type === 'polygon' && near(m.num, 2500, 1e-9), `Polygon area ${m.num}`);

await tool('c');
await clickAt([79.8, 40.2]); // hole centre
m = await last();
check(m.type === 'coord' && m.value === '80.000, 40.000 mm', `Coordinate "${m.value}"`);

const count = (await measurements()).length;
check(count === 13, `${count} measurements listed (${(await measurements()).map((x) => x.type).join(' ')})`);
check(await page.$$eval('#mlist li', (l) => l.length) === count, 'measurement list rows');

// ortho with Shift and snapping off with Alt
await tool('d');
await clickAt([0.2, 0.2]);
await page.keyboard.down('Shift');
await clickAt([40, 13]);
await page.keyboard.up('Shift');
m = await last();
check(near(m.num, 40, 0.2) && m.rows.some((r) => r[0] === 'ΔY' && r[1] === '0.000 mm'), `Shift = ortho: horizontal (ΔY 0), length ${m.num.toFixed(3)}`);
await page.keyboard.down('Alt');
await clickAt([20, 20]); await clickAt([30, 20]);
await page.keyboard.up('Alt');
m = await last();
check(near(m.num, 10, 0.05) && !near(m.num, 10, 1e-12), `Alt = no snap: free distance ${m.num.toFixed(4)}`);

// units: the same measurements re-label in inches
await page.select('#sel-units', 'in');
const ms = await measurements();
check(ms[0].value === '3.937 in', `inch label "${ms[0].value}"`);
await page.select('#sel-units', 'mm');

// delete a measurement with its × button
await page.click(`#mlist li[data-id="${ms.at(-1).id}"] .iconbtn`);
check((await measurements()).length === ms.length - 1, 'delete removes the measurement');

// inspect: selection panel shows the polyline with its exact area
await tool('i');
await clickAt([50, 0.2]);
let txt = await page.evaluate(() => window.dxfViewer.selectionText());
check(/LWPOLYLINE/.test(txt) && /4994\.635 mm²/.test(txt), `Inspect panel: ${txt.split('\n').slice(0, 2).join(' / ')} … area`);
await clickAt([50.2, -10]); // dimension line → the whole DIMENSION, with its measured value
txt = await page.evaluate(() => window.dxfViewer.selectionText());
check(/DIMENSION/.test(txt) && /Measured value\s+100\.000 mm/.test(txt), 'Inspect a dimension shows its measured value');
await page.screenshot({ path: path.join(outDir, 'plate.png') });

// layers: hiding HOLES makes them unpickable and undrawn
const hole = await page.evaluate(() => window.dxfViewer.screenOf([10 + 3.25 * Math.SQRT1_2, 10 + 3.25 * Math.SQRT1_2]));
const before = await page.evaluate((s) => window.dxfViewer.pixel(s.x, s.y), hole);
await page.click('#layers li[data-layer="HOLES"] input');
const after = await page.evaluate((s) => window.dxfViewer.pixel(s.x, s.y), hole);
const bg = await page.evaluate(() => window.dxfViewer.pixel(2, 2));
check(before[0] > before[1] + 40 && after.every((c, i) => Math.abs(c - bg[i]) <= 2), `hiding a layer removes its pixels (red ${before} → ${after}, background ${bg})`);
await tool('r');
const n0 = (await measurements()).length;
await clickAt([10 + 3.25, 10.6]);
check((await measurements()).length === n0, 'hidden layer is not pickable');
await page.click('#layers li[data-layer="HOLES"] input');

// theme: ACI 7 (white on dark) turns black on a light background
const edge = await page.evaluate(() => window.dxfViewer.screenOf([50, 50]));
const themeTo = (t) => page.evaluate((t) => { while (window.dxfViewer.state.theme !== t) document.querySelector('#btn-theme').click(); }, t);
await themeTo('dark'); // the Theme button cycles auto → dark → light
const darkPx = await page.evaluate((s) => window.dxfViewer.pixel(s.x, s.y), edge);
await themeTo('light');
const lightPx = await page.evaluate((s) => window.dxfViewer.pixel(s.x, s.y), edge);
check(Math.min(...darkPx) > 150 && Math.max(...lightPx) < 100, `ACI 7 outline flips with the theme (dark ${darkPx}, light ${lightPx})`);
await page.screenshot({ path: path.join(outDir, 'plate-light.png') });
await themeTo('auto');

// linetypes off → continuous lines (re-tessellated in the worker); lineweights toggle draws without errors
const dashSegs = () => page.evaluate(() => window.dxfViewer.doc.spaces[0].geo.layers.CENTER.segs.length / 4);
const dashed = await dashSegs();
await page.click('#tg-lt');
await page.waitForFunction((n) => window.dxfViewer.doc.spaces[0].geo.layers.CENTER.segs.length / 4 !== n, { timeout: 10000 }, dashed);
const solid = await dashSegs();
check(dashed > solid && solid === 8, `Linetypes off: CENTER lines ${dashed} dashes → ${solid} continuous lines`);
await page.click('#tg-lt');
await page.waitForFunction((n) => window.dxfViewer.doc.spaces[0].geo.layers.CENTER.segs.length / 4 === n, { timeout: 10000 }, dashed);
await page.click('#tg-lw'); await page.evaluate(() => window.dxfViewer.pixel(5, 5)); await page.click('#tg-lw');

// zoom window and fit
const s0 = (await page.evaluate(() => window.dxfViewer.view)).s;
await page.keyboard.press('w');
const a = await pageOf([5, 5]), b = await pageOf([25, 20]);
await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up();
await sleep(50);
const s1 = (await page.evaluate(() => window.dxfViewer.view)).s;
check(s1 > s0 * 3, `zoom window magnifies (${s0.toFixed(2)} → ${s1.toFixed(2)} px/unit)`);
await page.keyboard.press('f');
check(near((await page.evaluate(() => window.dxfViewer.view)).s, s0, s0 * 1e-6), 'F fits again');

// ------------------------------------------------------------ PCB: info panel analysis
await loadFixture('pcb.dxf');
await page.click('#tab-btn-info');
await sleep(50);
const holeRows = await page.$$eval('#drawing-info tr[data-hole]', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
check(holeRows.length === 3 && /^0\.600 mm .* 12$/.test(holeRows[0]) && / 4$/.test(holeRows[2]), `hole table: ${holeRows.join(' | ')}`);
const gapRow = await page.$eval('#drawing-info tr[data-gap="0"]', (r) => r.innerText);
check(/0\.050 mm/.test(gapRow), `smallest gap row "${gapRow.replace(/\s+/g, ' ')}"`);
await page.click('#show-ends');
await page.click('#drawing-info tr[data-gap="0"]');
await sleep(50);
await page.screenshot({ path: path.join(outDir, 'pcb-gap.png') });
await page.keyboard.press('f');
await tool('a');
await clickAt([30, 26]); // between the via rows
m = await last();
check(near(m.num, EXPECTED['pcb.dxf'].values.boardArea - Math.PI * (4 * 1.6 ** 2 + 12 * 0.09 + 6 * 0.25), 1e-7), `board region area ${m.num}`);
await page.screenshot({ path: path.join(outDir, 'pcb.png') });
await page.click('#tab-btn-layers');

// ------------------------------------------------------------ paper space: model through a viewport
await loadFixture('paper.dxf');
await page.click('#tab-btn-layouts');
await page.click('#layouts li[data-si="1"]');
await sleep(50);
const vpEdge = await page.evaluate(() => window.dxfViewer.screenOf([110 + 12.5, 90])); // model circle seen at scale 1.25
const vpBg = await page.evaluate(() => window.dxfViewer.screenOf([110 + 6, 90]));
const onCircle = await page.evaluate((s) => window.dxfViewer.pixel(s.x, s.y), vpEdge);
const inside = await page.evaluate((s) => window.dxfViewer.pixel(s.x, s.y), vpBg);
check(Math.abs(onCircle[0] - inside[0]) > 80, `model circle drawn through the viewport (edge ${onCircle}, inside ${inside})`);
await page.screenshot({ path: path.join(outDir, 'paper.png') });
await page.click('#tab-btn-layers');

// ------------------------------------------------------------ sample drawing + a large real file
await page.evaluate(() => window.dxfViewer.sample());
await sleep(150);
const sample = await page.evaluate(() => ({ n: window.dxfViewer.space.entities.length, name: document.querySelector('#file-name').textContent }));
check(sample.n > 30 && sample.name === 'sample-bracket.dxf', `sample drawing loads (${sample.n} entities)`);
await page.screenshot({ path: path.join(outDir, 'sample.png') });
const ms2 = await loadFixture('real/floorplan.dxf');
const fp = await page.evaluate(() => window.dxfViewer.space.entities.length);
check(fp > 1500, `real floor plan: ${fp} entities in ${ms2} ms`);
await page.screenshot({ path: path.join(outDir, 'floorplan.png') });

// ------------------------------------------------------------ phone layout
await page.setViewport({ width: 390, height: 800, deviceScaleFactor: 2 });
await sleep(200);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check(overflow <= 0, `no horizontal overflow at 390 px (${overflow})`);
await page.screenshot({ path: path.join(outDir, 'phone.png') });

check(external.length === 0, `no network requests${external.length ? ': ' + external.join(', ') : ''}`);
check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall E2E checks passed');
process.exit(failures ? 1 : 0);
