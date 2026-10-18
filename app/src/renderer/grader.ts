// GPU colour grading for the preview: draws a video/image frame through the
// same baked 3D LUT the export uses (WebGL2 3D texture, trilinear filtering).
import { ColorGrade, Lut3D, bakeLut, gradeKey, parseCube } from '../core/color';

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = vec2((p.x+1.0)*0.5, 1.0-(p.y+1.0)*0.5); gl_Position = vec4(p,0.0,1.0); }`;
const FS = `#version 300 es
precision highp float; precision highp sampler3D;
in vec2 uv; out vec4 o;
uniform sampler2D img; uniform sampler3D lut; uniform float n; uniform float vig;
void main(){
  vec4 c = texture(img, uv);
  vec3 k = (c.rgb * (n - 1.0) + 0.5) / n;   // sample texel centres
  vec3 g = texture(lut, k).rgb;
  if (vig < 0.0) { float d = distance(uv, vec2(0.5)); g *= 1.0 - (-vig) * smoothstep(0.35, 0.85, d); }
  o = vec4(g, c.a);
}`;

class Grader {
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private img: WebGLTexture | null = null;
  private luts = new Map<string, { tex: WebGLTexture; size: number }>();
  private userLuts = new Map<string, Lut3D | null>();
  failed = false;

  private init(): boolean {
    if (this.gl) return true;
    if (this.failed) return false;
    try {
      this.canvas = document.createElement('canvas');
      const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true });
      if (!gl) throw new Error('no webgl2');
      const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader'); return s; };
      const p = gl.createProgram()!;
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link');
      gl.useProgram(p);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(p, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.img = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(p, 'img'), 0);
      gl.uniform1i(gl.getUniformLocation(p, 'lut'), 1);
      this.gl = gl; this.prog = p;
      return true;
    } catch { this.failed = true; return false; }
  }

  /** load (or reuse) a user .cube file referenced by a grade */
  private user(path: string | null): Lut3D | null | undefined {
    if (!path) return null;
    if (this.userLuts.has(path)) return this.userLuts.get(path) ?? null;
    this.userLuts.set(path, null);
    void fetch(window.kurgu.mediaUrl(path)).then((r) => r.text()).then((t) => { try { this.userLuts.set(path, parseCube(t)); this.luts.clear(); } catch { /* bad file */ } });
    return undefined;
  }

  private lutTex(g: ColorGrade): { tex: WebGLTexture; size: number } {
    const key = gradeKey(g) + (g.lutPath ?? '') + (this.userLuts.get(g.lutPath ?? '') ? 'u' : '');
    const hit = this.luts.get(key);
    if (hit) return hit;
    const gl = this.gl!;
    const lut = bakeLut(g, 33, this.user(g.lutPath) ?? null);
    const bytes = new Uint8Array(lut.data.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(lut.data[i] * 255);
    const tex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, lut.size, lut.size, lut.size, 0, gl.RGB, gl.UNSIGNED_BYTE, bytes);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
    if (this.luts.size > 48) { for (const v of this.luts.values()) gl.deleteTexture(v.tex); this.luts.clear(); }
    const v = { tex, size: lut.size };
    this.luts.set(key, v);
    return v;
  }

  // ---------------- CPU fallback (no WebGL2: old integrated GPUs, some VMs)
  private cpuCanvas: HTMLCanvasElement | null = null;
  private cpuLuts = new Map<string, Uint8Array>();

  private processCpu(src: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement, g: ColorGrade, maxW: number, iw: number, ih: number): HTMLCanvasElement | null {
    // keep it light: grade at most ~640px wide; the monitor scales it up
    const k = Math.min(1, Math.min(maxW, 640) / iw);
    const w = Math.max(2, Math.round(iw * k)), h = Math.max(2, Math.round(ih * k));
    const c = this.cpuCanvas ?? (this.cpuCanvas = document.createElement('canvas'));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(src, 0, 0, w, h);
    let img: ImageData;
    try { img = ctx.getImageData(0, 0, w, h); } catch { return null; }
    const key = gradeKey(g) + (g.lutPath ?? '');
    let lut = this.cpuLuts.get(key);
    const N = 17;
    if (!lut) {
      const baked = bakeLut(g, N, this.user(g.lutPath) ?? null);
      lut = new Uint8Array(baked.data.length);
      for (let i = 0; i < lut.length; i++) lut[i] = Math.round(baked.data[i] * 255);
      if (this.cpuLuts.size > 16) this.cpuLuts.clear();
      this.cpuLuts.set(key, lut);
    }
    const d = img.data;
    const s = (N - 1) / 255;
    const vig = Math.max(-1, Math.min(0, g.vignette / 100));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // nearest-neighbour lookup in a 17³ table: fast and close enough for preview
      const ri = Math.round(d[i] * s), gi = Math.round(d[i + 1] * s), bi = Math.round(d[i + 2] * s);
      const j = ((bi * N + gi) * N + ri) * 3;
      let r = lut[j], gg = lut[j + 1], b = lut[j + 2];
      if (vig < 0) {
        const dx = x / w - 0.5, dy = y / h - 0.5;
        const dd = Math.sqrt(dx * dx + dy * dy);
        const t = Math.min(1, Math.max(0, (dd - 0.35) / 0.5));
        const f = 1 + vig * t * t * (3 - 2 * t);
        r *= f; gg *= f; b *= f;
      }
      d[i] = r; d[i + 1] = gg; d[i + 2] = b;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /** returns a canvas with the graded frame, or null to draw the original */
  process(src: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement, g: ColorGrade, maxW: number): HTMLCanvasElement | null {
    if (!this.init()) {
      const iw0 = src instanceof HTMLVideoElement ? src.videoWidth : src instanceof HTMLImageElement ? src.naturalWidth : src.width;
      const ih0 = src instanceof HTMLVideoElement ? src.videoHeight : src instanceof HTMLImageElement ? src.naturalHeight : src.height;
      return iw0 && ih0 ? this.processCpu(src, g, maxW, iw0, ih0) : null;
    }
    const gl = this.gl!;
    const iw = src instanceof HTMLVideoElement ? src.videoWidth : src instanceof HTMLImageElement ? src.naturalWidth : src.width;
    const ih = src instanceof HTMLVideoElement ? src.videoHeight : src instanceof HTMLImageElement ? src.naturalHeight : src.height;
    if (!iw || !ih) return null;
    const k = Math.min(1, maxW / iw);
    const w = Math.max(2, Math.round(iw * k)), h = Math.max(2, Math.round(ih * k));
    const c = this.canvas!;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    gl.viewport(0, 0, w, h);
    const { tex, size } = this.lutTex(g);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.img);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); } catch { return null; }
    gl.uniform1f(gl.getUniformLocation(this.prog!, 'n'), size);
    gl.uniform1f(gl.getUniformLocation(this.prog!, 'vig'), Math.max(-1, Math.min(0, g.vignette / 100)));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return c;
  }
}

export const grader = new Grader();
