const assert = require("node:assert/strict");
require("../web/capture-guide.js");
for (const step of CaptureGuide.steps) {
  const p = CaptureGuide.points(step, 1.6, 1);
  assert.ok(p.every((v) => v.every(Number.isFinite)));
  assert.ok(CaptureGuide.match(p, step, 1.6, 1).ok, step.id);
}
const center = CaptureGuide.steps[0],
  p = CaptureGuide.points(center, 1.6, 1);
assert.equal(
  CaptureGuide.match(
    p.map(([x, y]) => [x + 0.3, y]),
    center,
    1.6,
    1,
  ).ok,
  false,
);
assert.equal(
  CaptureGuide.match(
    p,
    CaptureGuide.steps.find((s) => s.id === "yaw-left"),
    1.6,
    1,
  ).ok,
  false,
);
assert.equal(CaptureGuide.match(null, center, 1.6, 1).ok, false);
assert.ok(CaptureGuide.steps.some((s) => s.validation && s.shots >= 5));
console.log("Capture placement checks passed.");
