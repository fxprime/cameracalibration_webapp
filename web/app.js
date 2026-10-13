/* UI orchestration only. Numerical geometry lives in vision/, HTTP in src/. */
const $ = (id) => document.getElementById(id);
const steps = [
  ["learn", "Understand", "A camera turns rays into pixels."],
  ["target", "Prepare target", "Give geometry a known scale."],
  ["capture", "Capture views", "Move the board. Hold. Capture."],
  ["review", "Review & fit", "Let every view earn its place."],
  ["result", "Inspect & export", "Check the geometry on real images."],
  ["track", "Track a tag", "A known square becomes a 3D pose."],
];
let state = { views: [], result: null },
  stream = null,
  files = {},
  tracking = false,
  poseLog = [],
  busy = false;
let selectionQueue = Promise.resolve();
const note = (text, error = false) => {
  $("notice").textContent = text;
  $("notice").classList.toggle("error", error);
};
async function api(q) {
  const r = await fetch("/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(q),
  });
  if (!r.ok) throw Error(`Server returned ${r.status}`);
  const data = await r.json();
  if (data.error) throw Error(data.error);
  return data;
}
async function action(fn) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await fn();
  } catch (e) {
    note(e.message, true);
  } finally {
    busy = false;
    document.querySelectorAll("button").forEach((b) => (b.disabled = false));
  }
}
function go(id) {
  document
    .querySelectorAll(".page")
    .forEach((p) => p.classList.toggle("active", p.id === id));
  document
    .querySelectorAll("nav button")
    .forEach((b) => b.classList.toggle("active", b.dataset.go === id));
  $("title").textContent = steps.find((s) => s[0] === id)[2];
  $("eyebrow").textContent = steps.find((s) => s[0] === id)[1].toUpperCase();
  window.scrollTo(0, 0);
  if (id !== "track") stopTracking();
}
$("nav").innerHTML = steps
  .map(
    (s, i) =>
      `<button data-go="${s[0]}"><span>0${i + 1}</span>　${s[1]}</button>`,
  )
  .join("");
document
  .querySelectorAll("[data-go]")
  .forEach((b) => (b.onclick = () => go(b.dataset.go)));
$("skip").onclick = () => go("target");
go("learn");
function config() {
  return {
    type: $("pattern").value,
    cols: +$("cols").value,
    rows: +$("rows").value,
    size: +$("element").value / 1000,
    spacing: +$("spacing").value,
    id: +$("tagId").value,
  };
}
function targetHelp() {
  $("targetHelp").textContent =
    $("pattern").value === "checkerboard"
      ? "Rows / columns count INTERNAL CORNERS, not squares."
      : "Rows / columns count tags. Spacing is a dimensionless gap-to-tag ratio.";
  $("spacing").disabled = $("pattern").value === "checkerboard";
}
$("pattern").onchange = targetHelp;
targetHelp();
function download(name, text, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
let targetSvg = "",
  targetYaml = "";
async function generate() {
  const d = await api({ op: "target", config: config() });
  targetSvg = d.svg;
  targetYaml = d.yaml;
  $("targetPreview").innerHTML = d.svg;
}
$("targetConfig").onclick = () =>
  action(async () => {
    await generate();
    download("target.yaml", targetYaml);
  });
$("generate").onclick = () => action(generate);
$("downloadTarget").onclick = () =>
  action(async () => {
    await generate();
    download("calibration-target.svg", targetSvg, "image/svg+xml");
  });
$("print").onclick = () => {
  const popup = window.open("", "_blank");
  if (!popup) {
    note("Allow the print window in your browser.", true);
    return;
  }
  action(async () => {
    await generate();
    popup.document.write(
      `<title>Calibration target · actual size</title><style>@page{margin:0}body{margin:0}svg{display:block;max-width:none}</style>${targetSvg}`,
    );
    popup.document.close();
    popup.focus();
    popup.print();
  });
};
$("newSession").onclick = () =>
  action(async () => {
    stopTracking();
    await selectionQueue;
    state = await api({ op: "new", config: config() });
    files = {};
    render();
    go("capture");
    note(
      "Session created. Connect your camera, then capture sharp, varied views.",
    );
  });
function fov() {
  const f = +$("focal").value;
  $("fov").textContent =
    `fₓ = ${f} px · width 1920 px · horizontal FOV ${((2 * Math.atan(1920 / (2 * f)) * 180) / Math.PI).toFixed(1)}°`;
  const x = 255 + f / 12;
  const plane = Math.min(470, x);
  $("ray")
    .querySelector("path")
    .setAttribute(
      "d",
      `M35 35L255 130L${plane} ${130 + ((plane - 255) * 95) / 220} M35 225L255 130L${plane} ${130 - ((plane - 255) * 95) / 220}`,
    );
}
$("focal").oninput = fov;
fov();
async function devices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  const cams = all.filter((d) => d.kind === "videoinput");
  const selected = $("camera").value;
  $("camera").replaceChildren(
    ...cams.map((d, i) => new Option(d.label || `Camera ${i + 1}`, d.deviceId)),
  );
  if (cams.some((d) => d.deviceId === selected)) $("camera").value = selected;
  else {
    const dec = cams.find((d) => /DECXIN/i.test(d.label));
    if (dec) $("camera").value = dec.deviceId;
  }
}
function disconnect() {
  stopTracking();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  $("video").srcObject = null;
}
$("disconnect").onclick = disconnect;
$("connect").onclick = () =>
  action(async () => {
    disconnect();
    const constraints = {
      width: { ideal: +$("width").value },
      height: { ideal: +$("height").value },
      frameRate: { ideal: +$("fps").value },
    };
    if ($("camera").value) constraints.deviceId = { exact: $("camera").value };
    stream = await navigator.mediaDevices.getUserMedia({
      video: constraints,
      audio: false,
    });
    $("video").srcObject = stream;
    await $("video").play();
    await devices();
    const s = stream.getVideoTracks()[0].getSettings();
    $("camera").value = s.deviceId || $("camera").value;
    $("streamInfo").textContent =
      `${stream.getVideoTracks()[0].label} · Actual stream: ${s.width} × ${s.height} · ${s.frameRate || "?"} fps. Calibration uses these dimensions.`;
    note(
      "Camera connected. Keep focus, crop and resolution fixed throughout the session.",
    );
  });
function frame() {
  const v = $("video");
  if (!stream || !v.videoWidth) throw Error("Connect a camera first.");
  const c = $("frameCanvas");
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  return c.toDataURL("image/png");
}
const guidance = [
  ["Start near the center", "Board fills about half the image. Hold still."],
  [
    "Cover the upper-left",
    "Move the board toward this edge without cutting checkerboard corners.",
  ],
  ["Cover the upper-right", "Capture sharp corners near the image boundary."],
  ["Cover the lower-right", "Keep enough light and avoid glare."],
  ["Cover the lower-left", "Edge observations constrain lens distortion."],
  ["Tilt left and right", "Rotate 20–45° about the board’s vertical axis."],
  ["Tilt upward and downward", "Rotate about a second axis."],
  ["Vary the distance", "Mix smaller and larger board appearances."],
  [
    "Repeat diverse views",
    "Aim for 20–40 varied views, then reserve 5–10 new views for validation.",
  ],
];
function guide() {
  let i = Math.min(guidance.length - 1, Math.floor(state.views.length / 3));
  $("guide").textContent = guidance[i][0];
  $("guidance").textContent = guidance[i][1];
  $("captureCount").textContent =
    `${state.views.length} saved views · ${state.views.filter((v) => v.enabled && !v.holdout).length} training · ${state.views.filter((v) => v.enabled && v.holdout).length} validation. Session: ${state.session || "none"}`;
}
async function capture(data, source = "browser stream") {
  const d = await api({
    op: "capture",
    frame: data,
    source,
    holdout: $("holdout").checked,
  });
  state = d;
  $("detection").src = d.overlay;
  $("detection").hidden = false;
  render();
  note(
    `View ${d.views.at(-1).id} saved with ${d.views.at(-1).points} detected corners. Move to a different pose.`,
  );
}
$("captureFrame").onclick = () => action(() => capture(frame()));
$("upload").onchange = () =>
  action(async () => {
    for (const file of $("upload").files) {
      const data = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      try {
        await capture(data, file.name);
      } catch (e) {
        note(`${file.name}: ${e.message}`, true);
      }
    }
    $("upload").value = "";
  });
function render() {
  guide();
  $("sessionName").textContent = state.session || "No session";
  const metrics = new Map((state.result?.views || []).map((v) => [v.id, v]));
  $("views").innerHTML = state.views
    .map((v) => {
      const m = metrics.get(v.id);
      return `<tr><td><input type="checkbox" data-id="${v.id}" data-field="enabled" aria-label="Keep view ${v.id}" ${v.enabled ? "checked" : ""}></td><td><input type="checkbox" data-id="${v.id}" data-field="holdout" aria-label="Validate view ${v.id}" ${v.holdout ? "checked" : ""}></td><td>${String(v.id).padStart(3, "0")}</td><td>${v.points}</td><td>${v.sharpness.toFixed(0)}</td><td class="${m && m.rms > +$("threshold").value ? "bad" : ""}">${m ? m.rms.toFixed(3) : "—"}</td><td>${m ? m.p95.toFixed(3) : "—"}</td><td><button data-inspect="${v.id}">Inspect</button></td></tr>`;
    })
    .join("");
  $("previewView").replaceChildren(
    ...state.views.map(
      (v) =>
        new Option(`View ${v.id}${v.holdout ? " · validation" : ""}`, v.id),
    ),
  );
  document.querySelectorAll("[data-inspect]").forEach(
    (b) =>
      (b.onclick = () => {
        $("previewView").value = b.dataset.inspect;
        go("result");
        $("preview").click();
      }),
  );
  document.querySelectorAll("#views input").forEach(
    (i) =>
      (i.onchange = () => {
        state.views.find((v) => v.id === +i.dataset.id)[i.dataset.field] =
          i.checked;
        $("stats").innerHTML =
          "<p>Selection changed. Refit before trusting or exporting the previous result.</p>";
        state.result = null;
        files = {};
        $("exportText").textContent = "";
        $("intrinsics").hidden = true;
        queueSelection();
      }),
  );
  const r = state.result;
  $("intrinsics").hidden = !r;
  if (r) {
    $("intrinsics").replaceChildren();
    const title = document.createElement("h2");
    title.textContent = "Fitted geometry · " + r.model;
    const pre = document.createElement("pre");
    pre.textContent =
      "Original image K (pixels)\n" +
      r.K.map((row) => row.map((v) => v.toFixed(5)).join("  ")).join("\n") +
      "\n\nDistortion " +
      (r.model === "fisheye" ? "[k1, k2, k3, k4]" : "[k1, k2, p1, p2]") +
      "\n" +
      r.D.map((v) => v.toFixed(8)).join(", ") +
      (r.diversity
        ? "\n\nMax board tilt: " +
          r.diversity.max_tilt_degrees.toFixed(1) +
          "° · target distance ratio: " +
          r.diversity.depth_ratio.toFixed(2)
        : "") +
      (r.uncertainty
        ? "\nApproximate standard deviations [fx, fy, cx, cy]: " +
          r.uncertainty
            .slice(0, 4)
            .map((v) => v.toFixed(4))
            .join(", ")
        : "");
    $("intrinsics").append(title, pre);
    const val = r.views.filter((v) => v.holdout);
    const vRms = val.length
      ? Math.sqrt(val.reduce((s, v) => s + v.rms * v.rms, 0) / val.length)
      : null;
    $("stats").innerHTML = [
      ["Training RMS", r.rms.toFixed(3) + " px", r.rms > +$("threshold").value],
      [
        "Validation view RMS",
        vRms === null ? "Not measured" : vRms.toFixed(3) + " px",
        vRms === null || vRms > +$("threshold").value,
      ],
      ["Coverage", Math.round(r.coverage * 100) + "%", r.coverage < 0.83],
    ]
      .map(
        ([label, value, bad]) =>
          `<div class="card"><small>${label}</small><div class="metric ${bad ? "bad" : ""}">${value}</div></div>`,
      )
      .join("");
    $("warnings").replaceChildren(
      ...r.warnings.map((w) => {
        const p = document.createElement("p");
        p.className = "bad";
        p.textContent = w;
        return p;
      }),
    );
  } else {
    $("stats").innerHTML = state.views.length
      ? '<div class="card">Fit the current selection to compute valid calibration results.</div>'
      : "";
    $("warnings").innerHTML = "";
    $("original").removeAttribute("src");
    $("undistorted").removeAttribute("src");
  }
  drawCoverage();
}
function drawCoverage() {
  const c = $("coverage"),
    ctx = c.getContext("2d");
  ctx.fillStyle = "#eff4f1";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = "#c6d8d0";
  for (let x = 0; x <= 4; x++) {
    ctx.beginPath();
    ctx.moveTo(x * 150, 0);
    ctx.lineTo(x * 150, 240);
    ctx.stroke();
  }
  for (let y = 0; y <= 3; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * 80);
    ctx.lineTo(600, y * 80);
    ctx.stroke();
  }
  state.views
    .filter((v) => v.enabled)
    .forEach((v) => {
      ctx.fillStyle = v.holdout ? "#d38a43" : "#188d73";
      ctx.beginPath();
      ctx.arc(v.center[0] * 600, v.center[1] * 240, 7, 0, 7);
      ctx.fill();
      ctx.fillText(v.id, v.center[0] * 600 + 9, v.center[1] * 240);
    });
}
function queueSelection() {
  const request = {
    op: "select",
    selection: Object.fromEntries(
      state.views.map((v) => [
        v.id,
        { enabled: v.enabled, holdout: v.holdout },
      ]),
    ),
  };
  selectionQueue = selectionQueue
    .then(() => api(request))
    .catch((error) => {
      note("Could not save selection: " + error.message, true);
    });
  return selectionQueue;
}
async function syncSelection() {
  await queueSelection();
}
$("threshold").onchange = render;
$("fit").onclick = () =>
  action(async () => {
    note("Fitting selected training views…");
    await syncSelection();
    state = await api({ op: "calibrate", model: $("model").value });
    files = {};
    render();
    note(
      `Fit complete: ${state.result.rms.toFixed(3)} px training RMS. Inspect validation and residuals before accepting.`,
    );
  });
$("flag").onclick = () => {
  if (!state.result) {
    note("Fit first to compute per-view errors.", true);
    return;
  }
  const ids = state.result.views
    .filter((v) => !v.holdout && v.rms > +$("threshold").value)
    .map((v) => v.id);
  ids.forEach((id) => (state.views.find((v) => v.id === id).enabled = false));
  state.result = null;
  files = {};
  render();
  queueSelection();
  note(
    `${ids.length} high-error training views unchecked. Review the reason, then refit. Validation views retained.`,
  );
};
$("preview").onclick = () =>
  action(async () => {
    if (!state.result) throw Error("Fit current selection first.");
    const d = await api({
      op: "preview",
      id: +$("previewView").value,
      balance: +$("balance").value,
    });
    $("original").src = d.original;
    $("undistorted").src = d.undistorted;
    $("newK").textContent =
      "New rectified K: " +
      JSON.stringify(d.newK.map((row) => row.map((x) => +x.toFixed(3)))) +
      " · Export K describes ORIGINAL frames.";
    note("Preview ready. Black borders reflect rays outside the source image.");
  });
$("export").onclick = () =>
  action(async () => {
    if (!state.result) throw Error("Fit current selection first.");
    files = (await api({ op: "export" })).files;
    $("format").replaceChildren(
      ...[
        "ros.yaml",
        "opencv.yaml",
        "kalibr.yaml",
        "target.yaml",
        "report.json",
      ].map((n) => new Option(n, n)),
    );
    showFormat();
    note(
      "Exports generated and saved in the session folder. Download the format your pipeline expects.",
    );
  });
function showFormat() {
  $("exportText").textContent = files[$("format").value] || "";
}
$("format").onchange = showFormat;
$("saveExport").onclick = () => {
  if (!files[$("format").value]) {
    note("Generate exports first.", true);
    return;
  }
  download($("format").value, files[$("format").value]);
};
$("resume").onclick = () =>
  action(async () => {
    const d = await api({ op: "sessions" });
    $("sessions").replaceChildren(...d.sessions.map((n) => new Option(n, n)));
    note(`${d.sessions.length} saved sessions found.`);
  });
$("load").onclick = () =>
  action(async () => {
    await selectionQueue;
    state = await api({ op: "load", session: $("sessions").value });
    const c = state.config;
    $("pattern").value = c.type;
    $("cols").value = c.cols;
    $("rows").value = c.rows;
    $("element").value = c.size * 1000;
    $("spacing").value = c.spacing;
    if (state.result) $("model").value = state.result.model;
    files = {};
    targetHelp();
    render();
    go("review");
    note(
      "Saved session loaded. Reconnect at the original resolution for tracking.",
    );
  });
$("singleTag").onclick = () =>
  action(async () => {
    const c = {
      ...config(),
      type: "aprilgrid",
      size: +$("tagSize").value / 1000,
    };
    download(
      `tag36h11-${c.id}.svg`,
      (await api({ op: "target", config: c, single: true })).svg,
      "image/svg+xml",
    );
  });
function stopTracking() {
  tracking = false;
  $("tracking").textContent = "Start tracking";
}
let trackGeneration = 0;
$("tracking").onclick = () => {
  if (tracking) {
    stopTracking();
    trackGeneration++;
    return;
  }
  if (!state.result || !stream) {
    note("Fit a calibration and connect its camera first.", true);
    return;
  }
  tracking = true;
  const generation = ++trackGeneration;
  $("tracking").textContent = "Stop tracking";
  note(
    "Tracking tag pose. Frame processing is sequential; the preview is not a synchronized VIO stream.",
  );
  trackLoop(generation);
};
async function trackLoop(generation) {
  if (!tracking || generation !== trackGeneration) return;
  try {
    const d = await api({
      op: "track",
      frame: frame(),
      tagSize: +$("tagSize").value / 1000,
      scale: +$("scale").value,
      id: +$("tagId").value,
    });
    if (!tracking || generation !== trackGeneration) return;
    $("trackImage").src = d.overlay;
    const p = d.poses[0];
    if (p) {
      poseLog.push({ timestamp: d.timestamp, session: state.session, ...p });
      if (poseLog.length > 10000) poseLog.shift();
      $("poseText").textContent =
        `Tag ${p.id}\nX ${p.translation[0].toFixed(4)} m   Y ${p.translation[1].toFixed(4)} m\nZ ${p.translation[2].toFixed(4)} m\nReprojection RMS ${p.rms.toFixed(3)} px\n${p.ambiguous ? "⚠ Planar pose is ambiguous." : "Pose selected by positive depth and pixel error."}\nR (tag → camera)\n${p.rotation.map((row) => row.map((x) => x.toFixed(4)).join("  ")).join("\n")}`;
      drawPose(p);
    } else {
      $("poseText").textContent = "Selected tag not visible. No current pose.";
      drawPose(null);
    }
  } catch (e) {
    note(e.message, true);
    stopTracking();
  }
  if (tracking) setTimeout(() => trackLoop(generation), 100);
}
function drawPose(p) {
  const c = $("poseCanvas"),
    x = c.getContext("2d");
  x.clearRect(0, 0, c.width, c.height);
  x.fillStyle = "#eff4f1";
  x.fillRect(0, 0, c.width, c.height);
  const origin = [300, 250];
  x.strokeStyle = "#9cb9ad";
  x.beginPath();
  x.moveTo(30, 250);
  x.lineTo(570, 250);
  x.moveTo(300, 250);
  x.lineTo(300, 20);
  x.stroke();
  x.fillStyle = "#47665c";
  x.fillText("Camera", 278, 275);
  x.fillText("X →", 540, 270);
  x.fillText("Z forward ↑", 310, 30);
  if (p) {
    const [tx, , tz] = p.translation;
    const scale = 200 / Math.max(1, Math.abs(tx), tz);
    const px = 300 + tx * scale,
      py = 250 - tz * scale;
    x.strokeStyle = "#168971";
    x.beginPath();
    x.moveTo(...origin);
    x.lineTo(px, py);
    x.stroke();
    x.fillStyle = "#168971";
    x.fillRect(px - 8, py - 8, 16, 16);
    x.fillText(`Tag ${p.id} · top view`, px + 12, py);
  }
}
drawPose(null);
$("poseExport").onclick = () =>
  download(
    "tag-pose-log.json",
    JSON.stringify(
      {
        frame: "camera optical: x right, y down, z forward",
        tagSizeMeters: +$("tagSize").value / 1000,
        scale: +$("scale").value,
        samples: poseLog,
      },
      null,
      2,
    ),
    "application/json",
  );
window.addEventListener("beforeunload", disconnect);
devices().catch((e) =>
  note("Camera enumeration unavailable: " + e.message, true),
);
action(generate);
render();

function drawDistortion() {
  const canvas = $("distortionCanvas"),
    ctx = canvas.getContext("2d"),
    k = +$("distortionK").value;
  ctx.fillStyle = "#eff4f1";
  ctx.fillRect(0, 0, 500, 300);
  ctx.strokeStyle = "#178b72";
  const pixel = (x, y) => {
    const factor = 1 + k * (x * x + y * y);
    return [250 + 150 * x * factor, 150 + 120 * y * factor];
  };
  for (let line = -0.8; line <= 0.81; line += 0.2) {
    for (let axis = 0; axis < 2; axis++) {
      ctx.beginPath();
      for (let t = -1; t <= 1.001; t += 0.02) {
        const p = axis ? pixel(t, line) : pixel(line, t);
        if (t === -1) ctx.moveTo(...p);
        else ctx.lineTo(...p);
      }
      ctx.stroke();
    }
  }
  $("distortionLabel").textContent =
    `k₁ = ${k.toFixed(2)} · ${k < 0 ? "Barrel" : k > 0 ? "Pincushion" : "No radial distortion"}`;
}
$("distortionK").oninput = drawDistortion;
drawDistortion();
