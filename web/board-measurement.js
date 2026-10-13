/* Pure millimetre geometry, shared by the UI and numerical tests. */
globalThis.BoardMeasurement = {
  estimate(tagMm, spans) {
    if (!Number.isFinite(tagMm) || tagMm <= 0)
      throw Error("Enter a positive measured tag size.");
    const directions = spans
      .filter((v) => v.lengthMm !== null)
      .map((v) => {
        if (!Number.isInteger(v.tags) || v.tags < 2 || v.tags > v.limit)
          throw Error("Count at least 2 tags, within the board dimensions.");
        if (!Number.isFinite(v.lengthMm) || v.lengthMm <= v.tags * tagMm)
          throw Error(
            "Measured span must exceed the combined black tag widths. Measure first outer black edge to last outer black edge.",
          );
        return {
          ...v,
          gapMm: (v.lengthMm - v.tags * tagMm) / (v.tags - 1),
          pitchMm: (v.lengthMm - tagMm) / (v.tags - 1),
        };
      });
    if (!directions.length) return null;
    const intervals = directions.reduce((sum, v) => sum + v.tags - 1, 0);
    const gapMm =
      directions.reduce((sum, v) => sum + (v.tags - 1) * v.gapMm, 0) /
      intervals;
    const ratio = gapMm / tagMm;
    if (ratio < 0.1 - 1e-10 || ratio > 1 + 1e-10)
      throw Error(
        "Measured gap is outside this target’s supported range (10–100% of tag size). Check the span and tag count.",
      );
    const mismatch =
      directions.length === 2
        ? Math.abs(directions[0].pitchMm - directions[1].pitchMm) /
          ((directions[0].pitchMm + directions[1].pitchMm) / 2)
        : 0;
    return { gapMm, ratio, directions, mismatch };
  },
};
