'use client';

/**
 * BoilerScene — a live 3D cutaway of BOILER-01 built entirely from Three.js
 * primitives (no external model file). Every part is driven by the same
 * telemetry + AI-control data the rest of the dashboard consumes.
 *
 * The front half of the drum is clipped away so the interior (water level,
 * fire tubes, flame) is visible. An "AI autopilot" layer visualises the
 * closed-loop control acting on the boiler: flame throttling, soot-blow
 * sweeps, setpoint callouts, and an intervention pulse.
 *
 * Fully self-contained and additive — touches no other file.
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useNexusStore } from '@/lib/store';
import type { TelemetryTags, OperatingMode, ControlState } from '@/types/telemetry';

// ── numeric + color helpers ─────────────────────────────────────────────
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const norm = (v: number, lo: number, hi: number) => clamp((v - lo) / (hi - lo), 0, 1);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const C = {
  green: new THREE.Color('#22c55e'),
  amber: new THREE.Color('#f59e0b'),
  red: new THREE.Color('#ef4444'),
  grey: new THREE.Color('#6b7280'),
  blue: new THREE.Color('#3b82f6'),
  yellow: new THREE.Color('#eab308'),
  cyan: new THREE.Color('#22d3ee'),
  water: new THREE.Color('#2563eb'),
  white: new THREE.Color('#e2e8f0'),
};

function healthColor(out: THREE.Color, health: number) {
  if (health >= 70) out.copy(C.amber).lerp(C.green, norm(health, 70, 100));
  else out.copy(C.red).lerp(C.amber, norm(health, 40, 70));
  return out;
}
function flueColor(out: THREE.Color, temp: number) {
  const t = norm(temp, 160, 320);
  if (t < 0.5) out.copy(C.grey).lerp(C.amber, t / 0.5);
  else out.copy(C.amber).lerp(C.red, (t - 0.5) / 0.5);
  return out;
}
function o2Color(out: THREE.Color, o2: number) {
  if (o2 < 3) out.copy(C.blue).lerp(C.green, norm(o2, 1.5, 3));
  else out.copy(C.green).lerp(C.yellow, norm(o2, 3, 5));
  return out;
}

// ── props: external control override + intervention signal ───────────────
export interface BoilerActionSignal {
  id: number;            // bump to fire a transient intervention animation
  sootBlow: boolean;
  firingReductionPct: number;
}
interface BoilerSceneProps {
  controlOverride?: ControlState | null;   // when set, drives the autopilot layer instead of the store
  actionSignal?: BoilerActionSignal | null;
}

const DRUM_LEN = 7;
const DRUM_R = 2.2;
const STEAM_COUNT = 150;
const SOOT_DUR = 2.2;
const PULSE_DUR = 1.5;

export function BoilerScene({ controlOverride = null, actionSignal = null }: BoilerSceneProps) {
  const mountRef = useRef<HTMLDivElement>(null);

  // Live data read every frame without rebuilding the scene
  const tagsRef = useRef<TelemetryTags | null>(null);
  const modeRef = useRef<OperatingMode>('NORMAL');
  const ctrlOverrideRef = useRef<ControlState | null>(null);
  const storeCtrlRef = useRef<ControlState | null>(null);
  const triggerFxRef = useRef<((sootBlow: boolean) => void) | null>(null);

  const tags = useNexusStore((s) => s.tags);
  const mode = useNexusStore((s) => s.mode);
  const storeControl = useNexusStore((s) => s.controlState);
  const storeActions = useNexusStore((s) => s.controlActions);

  useEffect(() => { tagsRef.current = tags; }, [tags]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { ctrlOverrideRef.current = controlOverride; }, [controlOverride]);
  useEffect(() => { storeCtrlRef.current = storeControl; }, [storeControl]);

  // Fire the intervention animation when a simulated signal arrives…
  const lastSig = useRef(0);
  useEffect(() => {
    if (actionSignal && actionSignal.id !== lastSig.current) {
      lastSig.current = actionSignal.id;
      triggerFxRef.current?.(actionSignal.sootBlow);
    }
  }, [actionSignal]);

  // …or when a real control_action lands in the store
  const lastLen = useRef(0);
  useEffect(() => {
    if (storeActions.length > lastLen.current) {
      const a = storeActions[storeActions.length - 1];
      lastLen.current = storeActions.length;
      triggerFxRef.current?.(!!a?.soot_blow);
    } else {
      lastLen.current = storeActions.length;
    }
  }, [storeActions]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let W = mount.clientWidth || 800;
    let H = mount.clientHeight || 560;

    // ── renderer / scene / camera ──────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(W, H);
    renderer.localClippingEnabled = true; // for the cutaway
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x0a0e14, 0.01);

    const camera = new THREE.PerspectiveCamera(46, W / H, 0.1, 200);
    camera.position.set(8.5, 5.5, 13);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 8;
    controls.maxDistance = 42;
    controls.target.set(0, 0.2, -0.4);

    // ── lighting (brighter so the interior reads clearly) ──────────────
    const ambient = new THREE.AmbientLight(0xffffff, 0.85);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 1.25);
    key.position.set(9, 13, 8);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xbcd4ff, 0.6);
    fill.position.set(-9, 5, 6);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.5);
    rim.position.set(-6, 4, -10);
    scene.add(rim);
    // interior light so the inside of the opened drum isn't in shadow
    const interior = new THREE.PointLight(0xfff2dd, 0.7, 22);
    interior.position.set(0, 0.5, 1.5);
    scene.add(interior);
    // efficiency "health" glow
    const glow = new THREE.PointLight(0x22c55e, 0.7, 30);
    glow.position.set(0, 4, 5);
    scene.add(glow);

    const root = new THREE.Group();
    scene.add(root);

    // ── cutaway clipping planes (only on drum internals) ───────────────
    const cutPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0); // keep z <= 0
    const levelPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0); // keep y <= constant

    // ── drum shell ─────────────────────────────────────────────────────
    const shellMat = new THREE.MeshStandardMaterial({
      color: 0xaab4c0, metalness: 0.85, roughness: 0.3,
      transparent: true, opacity: 0.22, side: THREE.DoubleSide,
      clippingPlanes: [cutPlane], emissive: 0x000000,
    });
    const shell = new THREE.Mesh(
      new THREE.CylinderGeometry(DRUM_R, DRUM_R, DRUM_LEN, 56, 1, true),
      shellMat,
    );
    shell.rotation.z = Math.PI / 2;
    root.add(shell);

    // visible inner back wall so the cut interior reads as a surface
    const innerMat = new THREE.MeshStandardMaterial({
      color: 0x39424f, metalness: 0.5, roughness: 0.7, side: THREE.BackSide,
      clippingPlanes: [cutPlane],
    });
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(DRUM_R * 0.99, DRUM_R * 0.99, DRUM_LEN * 0.99, 56, 1, true), innerMat);
    inner.rotation.z = Math.PI / 2;
    root.add(inner);

    // end caps
    const capMat = new THREE.MeshStandardMaterial({ color: 0x55606e, metalness: 0.8, roughness: 0.4, side: THREE.DoubleSide, clippingPlanes: [cutPlane] });
    [-1, 1].forEach((s) => {
      const cap = new THREE.Mesh(new THREE.RingGeometry(0.28, DRUM_R, 48), capMat);
      cap.rotation.y = Math.PI / 2;
      cap.position.x = (s * DRUM_LEN) / 2;
      root.add(cap);
    });

    // ── water body (cut by cutPlane AND levelPlane → flat top surface) ──
    const waterMat = new THREE.MeshStandardMaterial({
      color: C.water, metalness: 0.2, roughness: 0.2,
      transparent: true, opacity: 0.82, emissive: 0x0b2f6b, emissiveIntensity: 0.35,
      clippingPlanes: [cutPlane, levelPlane], clipIntersection: false, side: THREE.DoubleSide,
    });
    const water = new THREE.Mesh(
      new THREE.CylinderGeometry(DRUM_R * 0.95, DRUM_R * 0.95, DRUM_LEN * 0.97, 48),
      waterMat,
    );
    water.rotation.z = Math.PI / 2;
    root.add(water);

    // ── fire tubes ──────────────────────────────────────────────────────
    const tubeMat = new THREE.MeshStandardMaterial({
      color: C.green, metalness: 0.55, roughness: 0.35,
      emissive: C.green, emissiveIntensity: 0.12, clippingPlanes: [cutPlane],
    });
    const tubeGeo = new THREE.CylinderGeometry(0.24, 0.24, DRUM_LEN * 0.9, 18);
    const tubePos: [number, number][] = [];
    for (let r = 0.65; r <= 1.55; r += 0.45) {
      const count = Math.max(6, Math.round((2 * Math.PI * r) / 0.6));
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        tubePos.push([Math.cos(a) * r, Math.sin(a) * r - 0.3]);
      }
    }
    tubePos.forEach(([y, z]) => {
      const tube = new THREE.Mesh(tubeGeo, tubeMat);
      tube.rotation.z = Math.PI / 2;
      tube.position.set(0, y, z);
      root.add(tube);
    });

    // ── burner + flame + O2 trim ring (front face, NOT clipped) ─────────
    const burner = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.72, 1.2, 28),
      new THREE.MeshStandardMaterial({ color: 0x3a3f47, metalness: 0.7, roughness: 0.5 }),
    );
    burner.rotation.z = Math.PI / 2;
    burner.position.set(DRUM_LEN / 2 + 0.6, -0.6, 0);
    root.add(burner);

    const o2Mat = new THREE.MeshStandardMaterial({ color: C.green, emissive: C.green, emissiveIntensity: 0.8, metalness: 0.3, roughness: 0.4 });
    const o2Ring = new THREE.Mesh(new THREE.TorusGeometry(0.74, 0.09, 18, 44), o2Mat);
    o2Ring.position.set(DRUM_LEN / 2 + 1.15, -0.6, 0);
    o2Ring.rotation.y = Math.PI / 2;
    root.add(o2Ring);

    const flameMat = new THREE.MeshStandardMaterial({
      color: 0xff8c1a, emissive: 0xff6a00, emissiveIntensity: 1.8,
      transparent: true, opacity: 0.95,
    });
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.6, 2.6, 28), flameMat);
    flame.rotation.z = -Math.PI / 2;
    flame.position.set(DRUM_LEN / 2 - 0.7, -0.6, 0);
    root.add(flame);
    const flameCore = new THREE.Mesh(
      new THREE.ConeGeometry(0.3, 1.6, 20),
      new THREE.MeshBasicMaterial({ color: 0xffe39a, transparent: true, opacity: 0.9 }),
    );
    flameCore.rotation.z = -Math.PI / 2;
    flameCore.position.set(DRUM_LEN / 2 - 1.1, -0.6, 0);
    root.add(flameCore);
    const flameLight = new THREE.PointLight(0xff7a1a, 0, 16);
    flameLight.position.set(DRUM_LEN / 2 - 1.6, -0.6, 0);
    root.add(flameLight);

    // ── chimney / stack ─────────────────────────────────────────────────
    const stackMat = new THREE.MeshStandardMaterial({ color: C.grey, metalness: 0.6, roughness: 0.6 });
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.62, 6, 30), stackMat);
    stack.position.set(-DRUM_LEN / 2 + 0.5, DRUM_R + 2.7, 0);
    root.add(stack);
    const stackElbow = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.8, 26), stackMat);
    stackElbow.position.set(-DRUM_LEN / 2 + 0.5, DRUM_R + 0.5, 0);
    root.add(stackElbow);

    // ── steam outlet + particle plume ───────────────────────────────────
    const outlet = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.3, 2.0, 22),
      new THREE.MeshStandardMaterial({ color: 0x8a939e, metalness: 0.7, roughness: 0.4 }),
    );
    outlet.position.set(DRUM_LEN / 2 - 1.7, DRUM_R + 1.0, 0);
    root.add(outlet);

    const steamGeo = new THREE.BufferGeometry();
    const steamPos = new Float32Array(STEAM_COUNT * 3);
    const steamVel = new Float32Array(STEAM_COUNT);
    const sBaseX = DRUM_LEN / 2 - 1.7;
    const sBaseY = DRUM_R + 2.1;
    for (let i = 0; i < STEAM_COUNT; i++) {
      steamPos[i * 3] = sBaseX + Math.sin(i * 1.7) * 0.22;
      steamPos[i * 3 + 1] = sBaseY + (i / STEAM_COUNT) * 3;
      steamPos[i * 3 + 2] = Math.cos(i * 2.3) * 0.22;
      steamVel[i] = 0.01 + (i % 7) * 0.002;
    }
    steamGeo.setAttribute('position', new THREE.BufferAttribute(steamPos, 3));
    const steamMat = new THREE.PointsMaterial({ color: 0xdfe6ee, size: 0.26, transparent: true, opacity: 0.6, depthWrite: false });
    const steam = new THREE.Points(steamGeo, steamMat);
    root.add(steam);

    // ── feedwater pipe + traveling droplet ──────────────────────────────
    const feedMat = new THREE.LineDashedMaterial({ color: 0x38bdf8, dashSize: 0.4, gapSize: 0.22, transparent: true });
    const feedPts = [
      new THREE.Vector3(-DRUM_LEN / 2 - 2.6, -2.7, 1.7),
      new THREE.Vector3(-DRUM_LEN / 2 - 0.5, -2.7, 1.7),
      new THREE.Vector3(-DRUM_LEN / 2 - 0.5, -0.8, 1.1),
      new THREE.Vector3(-DRUM_LEN / 2 + 0.7, 0.2, 0.5),
    ];
    const feedLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(feedPts), feedMat);
    feedLine.computeLineDistances();
    root.add(feedLine);
    const feedCurve = new THREE.CatmullRomCurve3(feedPts);
    const feedDrop = new THREE.Mesh(
      new THREE.SphereGeometry(0.17, 14, 14),
      new THREE.MeshStandardMaterial({ color: 0x7dd3fc, emissive: 0x38bdf8, emissiveIntensity: 1.0 }),
    );
    root.add(feedDrop);

    // ── AUTOPILOT layer ─────────────────────────────────────────────────
    // rotating halo ring on the ground that glows when autopilot is active
    const haloMat = new THREE.MeshBasicMaterial({ color: C.cyan, transparent: true, opacity: 0.0, side: THREE.DoubleSide });
    const halo = new THREE.Mesh(new THREE.TorusGeometry(DRUM_LEN * 0.62, 0.06, 12, 80), haloMat);
    halo.rotation.x = Math.PI / 2;
    halo.position.y = -DRUM_R - 2.9;
    root.add(halo);
    // orbiting "scanner" node that circles the boiler while controlling
    const scanner = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 14, 14),
      new THREE.MeshBasicMaterial({ color: C.cyan }),
    );
    const scannerLight = new THREE.PointLight(0x22d3ee, 0, 8);
    root.add(scanner);
    root.add(scannerLight);
    // expanding "ping" ring fired on each intervention
    const pingMat = new THREE.MeshBasicMaterial({ color: C.cyan, transparent: true, opacity: 0, side: THREE.DoubleSide });
    const ping = new THREE.Mesh(new THREE.TorusGeometry(1, 0.08, 10, 60), pingMat);
    ping.rotation.x = Math.PI / 2;
    ping.position.y = -DRUM_R - 2.85;
    root.add(ping);
    // soot-blow sweep plane that travels across the tube bank
    const sootMat = new THREE.MeshBasicMaterial({ color: 0xbfefff, transparent: true, opacity: 0, side: THREE.DoubleSide });
    const soot = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), sootMat);
    soot.rotation.y = Math.PI / 2;
    soot.visible = false;
    root.add(soot);

    // ground grid
    const grid = new THREE.GridHelper(44, 44, 0x223046, 0x131a24);
    grid.position.y = -DRUM_R - 3;
    scene.add(grid);

    // ── HTML label layer (projected each frame) ─────────────────────────
    const labelLayer = document.createElement('div');
    labelLayer.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;';
    mount.appendChild(labelLayer);

    const VARIANTS: Record<string, string> = {
      component: 'background:rgba(10,14,20,0.72);color:#cbd5e1;border:1px solid rgba(148,163,184,0.25);',
      auto: 'background:rgba(8,40,48,0.86);color:#67e8f9;border:1px solid rgba(34,211,238,0.55);box-shadow:0 0 14px rgba(34,211,238,0.25);',
      warn: 'background:rgba(48,30,5,0.86);color:#fbbf24;border:1px solid rgba(251,191,36,0.55);',
      soot: 'background:rgba(6,40,22,0.88);color:#4ade80;border:1px solid rgba(74,222,128,0.6);',
    };
    function mkLabel(text: string, variant: keyof typeof VARIANTS) {
      const el = document.createElement('div');
      el.textContent = text;
      el.style.cssText = `position:absolute;top:0;left:0;white-space:nowrap;font:600 10.5px/1.2 ui-sans-serif,system-ui;padding:3px 8px;border-radius:7px;letter-spacing:0.02em;backdrop-filter:blur(4px);display:none;${VARIANTS[variant]}`;
      labelLayer.appendChild(el);
      return el;
    }
    const lblDrum = mkLabel('Steam drum', 'component');
    const lblTubes = mkLabel('Fire tubes', 'component');
    const lblFlame = mkLabel('Burner / flame', 'component');
    const lblO2 = mkLabel('O₂ trim ring', 'component');
    const lblStack = mkLabel('Flue stack', 'component');
    const lblOutlet = mkLabel('Steam outlet', 'component');
    const lblFeed = mkLabel('Feedwater', 'component');
    const lblLevel = mkLabel('Water level', 'component');
    const lblAuto = mkLabel('● AUTOPILOT', 'auto');
    const lblFiring = mkLabel('AI ↓ firing', 'warn');
    const lblO2sp = mkLabel('O₂ target', 'auto');
    const lblPsp = mkLabel('P target', 'auto');
    const lblSoot = mkLabel('💨 SOOT BLOW', 'soot');

    const proj = new THREE.Vector3();
    function place(el: HTMLDivElement, x: number, y: number, z: number, visible: boolean) {
      if (!visible) { el.style.display = 'none'; return; }
      proj.set(x, y, z).project(camera);
      if (proj.z > 1) { el.style.display = 'none'; return; }
      const sx = (proj.x * 0.5 + 0.5) * W;
      const sy = (-proj.y * 0.5 + 0.5) * H;
      el.style.display = 'block';
      el.style.transform = `translate(-50%,-50%) translate(${sx}px,${sy}px)`;
    }

    // ── transient effect state ──────────────────────────────────────────
    const fx = { soot: 0, ping: 0 };
    const triggerFx = (sootBlow: boolean) => {
      fx.ping = PULSE_DUR;
      if (sootBlow) fx.soot = SOOT_DUR;
    };
    triggerFxRef.current = triggerFx;

    // ── animation loop ──────────────────────────────────────────────────
    const tmp = new THREE.Color();
    const clock = new THREE.Clock();
    let dropT = 0;
    let scanA = 0;
    let disposed = false;
    let raf = 0;

    const animate = () => {
      if (disposed) return;
      raf = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;
      controls.update();

      const tg = tagsRef.current;
      const m = modeRef.current;
      const ctrl = ctrlOverrideRef.current ?? storeCtrlRef.current;
      const autopilot = !!ctrl?.autopilot;
      const firingRed = ctrl?.firing_reduction_pct ?? 0;
      const o2sp = ctrl?.o2_setpoint ?? 0;
      const psp = ctrl?.pressure_setpoint ?? 0;
      const faulting = m === 'CRITICAL' || m === 'FAULT';
      const blink = 0.5 + 0.5 * Math.sin(t * 6);

      let levelY = -DRUM_R + DRUM_R * 0.9; // default mid

      if (tg) {
        // drum_level → water level plane
        const fillN = norm(tg.drum_level, 80, 480);
        levelY = lerp(-DRUM_R * 0.92, DRUM_R * 0.55, fillN);
        levelPlane.constant = levelY;
        const lowWater = tg.drum_level < 200;
        waterMat.color.copy(C.water);
        if (lowWater) waterMat.color.lerp(C.red, blink * 0.85);
        waterMat.emissiveIntensity = lowWater ? 0.35 + blink * 0.6 : 0.35;

        // tube_health → tube color (+ soot-blow override below)
        if (fx.soot <= 0) {
          healthColor(tmp, tg.tube_health);
          tubeMat.color.copy(tmp);
          tubeMat.emissive.copy(tmp);
          tubeMat.emissiveIntensity = tg.tube_health < 70 ? 0.2 + blink * 0.35 : 0.12;
        }

        // flame_status + AI firing reduction → flame size + burner light
        const lit = tg.flame_status > 0.5;
        flame.visible = lit;
        flameCore.visible = lit;
        const firingScale = 1 - clamp(firingRed, 0, 45) / 100; // AI throttles the flame
        const flick = 0.9 + Math.sin(t * 16) * 0.06;
        flame.scale.setScalar(firingScale * flick);
        flameCore.scale.setScalar(firingScale * (0.85 + Math.sin(t * 22) * 0.08));
        flameLight.intensity = lit ? (2.4 + Math.sin(t * 20) * 0.5) * firingScale : 0;

        // Stack temperature shows heat; inadequate furnace draft overrides to red.
        const draftUnsafe = tg.furnace_pressure_pa != null && tg.furnace_pressure_pa > -5;
        stackMat.color.copy(draftUnsafe ? C.red : flueColor(tmp, tg.flue_gas_temp));
        stackMat.emissive.copy(draftUnsafe ? C.red : tmp).multiplyScalar(draftUnsafe ? 0.7 : 0.35);

        // o2_percent (live) blends toward the AI setpoint when autopilot on
        const o2shown = autopilot ? lerp(tg.o2_percent, o2sp, 0.6) : tg.o2_percent;
        o2Color(tmp, o2shown);
        o2Mat.color.copy(tmp);
        o2Mat.emissive.copy(tmp);

        // efficiency → health glow
        const effN = norm(tg.efficiency, 65, 95);
        glow.color.copy(C.red).lerp(C.green, effN);
        glow.intensity = lerp(0.3, 1.1, effN);

        // steam_pressure → plume speed + tint
        const presN = norm(tg.steam_pressure, 8, 13);
        const spd = lerp(0.012, 0.06, presN);
        steamMat.color.copy(C.grey).lerp(C.red, clamp((presN - 0.6) / 0.4, 0, 1)).lerp(C.white, 0.4);
        const arr = (steam.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
        for (let i = 0; i < STEAM_COUNT; i++) {
          arr[i * 3 + 1] += steamVel[i] + spd;
          arr[i * 3] += Math.sin(t * 2 + i) * 0.003;
          if (arr[i * 3 + 1] > sBaseY + 3.2) {
            arr[i * 3 + 1] = sBaseY;
            arr[i * 3] = sBaseX + Math.sin(i * 1.7) * 0.22;
          }
        }
        steam.geometry.getAttribute('position').needsUpdate = true;
        steam.visible = tg.steam_flow > 1 || presN > 0;

        // feedwater_flow → droplet travel speed
        const flowN = norm(tg.feedwater_flow, 0, 60);
        dropT = (dropT + (0.04 + flowN * 0.14) * dt + 0.0005) % 1;
        feedCurve.getPointAt(dropT, feedDrop.position);
        feedDrop.visible = tg.feedwater_flow > 1;
        feedMat.opacity = tg.feedwater_flow > 1 ? 0.9 : 0.3;

        // global fault tint on the shell
        shellMat.emissive.copy(C.red).multiplyScalar(faulting ? blink * 0.5 : 0);
      } else {
        levelPlane.constant = levelY;
        flame.visible = false; flameCore.visible = false; flameLight.intensity = 0;
      }

      // ── autopilot visuals ─────────────────────────────────────────────
      // halo brightness + scanner orbit while controlling
      haloMat.opacity = lerp(haloMat.opacity, autopilot ? 0.35 + blink * 0.25 : 0.0, 0.1);
      halo.rotation.z += dt * 0.4;
      scanA += dt * (autopilot ? 1.4 : 0.0);
      const sr = DRUM_LEN * 0.62;
      scanner.position.set(Math.cos(scanA) * sr, -DRUM_R - 2.9, Math.sin(scanA) * sr);
      scanner.visible = autopilot;
      scannerLight.position.copy(scanner.position);
      scannerLight.intensity = autopilot ? 1.2 : 0;
      // subtle cyan rim on the drum while autopilot engaged (and not faulting)
      if (!faulting) shellMat.emissive.copy(C.cyan).multiplyScalar(autopilot ? 0.12 + blink * 0.06 : 0);

      // intervention ping
      if (fx.ping > 0) {
        fx.ping -= dt;
        const p = 1 - fx.ping / PULSE_DUR; // 0→1
        ping.scale.setScalar(lerp(1, DRUM_LEN * 0.9, p));
        pingMat.opacity = (1 - p) * 0.7;
        ping.visible = true;
      } else ping.visible = false;

      // soot-blow sweep
      if (fx.soot > 0) {
        fx.soot -= dt;
        const p = 1 - fx.soot / SOOT_DUR; // 0→1 travels along drum
        soot.visible = true;
        soot.position.set(lerp(-DRUM_LEN / 2, DRUM_LEN / 2, p), -0.2, 0);
        sootMat.opacity = Math.sin(p * Math.PI) * 0.6;
        // tubes flash bright then settle to healthy green
        tubeMat.color.copy(C.white).lerp(C.green, p);
        tubeMat.emissive.copy(C.white).lerp(C.green, p);
        tubeMat.emissiveIntensity = 0.5 * (1 - p) + 0.2;
      } else {
        soot.visible = false;
      }

      // ── labels ────────────────────────────────────────────────────────
      place(lblDrum, 0, DRUM_R + 0.35, -0.2, true);
      place(lblTubes, 0, -0.1, -1.4, true);
      place(lblFlame, DRUM_LEN / 2 + 0.4, 0.5, 0, true);
      place(lblO2, DRUM_LEN / 2 + 1.15, -1.55, 0, true);
      place(lblStack, -DRUM_LEN / 2 + 0.5, DRUM_R + 5.4, 0, true);
      place(lblOutlet, DRUM_LEN / 2 - 1.7, DRUM_R + 1.9, 0, true);
      place(lblFeed, -DRUM_LEN / 2 - 2.6, -2.3, 1.7, true);
      place(lblLevel, 0, levelY, -1.9, !!tg);

      lblAuto.style.borderColor = 'rgba(34,211,238,0.55)';
      place(lblAuto, 0, DRUM_R + 1.5, 0, autopilot);
      lblFiring.textContent = `AI ↓ firing −${firingRed.toFixed(0)}%`;
      place(lblFiring, DRUM_LEN / 2 - 0.9, 1.2, 0, autopilot && firingRed > 0);
      lblO2sp.textContent = `O₂ target ${o2sp.toFixed(1)}%`;
      place(lblO2sp, DRUM_LEN / 2 + 1.7, -2.0, 0, autopilot);
      lblPsp.textContent = `P target ${psp.toFixed(1)} bar`;
      place(lblPsp, DRUM_LEN / 2 - 1.7, DRUM_R + 2.7, 0, autopilot);
      place(lblSoot, 0, DRUM_R + 0.9, 0.4, fx.soot > 0);

      renderer.render(scene, camera);
    };
    animate();

    // ── resize ──────────────────────────────────────────────────────────
    const onResize = () => {
      W = mount.clientWidth || 800;
      H = mount.clientHeight || 560;
      camera.aspect = W / H;
      camera.updateProjectionMatrix();
      renderer.setSize(W, H);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    // ── cleanup ─────────────────────────────────────────────────────────
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      triggerFxRef.current = null;
      controls.dispose();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
        else if (mat) mat.dispose();
      });
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      if (labelLayer.parentNode === mount) mount.removeChild(labelLayer);
    };
  }, []);

  return <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />;
}
