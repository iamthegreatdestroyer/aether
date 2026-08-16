/**
 * Baseline GPU particle engine — the `cambecc/earth` → `windgl` algorithm, written from
 * scratch against WebGL2.
 *
 * This is BOTH the control (something to measure the candidate libraries against) AND the
 * evaluation of option 4 in gate G0.4, "port cambecc/earth". If a third-party library cannot
 * beat this, the zero-dependency option wins on supply-chain grounds alone — which matters
 * here, because the proposal's named engine (@astrosat/windgl) turned out to be seven years
 * stale and pinned to mapbox-gl ^0.53.
 *
 * The technique, unchanged since Beccario:
 *   1. Particle positions live in a texture, 2 bytes per axis for sub-pixel precision.
 *   2. An update pass renders that texture to a ping-pong FBO, advecting each particle by the
 *      wind sampled at its position, with a random respawn to stop clustering at convergence.
 *   3. A draw pass renders one GL_POINT per particle into a persistent screen texture that
 *      fades slightly each frame, which is what produces the trails.
 *
 * All state is on the GPU. The CPU per frame does: 2 draw calls, ~8 uniform writes. That is
 * the whole reason a million particles is achievable at 60 fps.
 */

import type {
  EngineContext,
  EngineParams,
  ParticleEngine,
  ViewState,
  WindField,
} from './types';

const QUAD_VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos;
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Advect every particle by one timestep. Renders position texture -> position texture. */
const UPDATE_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_particles;
uniform sampler2D u_wind;
uniform vec2 u_wind_min;     // (uMin, vMin)
uniform vec2 u_wind_max;     // (uMax, vMax)
uniform float u_speed;
uniform float u_drop_rate;
uniform float u_rand_seed;

// 2-byte-per-axis position codec: 16 bits per axis instead of 8.
//
// The 255 here is load-bearing and 256 is WRONG, which is not obvious and cost a debugging
// pass. Storing hi = floor(p*256)/255 and reading back hi + lo/255 reconstructs p * 256/255 --
// a +0.392% multiplicative error EVERY FRAME, compounding to 1.265x per second. The symptom
// is not a crash: particles drift uniformly southeast at a rate that swamps the actual wind,
// which reads as "the wind field looks oddly uniform" rather than "the codec is broken".
//
// With 255 the round trip is exact: lo = fract(p*255), hi = floor(p*255)/255,
// and hi + lo/255 == (floor(p*255) + fract(p*255)) / 255 == p.
// Channel layout matches the windgl/cambecc lineage: rg = low bytes, ba = high bytes.
vec2 decodePos(vec4 c) {
  return vec2(c.r / 255.0 + c.b, c.g / 255.0 + c.a);
}
vec4 encodePos(vec2 p) {
  return vec4(fract(p * 255.0), floor(p * 255.0) / 255.0);
}

float rand(vec2 co) {
  return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  // pos.x in [0,1] maps lon -180..180; pos.y in [0,1] maps lat +90..-90
  vec2 pos = decodePos(texture(u_particles, v_uv));

  vec2 raw = texture(u_wind, pos).rg;
  vec2 wind = mix(u_wind_min, u_wind_max, raw);   // back to m/s

  // Degrees of longitude per metre grows as you approach the poles. Without this correction
  // particles crawl at the equator and teleport near the poles.
  float lat = radians(90.0 - pos.y * 180.0);
  float cosLat = max(cos(lat), 0.01);
  vec2 offset = vec2(wind.x / cosLat, -wind.y) * u_speed * 1e-5;

  vec2 next = pos + offset;
  next.x = fract(next.x + 1.0);                    // wrap the antimeridian
  next.y = clamp(next.y, 0.0, 1.0);

  // Respawn some particles at random, plus any that ran into a pole or a calm.
  vec2 seed = (pos + v_uv) * u_rand_seed;
  float speed = length(wind) / max(length(u_wind_max - u_wind_min), 1.0);
  float dropRate = u_drop_rate + speed * u_drop_rate * 0.4;
  vec2 randomPos = vec2(rand(seed + 1.3), rand(seed + 2.1));
  float drop = step(1.0 - dropRate, rand(seed));

  vec2 result = mix(next, randomPos, drop);
  fragColor = encodePos(result);
}`;

/** Draw one point per particle, projected through the map's camera. */
const DRAW_VERT = `#version 300 es
precision highp float;
in float a_index;

uniform sampler2D u_particles;
uniform float u_particles_res;
uniform sampler2D u_wind;
uniform vec2 u_wind_min;
uniform vec2 u_wind_max;

// Camera, matching MapLibre's Web Mercator at bearing B, pitch 0.
uniform vec2 u_center;       // map centre in mercator world units, [0,1]
uniform float u_world_size;  // 512 * 2^zoom, in device px
uniform vec2 u_viewport;     // device px
uniform float u_bearing;     // radians

out float v_speed;

const float PI = 3.141592653589793;

void main() {
  vec2 texel = vec2(
    fract(a_index / u_particles_res),
    floor(a_index / u_particles_res) / u_particles_res
  );
  // Must match encodePos in the update shader exactly — rg = low bytes, ba = high bytes.
  vec4 enc = texture(u_particles, texel);
  vec2 pos = vec2(enc.r / 255.0 + enc.b, enc.g / 255.0 + enc.a);

  // equirectangular [0,1] -> lon/lat -> Web Mercator [0,1]
  float lon = pos.x * 360.0 - 180.0;
  float lat = 90.0 - pos.y * 180.0;
  float mx = (lon + 180.0) / 360.0;
  float clamped = clamp(lat, -85.051129, 85.051129);
  float my = 0.5 - log(tan(PI * 0.25 + radians(clamped) * 0.5)) / (2.0 * PI);

  // world -> screen, taking the shortest way around the antimeridian
  vec2 d = vec2(mx, my) - u_center;
  d.x -= floor(d.x + 0.5);
  vec2 screen = d * u_world_size;

  float s = sin(u_bearing), c = cos(u_bearing);
  screen = vec2(screen.x * c - screen.y * s, screen.x * s + screen.y * c);

  gl_Position = vec4(2.0 * screen / u_viewport * vec2(1.0, -1.0), 0.0, 1.0);
  gl_PointSize = 1.0;

  vec2 wind = mix(u_wind_min, u_wind_max, texture(u_wind, pos).rg);
  v_speed = clamp(length(wind) / 30.0, 0.0, 1.0);
}`;

const DRAW_FRAG = `#version 300 es
precision highp float;
in float v_speed;
out vec4 fragColor;
void main() {
  // cool -> warm ramp; cheap stand-in for a proper colour LUT
  vec3 slow = vec3(0.44, 0.71, 0.96);
  vec3 mid  = vec3(0.98, 0.93, 0.55);
  vec3 fast = vec3(0.96, 0.36, 0.30);
  vec3 c = v_speed < 0.5
    ? mix(slow, mid, v_speed * 2.0)
    : mix(mid, fast, (v_speed - 0.5) * 2.0);
  fragColor = vec4(c, 0.85);
}`;

/** Composite the trail texture to screen, fading it so old points decay. */
const SCREEN_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_screen;
uniform float u_opacity;
void main() {
  vec4 c = texture(u_screen, v_uv);
  // premultiplied fade, avoiding the alpha rounding that leaves permanent ghost trails
  fragColor = vec4(floor(255.0 * c * u_opacity) / 255.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`shader compile failed: ${gl.getShaderInfoLog(sh)}`);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

function texture(
  gl: WebGL2RenderingContext,
  filter: number,
  data: HTMLImageElement | Uint8Array,
  w?: number,
  h?: number,
): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  if (data instanceof Uint8Array) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w!, h!, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }
  gl.bindTexture(gl.TEXTURE_2D, null);
  return t;
}

export class BaselineEngine implements ParticleEngine {
  readonly id = 'baseline';
  readonly label = 'Baseline (cambecc/earth port)';
  readonly provenance =
    'Written from scratch for this spike. Zero dependencies, MIT lineage. ' +
    'Draws 1 GL_POINT per particle into a faded trail buffer.';
  readonly ownsSurface = false;

  private gl!: WebGL2RenderingContext;
  private field!: WindField;
  private params!: EngineParams;

  private updateProg!: WebGLProgram;
  private drawProg!: WebGLProgram;
  private screenProg!: WebGLProgram;

  private quadBuf!: WebGLBuffer;
  private indexBuf!: WebGLBuffer;
  private fbo!: WebGLFramebuffer;

  private windTex!: WebGLTexture;
  private particleTex0!: WebGLTexture;
  private particleTex1!: WebGLTexture;
  private screenTex!: WebGLTexture;
  private backTex!: WebGLTexture;

  private res = 0;
  private count = 0;
  private width = 0;
  private height = 0;

  init(ctx: EngineContext, field: WindField, params: EngineParams): void {
    const gl = ctx.gl;
    this.gl = gl;
    this.field = field;
    // COPY, never alias. The caller owns a long-lived PARAMS object and mutates it in place;
    // holding the same reference makes every "did this change?" check compare a value with
    // itself, so the particle-count slider silently does nothing. Found by the coverage test.
    this.params = { ...params };

    this.updateProg = link(gl, QUAD_VERT, UPDATE_FRAG);
    this.drawProg = link(gl, DRAW_VERT, DRAW_FRAG);
    this.screenProg = link(gl, QUAD_VERT, SCREEN_FRAG);

    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
      gl.STATIC_DRAW,
    );

    this.fbo = gl.createFramebuffer()!;
    // LINEAR on the wind field: interpolating between grid cells is what stops particles
    // moving in visible 1-degree staircases.
    this.windTex = texture(gl, gl.LINEAR, field.image);

    this.allocParticles(params.particleCount);
  }

  private allocParticles(requested: number): void {
    const gl = this.gl;
    // Particles live in a square texture, so the count rounds to a perfect square.
    this.res = Math.ceil(Math.sqrt(Math.max(1, requested)));
    this.count = this.res * this.res;

    const state = new Uint8Array(this.count * 4);
    // crypto.getRandomValues() throws QuotaExceededError above 65,536 bytes per call, and at
    // a million particles this buffer is 4 MB. Fill it in chunks.
    const CHUNK = 65536;
    for (let off = 0; off < state.length; off += CHUNK) {
      crypto.getRandomValues(state.subarray(off, Math.min(off + CHUNK, state.length)));
    }

    if (this.particleTex0) gl.deleteTexture(this.particleTex0);
    if (this.particleTex1) gl.deleteTexture(this.particleTex1);
    this.particleTex0 = texture(gl, gl.NEAREST, state, this.res, this.res);
    this.particleTex1 = texture(gl, gl.NEAREST, state, this.res, this.res);

    const indices = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) indices[i] = i;
    if (this.indexBuf) gl.deleteBuffer(this.indexBuf);
    this.indexBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuf);
    gl.bufferData(gl.ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  }

  setParams(params: EngineParams): void {
    const needsRealloc = params.particleCount !== this.params.particleCount;
    this.params = { ...params };
    if (needsRealloc) this.allocParticles(params.particleCount);
  }

  resize(width: number, height: number): void {
    const gl = this.gl;
    this.width = width;
    this.height = height;
    const blank = new Uint8Array(width * height * 4);
    if (this.screenTex) gl.deleteTexture(this.screenTex);
    if (this.backTex) gl.deleteTexture(this.backTex);
    this.screenTex = texture(gl, gl.NEAREST, blank, width, height);
    this.backTex = texture(gl, gl.NEAREST, blank, width, height);
  }

  actualParticleCount(): number {
    return this.count;
  }

  primitivesPerFrame(): { count: number; kind: string } {
    return { count: this.count, kind: 'points' };
  }

  /** The harness drives this engine directly, so the callback is never needed. */
  setFrameCallback(_cb: () => void): void {}

  frame(view: ViewState): void {
    const gl = this.gl;
    const f = this.field;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);

    // ---- 1. draw the faded previous frame + this frame's points into the back texture
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.backTex, 0,
    );
    gl.viewport(0, 0, this.width, this.height);

    gl.useProgram(this.screenProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.screenTex);
    gl.uniform1i(gl.getUniformLocation(this.screenProg, 'u_screen'), 0);
    gl.uniform1f(
      gl.getUniformLocation(this.screenProg, 'u_opacity'), this.params.fadeOpacity,
    );
    this.drawQuad(this.screenProg);

    gl.useProgram(this.drawProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.particleTex0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.windTex);
    gl.uniform1i(gl.getUniformLocation(this.drawProg, 'u_particles'), 0);
    gl.uniform1i(gl.getUniformLocation(this.drawProg, 'u_wind'), 1);
    gl.uniform1f(gl.getUniformLocation(this.drawProg, 'u_particles_res'), this.res);
    gl.uniform2f(gl.getUniformLocation(this.drawProg, 'u_wind_min'), f.uMin, f.vMin);
    gl.uniform2f(gl.getUniformLocation(this.drawProg, 'u_wind_max'), f.uMax, f.vMax);
    gl.uniform2f(gl.getUniformLocation(this.drawProg, 'u_center'), view.centerX, view.centerY);
    gl.uniform1f(
      gl.getUniformLocation(this.drawProg, 'u_world_size'), view.worldSize * view.dpr,
    );
    gl.uniform2f(gl.getUniformLocation(this.drawProg, 'u_viewport'), this.width, this.height);
    gl.uniform1f(
      gl.getUniformLocation(this.drawProg, 'u_bearing'), (view.bearing * Math.PI) / 180,
    );

    const aIndex = gl.getAttribLocation(this.drawProg, 'a_index');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuf);
    gl.enableVertexAttribArray(aIndex);
    gl.vertexAttribPointer(aIndex, 1, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, this.count);

    // ---- 2. composite to the real canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.screenProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.backTex);
    gl.uniform1i(gl.getUniformLocation(this.screenProg, 'u_screen'), 0);
    gl.uniform1f(gl.getUniformLocation(this.screenProg, 'u_opacity'), 1.0);
    this.drawQuad(this.screenProg);
    gl.disable(gl.BLEND);

    [this.screenTex, this.backTex] = [this.backTex, this.screenTex];

    // ---- 3. advance the simulation
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.particleTex1, 0,
    );
    gl.viewport(0, 0, this.res, this.res);

    gl.useProgram(this.updateProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.particleTex0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.windTex);
    gl.uniform1i(gl.getUniformLocation(this.updateProg, 'u_particles'), 0);
    gl.uniform1i(gl.getUniformLocation(this.updateProg, 'u_wind'), 1);
    gl.uniform2f(gl.getUniformLocation(this.updateProg, 'u_wind_min'), f.uMin, f.vMin);
    gl.uniform2f(gl.getUniformLocation(this.updateProg, 'u_wind_max'), f.uMax, f.vMax);
    gl.uniform1f(gl.getUniformLocation(this.updateProg, 'u_speed'), this.params.speedFactor);
    gl.uniform1f(gl.getUniformLocation(this.updateProg, 'u_drop_rate'), this.params.dropRate);
    gl.uniform1f(gl.getUniformLocation(this.updateProg, 'u_rand_seed'), Math.random());
    this.drawQuad(this.updateProg);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    [this.particleTex0, this.particleTex1] = [this.particleTex1, this.particleTex0];
  }

  private drawQuad(prog: WebGLProgram): void {
    const gl = this.gl;
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of [
      this.windTex, this.particleTex0, this.particleTex1, this.screenTex, this.backTex,
    ]) {
      if (t) gl.deleteTexture(t);
    }
    for (const p of [this.updateProg, this.drawProg, this.screenProg]) {
      if (p) gl.deleteProgram(p);
    }
    if (this.quadBuf) gl.deleteBuffer(this.quadBuf);
    if (this.indexBuf) gl.deleteBuffer(this.indexBuf);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
  }
}
