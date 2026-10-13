// Pure geometry checks; no camera/browser is required.
const assert = require("node:assert/strict");
require("../web/board-measurement.js");
const span = (lengthMm, tags = 6, limit = 6) => ({
  axis: "horizontal",
  lengthMm,
  tags,
  limit,
});
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
const a = BoardMeasurement.estimate(22.3, [span(167.25)]);
close(a.gapMm, 6.69);
close(a.ratio, 0.3);
const b = BoardMeasurement.estimate(22.3, [span(167.25), span(80.28, 3)]);
close(b.ratio, 0.3);
close(b.mismatch, 0);
const scaled = BoardMeasurement.estimate(44.6, [span(334.5)]);
close(scaled.ratio, 0.3);
const inconsistent = BoardMeasurement.estimate(22.3, [
  span(167.25),
  span(172.25),
]);
assert.ok(inconsistent.mismatch > 0.01);
assert.equal(BoardMeasurement.estimate(22.3, [span(null)]), null);
assert.throws(
  () => BoardMeasurement.estimate(22.3, [span(120)]),
  /combined black tag widths/,
);
assert.throws(
  () => BoardMeasurement.estimate(22.3, [span(167.25, 7)]),
  /board dimensions/,
);
assert.throws(
  () => BoardMeasurement.estimate(22.3, [span(167.25, 1)]),
  /at least 2/,
);
close(BoardMeasurement.estimate(10, [span(65)]).ratio, 0.1);
console.log("Printed-board geometry checks passed.");
