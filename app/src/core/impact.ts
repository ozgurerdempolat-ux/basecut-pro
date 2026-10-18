// "Impact" transitions: cinematic, motion-heavy transitions (zoom punches, spins,
// whip pans, 3D flips, flashes, light leaks, shakes, glitches) in the spirit of
// the popular Premiere plug-in packs — our own designs, rendered by our own code.
//
// Each side (A = outgoing, B = incoming) gets an animated transform written in a
// tiny formula language of the progress p (0..1 over the transition). The same
// formula compiles to JavaScript (preview) and to an ffmpeg expression (export),
// so both evaluate exactly the same curve. Export uses fast per-frame filters
// (perspective, tmix, fade, overlay) — never per-pixel expressions — so it stays
// cheap on low-end machines.

export interface SideXf {
  /** uniform scale */ s?: string;
  /** extra horizontal / vertical scale */ sx?: string; sy?: string;
  /** rotation in degrees (2D) */ r?: string;
  /** 3D rotation around the vertical / horizontal axis, degrees */ ry?: string; rx?: string;
  /** offset as a fraction of the frame size */ dx?: string; dy?: string;
  /** opacity ramp in p: [start, end]; A fades out, B fades in. Omit = always visible */
  fade?: [number, number];
}

export interface ImpactDef {
  id: string;
  name: string;
  desc: string;
  /** which side is drawn on top */
  top: 'A' | 'B';
  A: SideXf;
  B: SideXf;
  /** motion blur: number of frames averaged (tmix) */
  blur?: number;
  /** outside the moved picture: 'clear' shows what is below, 'clamp' smears the edge pixels (hides black corners) */
  edge?: 'clear' | 'clamp';
  flash?: { color: number; from: number; peak: number; to: number; max: number };
  /** RGB split in % of the frame height while the transition runs */
  rgb?: number;
}

// ------------------------------------------------------------------ formula language

type Node = { k: 'num'; v: number } | { k: 'var'; n: string } | { k: 'neg'; a: Node } | { k: 'bin'; op: string; a: Node; b: Node } | { k: 'call'; f: string; args: Node[] };

const FUNCS: Record<string, { n: number; js: (...a: string[]) => string; ff: (...a: string[]) => string }> = {
  sin: { n: 1, js: (x) => `Math.sin(${x})`, ff: (x) => `sin(${x})` },
  cos: { n: 1, js: (x) => `Math.cos(${x})`, ff: (x) => `cos(${x})` },
  abs: { n: 1, js: (x) => `Math.abs(${x})`, ff: (x) => `abs(${x})` },
  floor: { n: 1, js: (x) => `Math.floor(${x})`, ff: (x) => `floor(${x})` },
  sqrt: { n: 1, js: (x) => `Math.sqrt(${x})`, ff: (x) => `sqrt(${x})` },
  min: { n: 2, js: (a, b) => `Math.min(${a},${b})`, ff: (a, b) => `min(${a},${b})` },
  max: { n: 2, js: (a, b) => `Math.max(${a},${b})`, ff: (a, b) => `max(${a},${b})` },
  pow: { n: 2, js: (a, b) => `Math.pow(${a},${b})`, ff: (a, b) => `pow(${a},${b})` },
  clamp: { n: 1, js: (x) => `Math.min(1,Math.max(0,${x}))`, ff: (x) => `clip(${x},0,1)` },
  /** cubic ease in-out of a clamped value */
  ease: { n: 1, js: (x) => `((t)=>t*t*(3-2*t))(Math.min(1,Math.max(0,${x})))`, ff: (x) => `(pow(clip(${x},0,1),2)*(3-2*clip(${x},0,1)))` },
  /** ease in (accelerating) */
  ei: { n: 1, js: (x) => `Math.pow(Math.min(1,Math.max(0,${x})),3)`, ff: (x) => `pow(clip(${x},0,1),3)` },
  /** ease out (decelerating) */
  eo: { n: 1, js: (x) => `(1-Math.pow(1-Math.min(1,Math.max(0,${x})),3))`, ff: (x) => `(1-pow(1-clip(${x},0,1),3))` },
  /** 0..1 as x goes from a to b */
  seg: { n: 3, js: (x, a, b) => `Math.min(1,Math.max(0,((${x})-(${a}))/((${b})-(${a}))))`, ff: (x, a, b) => `clip(((${x})-(${a}))/((${b})-(${a})),0,1)` },
  /** smooth deterministic jitter in -1..1 */
  noise: { n: 1, js: (x) => `(Math.sin((${x})*12.9898)*Math.cos((${x})*4.1414))`, ff: (x) => `(sin((${x})*12.9898)*cos((${x})*4.1414))` },
  /** quantise to n steps (stutter) */
  step: { n: 2, js: (x, n) => `(Math.floor((${x})*(${n}))/(${n}))`, ff: (x, n) => `(floor((${x})*(${n}))/(${n}))` },
  lt: { n: 2, js: (a, b) => `((${a})<(${b})?1:0)`, ff: (a, b) => `lt(${a},${b})` },
  gt: { n: 2, js: (a, b) => `((${a})>(${b})?1:0)`, ff: (a, b) => `gt(${a},${b})` },
  iff: { n: 3, js: (c, a, b) => `((${c})?(${a}):(${b}))`, ff: (c, a, b) => `if(${c},${a},${b})` },
};

export function parseFormula(src: string): Node {
  const toks = src.match(/\d+\.?\d*(?:e-?\d+)?|[A-Za-z_]\w*|[-+*/(),]/g) ?? [];
  if (toks.join('') !== src.replace(/\s+/g, '')) throw new Error(`Bad formula: ${src}`);
  let i = 0;
  const peek = () => toks[i];
  const eat = (t?: string) => { const x = toks[i++]; if (t && x !== t) throw new Error(`Expected ${t} in ${src}`); return x; };
  const expr = (): Node => { let a = term(); while (peek() === '+' || peek() === '-') { const op = eat(); a = { k: 'bin', op, a, b: term() }; } return a; };
  const term = (): Node => { let a = unary(); while (peek() === '*' || peek() === '/') { const op = eat(); a = { k: 'bin', op, a, b: unary() }; } return a; };
  const unary = (): Node => (peek() === '-' ? (eat(), { k: 'neg', a: unary() }) : atom());
  const atom = (): Node => {
    const t = eat();
    if (t === undefined) throw new Error(`Unexpected end in ${src}`);
    if (t === '(') { const e = expr(); eat(')'); return e; }
    if (/^\d/.test(t)) return { k: 'num', v: Number(t) };
    if (peek() === '(') {
      const fn = FUNCS[t];
      if (!fn) throw new Error(`Unknown function ${t}`);
      eat('(');
      const args: Node[] = [];
      if (peek() !== ')') { args.push(expr()); while (peek() === ',') { eat(); args.push(expr()); } }
      eat(')');
      if (args.length !== fn.n) throw new Error(`${t} takes ${fn.n} arguments`);
      return { k: 'call', f: t, args };
    }
    if (t !== 'p' && t !== 'PI') throw new Error(`Unknown name ${t}`);
    return { k: 'var', n: t };
  };
  const n = expr();
  if (i !== toks.length) throw new Error(`Trailing input in ${src}`);
  return n;
}

function emit(n: Node, target: 'js' | 'ff', pName: string): string {
  switch (n.k) {
    case 'num': return String(n.v);
    case 'var': return n.n === 'PI' ? (target === 'js' ? 'Math.PI' : 'PI') : pName;
    case 'neg': return `(-${emit(n.a, target, pName)})`;
    case 'bin': return `(${emit(n.a, target, pName)}${n.op}${emit(n.b, target, pName)})`;
    case 'call': { const fn = FUNCS[n.f]; const a = n.args.map((x) => emit(x, target, pName)); return target === 'js' ? fn.js(...a) : fn.ff(...a); }
  }
}

// The app's Content-Security-Policy forbids eval/new Function, so the JS side
// compiles the tree into plain closures instead.
const cl = (x: number) => Math.min(1, Math.max(0, x));
const RT: Record<string, (...a: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, abs: Math.abs, floor: Math.floor, sqrt: Math.sqrt, min: Math.min, max: Math.max, pow: Math.pow,
  clamp: cl,
  ease: (x) => { const t = cl(x); return t * t * (3 - 2 * t); },
  ei: (x) => Math.pow(cl(x), 3),
  eo: (x) => 1 - Math.pow(1 - cl(x), 3),
  seg: (x, a, b) => cl((x - a) / (b - a)),
  noise: (x) => Math.sin(x * 12.9898) * Math.cos(x * 4.1414),
  step: (x, n) => Math.floor(x * n) / n,
  lt: (a, b) => (a < b ? 1 : 0),
  gt: (a, b) => (a > b ? 1 : 0),
  iff: (c, a, b) => (c ? a : b),
};
function closure(n: Node): (p: number) => number {
  switch (n.k) {
    case 'num': { const v = n.v; return () => v; }
    case 'var': return n.n === 'PI' ? () => Math.PI : (p) => p;
    case 'neg': { const a = closure(n.a); return (p) => -a(p); }
    case 'bin': {
      const a = closure(n.a), b = closure(n.b);
      switch (n.op) { case '+': return (p) => a(p) + b(p); case '-': return (p) => a(p) - b(p); case '*': return (p) => a(p) * b(p); default: return (p) => a(p) / b(p); }
    }
    case 'call': { const fn = RT[n.f]; const args = n.args.map(closure); return (p) => fn(...args.map((g) => g(p))); }
  }
}
const jsCache = new Map<string, (p: number) => number>();
export function formulaJs(src: string): (p: number) => number {
  let fn = jsCache.get(src);
  if (!fn) { fn = closure(parseFormula(src)); jsCache.set(src, fn); }
  return fn;
}
export const formulaFf = (src: string, pExpr: string) => emit(parseFormula(src), 'ff', pExpr);

// ------------------------------------------------------------------ the transitions

const PUSH = (dx: number, dy: number): Pick<ImpactDef, 'A' | 'B' | 'top' | 'blur'> => ({
  top: 'A', blur: 5,
  A: { dx: `${-dx}*ease(p)`, dy: `${-dy}*ease(p)` },
  B: { dx: `${dx}*(1-ease(p))`, dy: `${dy}*(1-ease(p))` },
});
const WHIP = (dx: number): Pick<ImpactDef, 'A' | 'B' | 'top' | 'blur' | 'edge'> => ({
  top: 'A', blur: 6, edge: 'clamp',
  A: { dx: `${-dx}*0.6*ei(seg(p,0,0.5))`, fade: [0.44, 0.56] },
  B: { dx: `${dx}*0.6*(1-eo(seg(p,0.5,1)))` },
});

export const IMPACTS: ImpactDef[] = [
  { id: 'imp-zoom-in', name: 'Zoom darbesi (içeri)', desc: 'Görüntü hızla içeri dalar, yeni sahne yakından yerine oturur — hareket bulanıklığıyla',
    top: 'A', blur: 4, edge: 'clamp',
    A: { s: '1+2.4*ei(seg(p,0,0.5))', fade: [0.42, 0.58] },
    B: { s: '1+1.4*(1-eo(seg(p,0.42,1)))' } },
  { id: 'imp-zoom-out', name: 'Zoom darbesi (dışarı)', desc: 'Görüntü geri çekilir, yeni sahne arkadan yaklaşır',
    top: 'A', blur: 4, edge: 'clamp',
    A: { s: '1-0.65*ei(seg(p,0,0.6))', fade: [0.35, 0.6] },
    B: { s: '1.7-0.7*eo(p)' } },
  { id: 'imp-spin', name: 'Dönerek geçiş', desc: 'Yarım tur dönüp yeni sahneye ters yönden oturur',
    top: 'A', blur: 4, edge: 'clamp',
    A: { r: '180*ei(seg(p,0,0.5))', s: '1+0.5*ei(seg(p,0,0.5))', fade: [0.46, 0.54] },
    B: { r: '-180*(1-eo(seg(p,0.5,1)))', s: '1.5-0.5*eo(seg(p,0.5,1))' } },
  { id: 'imp-spin-zoom', name: 'Girdap (dön + zoom)', desc: 'Tam tur dönerken içeri çeker',
    top: 'A', blur: 5, edge: 'clamp',
    A: { r: '360*ei(seg(p,0,0.5))', s: '1+3*ei(seg(p,0,0.5))', fade: [0.45, 0.55] },
    B: { r: '-360*(1-eo(seg(p,0.5,1)))', s: '0.35+0.65*eo(seg(p,0.5,1))' } },
  { id: 'imp-push-left', name: 'Darbeli itme ←', desc: 'Yeni sahne eskisini hareket bulanıklığıyla iter', ...PUSH(1, 0) },
  { id: 'imp-push-right', name: 'Darbeli itme →', desc: 'Yeni sahne eskisini hareket bulanıklığıyla iter', ...PUSH(-1, 0) },
  { id: 'imp-push-up', name: 'Darbeli itme ↑', desc: 'Yeni sahne eskisini hareket bulanıklığıyla iter', ...PUSH(0, 1) },
  { id: 'imp-push-down', name: 'Darbeli itme ↓', desc: 'Yeni sahne eskisini hareket bulanıklığıyla iter', ...PUSH(0, -1) },
  { id: 'imp-whip-left', name: 'Kamera savurma ←', desc: 'Whip pan: kamera hızla savrulmuş gibi', ...WHIP(1) },
  { id: 'imp-whip-right', name: 'Kamera savurma →', desc: 'Whip pan: kamera hızla savrulmuş gibi', ...WHIP(-1) },
  { id: 'imp-flip-h', name: '3B çevirme (yatay)', desc: 'Kart gibi dikey eksende döner',
    top: 'A', blur: 2,
    A: { ry: '90*ei(seg(p,0,0.5))', fade: [0.495, 0.505] },
    B: { ry: '-90*(1-eo(seg(p,0.5,1)))' } },
  { id: 'imp-flip-v', name: '3B çevirme (dikey)', desc: 'Kart gibi yatay eksende takla atar',
    top: 'A', blur: 2,
    A: { rx: '90*ei(seg(p,0,0.5))', fade: [0.495, 0.505] },
    B: { rx: '-90*(1-eo(seg(p,0.5,1)))' } },
  { id: 'imp-cube', name: '3B küp', desc: 'Sahneler bir küpün yüzleri gibi döner',
    top: 'A',
    A: { ry: '-90*ease(p)', dx: '-0.5*ease(p)', s: '1-0.15*sin(PI*p)', fade: [0.5, 0.5] },
    B: { ry: '90*(1-ease(p))', dx: '0.5*(1-ease(p))', s: '1-0.15*sin(PI*p)' } },
  { id: 'imp-stretch', name: 'Esneme', desc: 'Görüntü yatayda uzayıp yeni sahneye akar',
    top: 'A', blur: 3, edge: 'clamp',
    A: { sx: '1+4*ei(seg(p,0,0.5))', sy: '1-0.08*ei(seg(p,0,0.5))', fade: [0.45, 0.55] },
    B: { sx: '1+4*(1-eo(seg(p,0.5,1)))', sy: '1-0.08*(1-eo(seg(p,0.5,1)))' } },
  { id: 'imp-flash', name: 'Flaş', desc: 'Beyaz patlamayla sert kesme',
    top: 'A', A: { fade: [0.48, 0.52] }, B: {},
    flash: { color: 0xffffff, from: 0.15, peak: 0.5, to: 0.85, max: 1 } },
  { id: 'imp-flash-zoom', name: 'Flaşlı zoom', desc: 'Zoom darbesi + beyaz patlama',
    top: 'A', blur: 3, edge: 'clamp',
    A: { s: '1+0.8*ei(seg(p,0,0.5))', fade: [0.48, 0.52] },
    B: { s: '1+0.5*(1-eo(seg(p,0.5,1)))' },
    flash: { color: 0xffffff, from: 0.3, peak: 0.5, to: 0.8, max: 0.95 } },
  { id: 'imp-leak', name: 'Işık sızması (sıcak)', desc: 'Film ışık kaçağı gibi turuncu parlama ile çözülme',
    top: 'A', A: { fade: [0.3, 0.7], s: '1+0.04*p' }, B: { s: '1.04-0.04*p' },
    flash: { color: 0xff8a2a, from: 0, peak: 0.5, to: 1, max: 0.7 } },
  { id: 'imp-leak-cool', name: 'Işık sızması (soğuk)', desc: 'Mavi-mor parlama ile çözülme',
    top: 'A', A: { fade: [0.3, 0.7], s: '1+0.04*p' }, B: { s: '1.04-0.04*p' },
    flash: { color: 0x6a7dff, from: 0, peak: 0.5, to: 1, max: 0.65 } },
  { id: 'imp-shake', name: 'Sarsıntılı kesme', desc: 'Darbe anında ekran sarsılır',
    top: 'A', blur: 2, edge: 'clamp',
    A: { dx: '0.05*sin(PI*p)*noise(p*57)', dy: '0.05*sin(PI*p)*noise(p*43+3)', r: '6*sin(PI*p)*noise(p*31+7)', s: '1+0.12*sin(PI*p)', fade: [0.47, 0.53] },
    B: { dx: '0.05*sin(PI*p)*noise(p*57)', dy: '0.05*sin(PI*p)*noise(p*43+3)', r: '6*sin(PI*p)*noise(p*31+7)', s: '1+0.12*sin(PI*p)' } },
  { id: 'imp-glitch', name: 'Glitch geçiş', desc: 'Dijital bozulma, kanal kayması ve kekeleme ile kesme',
    top: 'A', edge: 'clamp', rgb: 1.2,
    A: { dx: '0.07*sin(PI*p)*noise(step(p,14)*7)', sx: '1+0.2*sin(PI*p)*gt(noise(step(p,9)*5),0.3)', fade: [0.5, 0.5] },
    B: { dx: '0.07*sin(PI*p)*noise(step(p,14)*7)', sx: '1+0.2*sin(PI*p)*gt(noise(step(p,9)*5),0.3)' } },
  { id: 'imp-roll', name: 'Yuvarlanma', desc: 'Görüntü dönerek aşağı düşer, yenisi yukarıdan gelir',
    top: 'A', blur: 4,
    A: { dy: '1.1*ei(p)', r: '-25*ei(p)' },
    B: { dy: '-1.1*(1-eo(p))', r: '25*(1-eo(p))' } },
  { id: 'imp-dip-black', name: 'Siyaha darbe', desc: 'Kısa, sert bir karanlık anla kesme',
    top: 'A', A: { fade: [0.48, 0.52] }, B: {},
    flash: { color: 0x000000, from: 0.2, peak: 0.5, to: 0.8, max: 1 } },
];

export const IMPACT_BY_ID: Record<string, ImpactDef> = Object.fromEntries(IMPACTS.map((d) => [d.id, d]));

// ------------------------------------------------------------------ geometry (shared)

const DEG = Math.PI / 180;
/** camera distance for the 3D rotations, in frame widths */
const CAM = 1.6;

/** where the point (u,v) of the picture (-0.5..0.5) lands in the output, for transform values */
export function projectPoint(u: number, v: number, t: { s: number; sx: number; sy: number; r: number; ry: number; rx: number; dx: number; dy: number }, W: number, H: number): [number, number] {
  const x = u * W * t.s * t.sx, y = v * H * t.s * t.sy;
  const ry = t.ry * DEG, rx = t.rx * DEG, r = t.r * DEG;
  const z = x * Math.sin(ry) + y * Math.sin(rx);
  const k = (CAM * W) / (CAM * W + z);
  const xp = x * Math.cos(ry) * k, yp = y * Math.cos(rx) * k;
  return [W / 2 + xp * Math.cos(r) - yp * Math.sin(r) + t.dx * W, H / 2 + xp * Math.sin(r) + yp * Math.cos(r) + t.dy * H];
}

const KEYS = ['s', 'sx', 'sy', 'r', 'ry', 'rx', 'dx', 'dy'] as const;
const DEFAULTS: Record<(typeof KEYS)[number], string> = { s: '1', sx: '1', sy: '1', r: '0', ry: '0', rx: '0', dx: '0', dy: '0' };

export function sideAt(x: SideXf, p: number) {
  const o = {} as Record<(typeof KEYS)[number], number>;
  for (const k of KEYS) o[k] = formulaJs(x[k] ?? DEFAULTS[k])(p);
  return o;
}

/** opacity of a side at p (A fades out over its ramp, B fades in) */
export function sideAlpha(x: SideXf, side: 'A' | 'B', p: number): number {
  if (!x.fade) return 1;
  const [a, b] = x.fade;
  const t = b <= a ? (p >= a ? 1 : 0) : Math.min(1, Math.max(0, (p - a) / (b - a)));
  return side === 'A' ? 1 - t : t;
}

export function flashAt(d: ImpactDef, p: number): number {
  const f = d.flash;
  if (!f) return 0;
  if (p <= f.from || p >= f.to) return 0;
  return f.max * (p < f.peak ? (p - f.from) / Math.max(1e-6, f.peak - f.from) : (f.to - p) / Math.max(1e-6, f.to - f.peak));
}

// ------------------------------------------------------------------ ffmpeg

const r6 = (n: number) => Number(n.toFixed(6)).toString();

/** perspective corner expressions for one side; `pad` = pixels of transparent border added before */
function cornerExprs(x: SideXf, W: number, H: number, frames: number, pad: number): string {
  const p = `clip(in/${Math.max(1, frames - 1)},0,1)`;
  const v = (k: (typeof KEYS)[number]) => formulaFf(x[k] ?? DEFAULTS[k], p);
  const corner = (u: number, w: number, axis: 'x' | 'y') => {
    // registers: 0 x, 1 y, 2 ry, 3 rx, 4 k, 5 xp, 6 yp, 7 r
    const pre = `st(0,${u * W}*(${v('s')})*(${v('sx')}));st(1,${w * H}*(${v('s')})*(${v('sy')}));st(2,(${v('ry')})*${r6(DEG)});st(3,(${v('rx')})*${r6(DEG)});`
      + `st(4,${r6(CAM * W)}/(${r6(CAM * W)}+ld(0)*sin(ld(2))+ld(1)*sin(ld(3))));st(5,ld(0)*cos(ld(2))*ld(4));st(6,ld(1)*cos(ld(3))*ld(4));st(7,(${v('r')})*${r6(DEG)});`;
    return axis === 'x'
      ? `${pre}${r6(W / 2 + pad)}+ld(5)*cos(ld(7))-ld(6)*sin(ld(7))+(${v('dx')})*${W}`
      : `${pre}${r6(H / 2 + pad)}+ld(5)*sin(ld(7))+ld(6)*cos(ld(7))+(${v('dy')})*${H}`;
  };
  const c: string[] = [];
  const pts: [number, number][] = [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]];
  pts.forEach(([u, w], i) => { c.push(`x${i}='${corner(u, w, 'x')}'`, `y${i}='${corner(u, w, 'y')}'`); });
  return `perspective=sense=destination:eval=frame:interpolation=linear:${c.join(':')}`;
}

/**
 * Filter graph pieces for an impact transition window.
 * Inputs: labels of the two side segments (transparent W×H yuva420p canvases, `len` seconds, frames long).
 * Returns filters and the output label.
 */
export function impactFilters(d: ImpactDef, sa: string, sb: string, W: number, H: number, fps: number, frames: number, lbl: (p: string) => string): { filters: string[]; out: string } {
  const len = frames / fps;
  const filters: string[] = [];
  const side = (label: string, x: SideXf, which: 'A' | 'B') => {
    const chain: string[] = [];
    if (d.rgb) { const px = Math.max(1, Math.round((d.rgb / 100) * H)); chain.push(`rgbashift=rh=${-px}:bh=${px}:edge=smear`); }
    const pad = d.edge === 'clamp' ? 0 : 2;
    if (pad) chain.push(`pad=${W + 2 * pad}:${H + 2 * pad}:${pad}:${pad}:color=black@0`);
    chain.push(cornerExprs(x, W, H, frames, pad));
    if (pad) chain.push(`crop=${W}:${H}:${pad}:${pad}`);
    if (x.fade) {
      const [a, b] = x.fade;
      const st = (a * (frames - 1)) / fps, du = Math.max(1 / fps, ((b - a) * (frames - 1)) / fps);
      chain.push(`fade=t=${which === 'A' ? 'out' : 'in'}:st=${r6(which === 'A' && b <= a ? st - 0.5 / fps : st)}:d=${r6(du)}:alpha=1`);
    }
    chain.push('format=yuva420p');
    const o = lbl('imp');
    filters.push(`[${label}]${chain.join(',')}[${o}]`);
    return o;
  };
  const A = side(sa, d.A, 'A'), B = side(sb, d.B, 'B');
  const [bottom, top] = d.top === 'A' ? [B, A] : [A, B];
  let out = lbl('impo');
  // motion blur on the composite, so the two sides blur into each other without seams
  const mb = d.blur && d.blur > 1 ? `,tmix=frames=${Math.round(d.blur)}` : '';
  filters.push(`[${bottom}][${top}]overlay=0:0:format=yuv420:alpha=straight,format=yuva420p${mb}[${out}]`);
  if (d.flash) {
    const f = d.flash;
    const fl = lbl('fl');
    const t = (q: number) => r6((q * (frames - 1)) / fps);
    filters.push(`color=c=0x${f.color.toString(16).padStart(6, '0')}:s=${W}x${H}:r=${r6(fps)}:d=${r6(len)},format=yuva420p,colorchannelmixer=aa=${r6(f.max)},`
      + `fade=t=in:st=${t(f.from)}:d=${r6(Math.max(1 / fps, ((f.peak - f.from) * (frames - 1)) / fps))}:alpha=1,`
      + `fade=t=out:st=${t(f.peak)}:d=${r6(Math.max(1 / fps, ((f.to - f.peak) * (frames - 1)) / fps))}:alpha=1[${fl}]`);
    const o2 = lbl('impf');
    filters.push(`[${out}][${fl}]overlay=0:0:format=yuv420:alpha=straight,format=yuva420p[${o2}]`);
    out = o2;
  }
  return { filters, out };
}
