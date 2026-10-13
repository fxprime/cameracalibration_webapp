/* Editable capture plan; silhouette checks are approximate 2D guidance only. */
globalThis.CaptureGuide = {
  steps: [
    {
      id: "center",
      title: "Center the board",
      text: "Match the outline. Keep the board flat, hold still, and save two sharp views with a small change between them.",
      cx: 0.5,
      cy: 0.5,
      scale: 0.6,
    },
    {
      id: "upper-left",
      title: "Move to the upper-left",
      text: "Move the board into the outline near the upper-left edge. Keep all checkerboard corners visible.",
      cx: 0.23,
      cy: 0.23,
      scale: 0.38,
    },
    {
      id: "upper-right",
      title: "Move to the upper-right",
      text: "Move the board to this corner. Hold it still before each capture.",
      cx: 0.77,
      cy: 0.23,
      scale: 0.38,
    },
    {
      id: "lower-right",
      title: "Move to the lower-right",
      text: "Cover the lower-right image area; keep glare away from the tags.",
      cx: 0.77,
      cy: 0.77,
      scale: 0.38,
    },
    {
      id: "lower-left",
      title: "Move to the lower-left",
      text: "Cover this edge with sharp, visible corners. Change the position a little between captures.",
      cx: 0.23,
      cy: 0.77,
      scale: 0.38,
    },
    {
      id: "yaw-left",
      title: "Tilt around the vertical axis",
      text: "Turn the board so its left edge appears shorter than its right edge. Aim for a clear perspective skew, roughly 20–40°.",
      cx: 0.5,
      cy: 0.5,
      scale: 0.65,
      yaw: -0.4,
    },
    {
      id: "yaw-right",
      title: "Tilt the other way",
      text: "Now make the right edge appear shorter. Hold the board still; do not keep repeating the previous tilt.",
      cx: 0.5,
      cy: 0.5,
      scale: 0.65,
      yaw: 0.4,
    },
    {
      id: "pitch-up",
      title: "Tilt around the horizontal axis",
      text: "Tip the board so its top edge appears shorter than its bottom edge. Match the trapezoid.",
      cx: 0.5,
      cy: 0.5,
      scale: 0.65,
      pitch: -0.4,
    },
    {
      id: "pitch-down",
      title: "Reverse that tilt",
      text: "Tip it the other way so its bottom edge appears shorter than its top edge.",
      cx: 0.5,
      cy: 0.5,
      scale: 0.65,
      pitch: 0.4,
    },
    {
      id: "roll-left",
      title: "Rotate the board counterclockwise",
      text: "Keep the board approximately facing the camera and rotate it within the image to match the outline.",
      cx: 0.5,
      cy: 0.5,
      scale: 0.55,
      roll: -25,
    },
    {
      id: "roll-right",
      title: "Rotate clockwise",
      text: "Rotate the opposite way. Keep the board sharp and inside the image.",
      cx: 0.5,
      cy: 0.5,
      scale: 0.55,
      roll: 25,
    },
    {
      id: "near",
      title: "Capture a closer view",
      text: "Move closer until the board fills the large outline. Keep every required corner visible and in focus.",
      cx: 0.5,
      cy: 0.5,
      scale: 0.8,
    },
    {
      id: "far",
      title: "Capture a farther view",
      text: "Move farther away to match the smaller outline. Tags must still have enough pixels for sharp detection.",
      cx: 0.5,
      cy: 0.5,
      scale: 0.32,
    },
    {
      id: "validation",
      title: "Save six fresh validation views",
      text: "Use new positions, distances and tilts. These images check the result and never fit the camera intrinsics. The outline is only a starting position here.",
      cx: 0.5,
      cy: 0.5,
      scale: 0.55,
      validation: true,
      shots: 6,
    },
  ],
  points(step, aspect = 1.6, boardAspect = 1) {
    let hw = (step.scale * Math.min(1, 1 / aspect)) / 2,
      hh = (hw * aspect) / boardAspect;
    let p = [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ];
    if (step.yaw) {
      const shortened = step.yaw < 0 ? [0, 3] : [1, 2];
      shortened.forEach((i) => (p[i][1] *= 1 - Math.abs(step.yaw)));
    }
    if (step.pitch) {
      const shortened = step.pitch < 0 ? [0, 1] : [2, 3];
      shortened.forEach((i) => (p[i][0] *= 1 - Math.abs(step.pitch)));
    }
    const a = ((step.roll || 0) * Math.PI) / 180;
    return p.map(([x, y]) => [
      step.cx + x * Math.cos(a) - (y * Math.sin(a)) / aspect,
      step.cy + x * Math.sin(a) * aspect + y * Math.cos(a),
    ]);
  },
  shape(p, aspect) {
    const distance = (a, b) => Math.hypot((a[0] - b[0]) * aspect, a[1] - b[1]);
    return {
      cx: p.reduce((s, v) => s + v[0], 0) / 4,
      cy: p.reduce((s, v) => s + v[1], 0) / 4,
      area:
        Math.abs(
          p.reduce(
            (s, v, i) =>
              s + v[0] * p[(i + 1) % 4][1] - v[1] * p[(i + 1) % 4][0],
            0,
          ),
        ) / 2,
      roll:
        (Math.atan2(p[1][1] - p[0][1], (p[1][0] - p[0][0]) * aspect) * 180) /
        Math.PI,
      yaw: Math.log(distance(p[0], p[3]) / distance(p[1], p[2])),
      pitch: Math.log(distance(p[0], p[1]) / distance(p[3], p[2])),
    };
  },
  match(outline, step, aspect, boardAspect) {
    if (!outline)
      return {
        ok: false,
        hint: "Board silhouette unavailable; follow the outline visually or move to the next placement manually.",
      };
    if (step.validation)
      return {
        ok: true,
        hint: "Fresh validation view saved. Vary the next pose.",
      };
    const a = this.shape(outline, aspect),
      b = this.shape(this.points(step, aspect, boardAspect), aspect);
    const roll = Math.abs(((a.roll - b.roll + 270) % 180) - 90);
    if (Math.hypot(a.cx - b.cx, a.cy - b.cy) > 0.16)
      return {
        ok: false,
        hint: "Move the board toward the ghost outline before the next capture.",
      };
    if (a.area / b.area < 0.55 || a.area / b.area > 1.7)
      return {
        ok: false,
        hint: "Change the distance to match the outline’s size.",
      };
    if (roll > 18)
      return {
        ok: false,
        hint: "Rotate the board within the image to match the outline.",
      };
    if (step.yaw && Math.abs(a.yaw - b.yaw) > 0.35)
      return {
        ok: false,
        hint: "Turn the board around its vertical axis to match the shorter edge.",
      };
    if (step.pitch && Math.abs(a.pitch - b.pitch) > 0.35)
      return {
        ok: false,
        hint: "Tip the board around its horizontal axis to match the shorter edge.",
      };
    return {
      ok: true,
      hint: "Placement is close to the outline. Change the pose slightly for the next shot.",
    };
  },
};
