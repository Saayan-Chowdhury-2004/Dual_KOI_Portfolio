import assert from "node:assert/strict";
import test from "node:test";
import { computeDynamicAgeBreakdown } from "../src/koi/portfolioData.ts";
import { koiAngleDiff, koiClamp, mulberry32 } from "../src/koi/koiMath.ts";
import { PondWorld, DEFAULT_KOI_CONFIG } from "../src/koi/pondWorld.ts";
import { evaluateRippleTile, buildRippleFieldConfig, computeVirtualCenter } from "../src/koi/rippleField.ts";

test("computeDynamicAgeBreakdown computes exact elapsed years, months, days, and time", () => {
  const ref = new Date(2026, 10, 25, 15, 30, 45); // Nov 25, 2026 15:30:45 (born Feb 18, 2004)
  const age = computeDynamicAgeBreakdown(ref);
  assert.equal(age.years, 22);
  assert.equal(age.months, 9);
  assert.equal(age.days, 7);
  assert.equal(age.hours, 15);
  assert.equal(age.minutes, 30);
  assert.equal(age.seconds, 45);
});

test("koiMath helpers clamp, wrap angles, and produce deterministic PRNG", () => {
  assert.equal(koiClamp(-5, 0, 10), 0);
  assert.equal(koiClamp(15, 0, 10), 10);
  assert.equal(koiClamp(4, 0, 10), 4);

  const diff = koiAngleDiff(Math.PI - 0.1, -Math.PI + 0.1);
  assert.ok(Math.abs(diff - 0.2) < 1e-6);

  const r1 = mulberry32(42);
  const r2 = mulberry32(42);
  assert.equal(r1(), r2());
  assert.equal(r1(), r2());
});

test("PondWorld seeds, steps, and clamps bounds on resize without NaNs", () => {
  const world = new PondWorld({ ...DEFAULT_KOI_CONFIG });
  world.resize(1280, 720);
  assert.equal(world.koi.length, 4);
  assert.ok(world.fish.length >= 120);

  for (let i = 0; i < 10; i++) {
    world.step(1 / 60);
  }
  world.setSimulationBounds(640, 480);
  assert.equal(world.width, 640);
  assert.equal(world.height, 480);

  for (const koi of world.koi) {
    assert.ok(Number.isFinite(koi.x) && Number.isFinite(koi.y));
  }
});

test("rippleField evaluates bounded progress and extrusion", () => {
  const bounds = { minX: 0, minY: 0, maxX: 800, maxY: 600 };
  const origin = computeVirtualCenter(bounds, { x: 400, y: 300 }, false);
  const cfg = buildRippleFieldConfig(0.5, origin, bounds, 20, false);
  const sample = evaluateRippleTile(400, 300, 0.5, origin, cfg);
  assert.ok(sample.reveal >= 0 && sample.reveal <= 1);
  assert.ok(Number.isFinite(sample.height));
});
