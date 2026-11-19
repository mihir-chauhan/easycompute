/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

/** Imperative handle: speed the ribbon up briefly (planning / launch moments). */
export interface RibbonHandle {
  surge: (ms?: number) => void;
}

type V2 = [number, number];

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const bez = (p: V2[], t: number): V2 => {
  const u = 1 - t;
  return [0, 1].map((j) => u * u * u * p[0][j] + 3 * u * u * t * p[1][j] + 3 * u * t * t * p[2][j] + t * t * t * p[3][j]) as V2;
};
const der = (p: V2[], t: number): V2 => {
  const u = 1 - t;
  return [0, 1].map((j) => 3 * u * u * (p[1][j] - p[0][j]) + 6 * u * t * (p[2][j] - p[1][j]) + 3 * t * t * (p[3][j] - p[2][j])) as V2;
};
// near-black green -> accent green -> pale mint
const C0 = [3, 16, 7];
const C1 = [70, 200, 52];
const C2 = [226, 255, 214];
const mix = (k0: number) => {
  const k = Math.max(0, Math.min(1, k0));
  const a = k < 0.55 ? C0 : C1;
  const b = k < 0.55 ? C1 : C2;
  const q = k < 0.55 ? k / 0.55 : (k - 0.55) / 0.45;
  return `${lerp(a[0], b[0], q) | 0},${lerp(a[1], b[1], q) | 0},${lerp(a[2], b[2], q) | 0}`;
};

/**
 * The twisted ribbon of lit green slats behind the home hero (ported from the owner's one-box mockup).
 * Static single frame when the user prefers reduced motion; ~33 fps otherwise; cursor parallax.
 */
const Ribbon = forwardRef<RibbonHandle, { className?: string }>(function Ribbon({ className }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const state = useRef({ t: 0, speed: 1, tSpeed: 1, boost: 0, tBoost: 0, mx: 0, my: 0, tx: 0, ty: 0 });
  const surgeTimer = useRef<number | undefined>(undefined);
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  useImperativeHandle(ref, () => ({
    surge: (ms = 1600) => {
      if (reduce) return;
      state.current.tSpeed = 6;
      state.current.tBoost = 1;
      window.clearTimeout(surgeTimer.current);
      surgeTimer.current = window.setTimeout(() => {
        state.current.tSpeed = 1;
        state.current.tBoost = 0;
      }, ms);
    },
  }));

  useEffect(() => {
    const cv = canvasRef.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return undefined;
    const S = state.current;
    let W = 0;
    let H = 0;
    let raf = 0;
    let last = 0;
    let prev = 0;

    const size = () => {
      const r = cv.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = r.width;
      H = r.height;
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const ribbon = (P: V2[], N: number, base: number, time: number, offset: number) => {
      const phase = time * 0.00045 + offset;
      const sweep = ((time * 0.00011 + offset * 0.37) % 1.6) - 0.3; // a band of light travelling down the ribbon
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        const p = bez(P, t);
        const d = der(P, t);
        const len = Math.hypot(d[0], d[1]) || 1;
        const T: V2 = [d[0] / len, d[1] / len];
        const theta = t * 3.4 + phase; // the twist rolls along the ribbon
        const fan = 0.48 * Math.sin(theta) - 0.25;
        const nx = -T[1];
        const ny = T[0];
        const cx = nx * Math.cos(fan) - ny * Math.sin(fan);
        const cy = nx * Math.sin(fan) + ny * Math.cos(fan);
        const breathe = 1 + 0.06 * Math.sin(time * 0.0007 + t * 6);
        const half = base * breathe * (0.5 + 0.5 * Math.sin(Math.PI * Math.min(1, t * 1.12)));
        const spacing = len / (N - 1);
        const face = spacing * (0.3 + 0.42 * Math.abs(Math.sin(theta + 0.6)));
        const A: V2 = [p[0] + cx * half, p[1] + cy * half];
        const B: V2 = [p[0] - cx * half * 0.55, p[1] - cy * half * 0.55];
        const F: V2 = [T[0] * face, T[1] * face];
        const spec = Math.exp(-((t - sweep) ** 2) / 0.0035);
        const light = Math.min(1, (0.5 + 0.5 * Math.cos(theta * 1.35 + 0.9)) * 0.85 + spec * 0.8 + S.boost * 0.3);
        const fade = Math.min(1, t * 9) * Math.min(1, (1 - t) * 5);
        const gr = ctx.createLinearGradient(A[0], A[1], B[0], B[1]);
        gr.addColorStop(0, `rgba(${mix(0.6 + 0.4 * light)},${0.95 * fade})`);
        gr.addColorStop(0.4, `rgba(${mix(0.42 + 0.48 * light)},${0.95 * fade})`);
        gr.addColorStop(1, `rgba(${mix(0.1 + 0.3 * light)},${0.35 * fade})`);
        ctx.beginPath();
        ctx.moveTo(A[0], A[1]);
        ctx.lineTo(B[0], B[1]);
        ctx.lineTo(B[0] + F[0], B[1] + F[1]);
        ctx.lineTo(A[0] + F[0], A[1] + F[1]);
        ctx.closePath();
        ctx.fillStyle = gr;
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(A[0] + F[0], A[1] + F[1]);
        ctx.lineTo(B[0] + F[0], B[1] + F[1]);
        ctx.strokeStyle = `rgba(1,6,2,${0.7 * fade})`;
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(A[0], A[1]);
        ctx.lineTo(lerp(A[0], B[0], 0.7), lerp(A[1], B[1], 0.7));
        ctx.strokeStyle = `rgba(236,255,228,${(0.22 + 0.75 * light * light) * fade})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    };

    const frame = (time: number) => {
      ctx.clearRect(0, 0, W, H);
      const narrow = W < 860;
      const ux = Math.sin(time * 0.00031) * W * 0.025;
      const uy = Math.cos(time * 0.00027) * H * 0.03; // slow drift
      const px = S.mx * W * 0.05;
      const py = S.my * H * 0.05; // cursor parallax
      const glow = ctx.createRadialGradient(W * 0.5, H * 0.5, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.7);
      glow.addColorStop(0, `rgba(127,238,100,${0.07 + 0.08 * S.boost})`);
      glow.addColorStop(1, 'rgba(127,238,100,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);
      const N = narrow ? 56 : 84;
      const base = Math.min(W, 1600) * (narrow ? 0.36 : 0.27);
      const right: V2[] = narrow
        ? [[W * 0.55 + px, -H * 0.12], [W * 0.85 + ux + px, H * 0.2 + uy], [W * 0.75 - ux, H * 0.62 + py], [W * 1.15, H * 1.05]]
        : [[W * 0.6 + px, -H * 0.16], [W * 0.8 + ux + px, H * 0.2 + uy + py], [W * 0.8 - ux, H * 0.62 - uy + py], [W * 1.1, H * 1.06]];
      ribbon(right, N, base, time, 0);
    };

    const loop = (ts: number) => {
      const dt = Math.min(50, ts - (prev || ts));
      prev = ts;
      S.speed += (S.tSpeed - S.speed) * 0.05;
      S.boost += (S.tBoost - S.boost) * 0.06;
      S.mx += (S.tx - S.mx) * 0.04;
      S.my += (S.ty - S.my) * 0.04;
      S.t += dt * S.speed;
      if (ts - last > 30) {
        frame(S.t);
        last = ts;
      }
      raf = requestAnimationFrame(loop);
    };

    const onMove = (e: PointerEvent) => {
      S.tx = e.clientX / window.innerWidth - 0.5;
      S.ty = e.clientY / window.innerHeight - 0.5;
    };
    const onResize = () => {
      size();
      frame(S.t);
    };
    window.addEventListener('resize', onResize);
    size();
    frame(S.t);
    if (!reduce) {
      window.addEventListener('pointermove', onMove);
      raf = requestAnimationFrame(loop);
    }
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onMove);
      window.clearTimeout(surgeTimer.current);
    };
  }, [reduce]);

  return <canvas ref={canvasRef} aria-hidden="true" className={className} />;
});

export default Ribbon;
