/* Symmetric radial geometry, separate from the calibration solver. */
const RadialFov = {
  radius(theta, model, k) {
    const base = model === "pinhole" ? Math.tan(theta) : theta;
    return base * (1 + k * base * base);
  },
  edgeAngle(radius, model, k) {
    let lo = 0,
      previous = 0;
    const limit = Math.PI / 2 - 1e-6;
    for (let i = 1; i <= 10000; i++) {
      let hi = (limit * i) / 10000,
        value = this.radius(hi, model, k);
      if (!Number.isFinite(value) || value <= previous) return null;
      if (value >= radius) {
        for (let j = 0; j < 60; j++) {
          const mid = (lo + hi) / 2;
          if (this.radius(mid, model, k) < radius) lo = mid;
          else hi = mid;
        }
        return (lo + hi) / 2;
      }
      previous = value;
      lo = hi;
    }
    return null;
  },
  draw() {
    const model = document.getElementById("radialModel").value,
      f = +document.getElementById("radialFocal").value,
      k = +document.getElementById("radialCoefficient").value;
    const edge = 1920 / (2 * f),
      theta = this.edgeAngle(edge, model, k),
      canvas = document.getElementById("radialFovPlot"),
      ctx = canvas.getContext("2d");
    const xmax = 90,
      ymax = Math.max(2, edge * 1.15),
      x = (t) => 60 + (t / 90) * 550,
      y = (r) => 300 - (r / ymax) * 255;
    ctx.fillStyle = "#eff4f1";
    ctx.fillRect(0, 0, 640, 360);
    ctx.font = "13px sans-serif";
    ctx.fillStyle = "#47665c";
    ctx.strokeStyle = "#c6d8d0";
    for (let a = 0; a <= 90; a += 15) {
      ctx.beginPath();
      ctx.moveTo(x(a), 45);
      ctx.lineTo(x(a), 300);
      ctx.stroke();
      ctx.fillText(a + "°", x(a) - 10, 324);
    }
    for (let r = 0; r <= ymax; r += 0.5) {
      ctx.beginPath();
      ctx.moveTo(60, y(r));
      ctx.lineTo(610, y(r));
      ctx.stroke();
      ctx.fillText(r.toFixed(1), 22, y(r) + 4);
    }
    ctx.fillText("Ray angle θ", 270, 350);
    ctx.fillText("Normalized image radius ρd", 60, 22);
    const curve = (kind, coeff, color, dashed) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash(dashed ? [5, 5] : []);
      ctx.beginPath();
      let previous = -1;
      for (let a = 0; a < 90; a += 0.15) {
        const r = this.radius((a * Math.PI) / 180, kind, coeff);
        if (r < previous || !Number.isFinite(r) || r > ymax) break;
        if (a === 0) ctx.moveTo(x(a), y(r));
        else ctx.lineTo(x(a), y(r));
        previous = r;
      }
      ctx.stroke();
    };
    curve("pinhole", 0, "#8b9ba1", true);
    curve("kb", 0, "#d38a43", true);
    curve(model, k, "#087f69", false);
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = "#365caa";
    ctx.beginPath();
    ctx.moveTo(60, y(edge));
    ctx.lineTo(610, y(edge));
    ctx.stroke();
    ctx.setLineDash([]);
    if (theta !== null) {
      const a = (theta * 180) / Math.PI;
      ctx.fillStyle = "#087f69";
      ctx.beginPath();
      ctx.arc(x(a), y(edge), 5, 0, 7);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x(a), y(edge));
      ctx.lineTo(x(a), 300);
      ctx.strokeStyle = "#087f69";
      ctx.stroke();
    }
    MathUI.render(
      document.getElementById("radialLaw"),
      model === "pinhole"
        ? String.raw`g(\theta)=\tan\theta\left(1+k_1\tan^2\theta\right)`
        : String.raw`g(\theta)=\theta\left(1+k_1^{\mathrm{CV}}\theta^2\right),\quad k_1^{\mathrm{CV}}=k_2^{\mathrm{VINS}}`,
      true,
    );
    const answer = document.getElementById("radialAnswer");
    answer.replaceChildren(
      MathUI.element(
        String.raw`f_x=${f}\,\mathrm{px},\quad k=${k.toFixed(2)}`,
        true,
      ),
      MathUI.element(String.raw`\rho_{\mathrm{edge}}=${edge.toFixed(4)}`, true),
    );
    if (theta !== null)
      answer.append(
        MathUI.element(
          String.raw`\theta_{\mathrm{edge}}=${((theta * 180) / Math.PI).toFixed(2)}^\circ,\quad\operatorname{HFOV}=${((theta * 360) / Math.PI).toFixed(2)}^\circ`,
          true,
        ),
      );
    document.getElementById("radialWarning").textContent =
      theta === null
        ? "The image edge is outside the first increasing forward-facing branch. These settings do not yield a valid FOV in this demo."
        : "The edge intersects the first increasing branch. Other coefficients are held at zero.";
  },
};
["radialModel", "radialFocal", "radialCoefficient"].forEach((id) =>
  document.getElementById(id).addEventListener("input", () => RadialFov.draw()),
);
RadialFov.draw();

// The expandable panels read the same files developers compile and edit.
document.querySelectorAll("code[data-source]").forEach(async (code) => {
  try {
    const response = await fetch(code.dataset.source);
    if (!response.ok) throw Error("Source unavailable");
    code.textContent = await response.text();
  } catch (error) {
    code.textContent = "Could not load example: " + error.message;
  }
});
