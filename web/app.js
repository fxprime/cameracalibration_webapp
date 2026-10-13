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
let trackGeneration = 0, lastPoseText = 0, lastTrackCompletion = 0;
let trackAbort = null, trackFrameCallback = 0;
const trackingCaptureCanvas = document.createElement("canvas");
let trackingRenderer = null, trackingGeometry = null, previewGeneration = 0, previewAnimation = 0;
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
  document
    .querySelectorAll("#views input")
    .forEach((input) => (input.disabled = true));
  document.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await fn();
  } catch (e) {
    note(e.message, true);
  } finally {
    busy = false;
    document
      .querySelectorAll("#views input")
      .forEach((input) => (input.disabled = false));
    document.querySelectorAll("button").forEach((b) => (b.disabled = false));
    availability();
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
function config(requireMeasurement = false) {
  const measurement = updateMeasurement();
  if (
    $("pattern").value === "aprilgrid" &&
    requireMeasurement &&
    !measurement &&
    !$("useDesign").checked
  )
    throw Error(
      "Enter a measured horizontal or vertical span before calibration.",
    );
  if (measurement?.mismatch > 0.01)
    throw Error(
      "Horizontal and vertical pitches disagree by more than 1%. Check the print and measure both tag sides; this model assumes a square, uniformly scaled board.",
    );
  return {
    type: $("pattern").value,
    cols: +$("cols").value,
    rows: +$("rows").value,
    size: +$("element").value / 1000,
    spacing: measurement ? measurement.ratio : +$("designSpacing").value,
    id: +$("tagId").value,
    measurements: measurement
      ? {
          tagMm: +$("element").value,
          horizontalMm: $("spanWidth").value ? +$("spanWidth").value : null,
          verticalMm: $("spanHeight").value ? +$("spanHeight").value : null,
          horizontalTags: +$("spanCols").value,
          verticalTags: +$("spanRows").value,
          gapMm: measurement.gapMm,
          pitchMismatch: measurement.mismatch,
        }
      : null,
  };
}
function targetHelp() {
  $("targetHelp").textContent =
    $("pattern").value === "checkerboard"
      ? "Rows / columns count INTERNAL CORNERS, not squares."
      : "Rows / columns count tags. Enter millimetre measurements above; the software calculates spacing.";
  $("boardMeasurements").hidden = $("pattern").value === "checkerboard";
}
$("pattern").onchange = targetHelp;
targetHelp();
function updateMeasurement() {
  const box = $("measurementResult");
  if ($("pattern").value === "checkerboard") return null;
  try {
    const measured = BoardMeasurement.estimate(+$("element").value, [
      {
        axis: "horizontal",
        lengthMm: $("spanWidth").value === "" ? null : +$("spanWidth").value,
        tags: +$("spanCols").value,
        limit: +$("cols").value,
      },
      {
        axis: "vertical",
        lengthMm: $("spanHeight").value === "" ? null : +$("spanHeight").value,
        tags: +$("spanRows").value,
        limit: +$("rows").value,
      },
    ]);
    $("spacing").value = measured
      ? measured.ratio.toFixed(8)
      : +$("designSpacing").value;
    box.className = measured?.mismatch > 0.005 ? "bad" : "";
    if (!measured) {
      box.textContent =
        "No span measured yet. The preview uses the print-layout ratio; calibration needs an actual span measurement.";
      return null;
    }
    box.replaceChildren(
      "Average gap: ",
      MathUI.element(measured.gapMm.toFixed(3) + String.raw`\,\mathrm{mm}`),
      " · gap/tag ratio: ",
      MathUI.element(measured.ratio.toFixed(6)),
    );
    const explanation = document.createElement("p");
    explanation.textContent =
      measured.directions.length === 1
        ? "Calculated from one direction. Measure the other direction to check print scaling."
        : `Horizontal / vertical pitch difference: ${(measured.mismatch * 100).toFixed(2)}%. ${measured.mismatch > 0.005 ? "Recheck measurements and both tag sides for uneven scaling." : "Measurements agree within 0.5%."}`;
    box.append(explanation);
    return measured;
  } catch (error) {
    box.className = "bad";
    box.textContent = error.message;
    throw error;
  }
}
[
  "element",
  "spanWidth",
  "spanHeight",
  "spanCols",
  "spanRows",
  "designSpacing",
].forEach((id) =>
  $(id).addEventListener("input", () => {
    try {
      updateMeasurement();
    } catch {}
  }),
);
["cols", "rows"].forEach((id, index) =>
  $(id).addEventListener("input", () => {
    const input = $(index === 0 ? "spanCols" : "spanRows");
    if (!$(index === 0 ? "spanWidth" : "spanHeight").value)
      input.value = $(id).value;
    try {
      updateMeasurement();
    } catch {}
  }),
);
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
    download("calibration-target-A4.svg", targetSvg, "image/svg+xml");
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
      `<title>Calibration target · actual size</title><style>@page{size:A4 portrait;margin:0}body{margin:0;width:210mm;height:297mm}svg{display:block;max-width:none}</style>${targetSvg}`,
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
    state = await api({ op: "new", config: config(true) });
    lastSelectionAnchor = null;
    setGuide(0);
    files = {};
    render();
    go("capture");
    note(
      "Session created. Connect your camera, then capture sharp, varied views.",
    );
  });
function fov() {
  const f = +$("focal").value;
  MathUI.render(
    $("fov"),
    String.raw`f_x=${f}\,\mathrm{px}\quad w=1920\,\mathrm{px}\quad \operatorname{HFOV}=${((2 * Math.atan(1920 / (2 * f)) * 180) / Math.PI).toFixed(1)}^\circ`,
  );
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
  availability();
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
let guideIndex = 0,
  lastSelectionAnchor = null,
  inspectedId = null;
function adoptSession(data) {
  state = data;
  lastSelectionAnchor = null;
  const c = data.config;
  $("pattern").value = c.type;
  $("cols").value = c.cols;
  $("rows").value = c.rows;
  $("element").value = c.size * 1000;
  $("spacing").value = c.spacing;
  $("designSpacing").value = c.spacing;
  $("spanWidth").value = c.measurements?.horizontalMm ?? "";
  $("spanHeight").value = c.measurements?.verticalMm ?? "";
  $("spanCols").value = c.measurements?.horizontalTags ?? c.cols;
  $("spanRows").value = c.measurements?.verticalTags ?? c.rows;
  updateMeasurement();
  if (state.result) $("model").value = state.result.model;
  if (data.size) {
    $("width").value = data.size[0];
    $("height").value = data.size[1];
  }
  guideIndex = CaptureGuide.steps.findIndex(
    (_, i) => placementCount(i) < (CaptureGuide.steps[i].shots || 2),
  );
  if (guideIndex < 0) guideIndex = CaptureGuide.steps.length - 1;
  $("holdout").checked = !!CaptureGuide.steps[guideIndex].validation;
}
function availability() {
  if (busy) return;
  const train = state.views.filter((v) => v.enabled && !v.holdout).length;
  const hasSession = !!state.session;
  $("captureFrame").disabled = !stream || !hasSession;
  $("disconnect").disabled = !stream;
  $("fit").disabled = train < 10;
  $("fitReadiness").textContent =
    train < 10
      ? `Keep at least 10 training images before fitting (${train} currently kept). Capture more or adjust selection.`
      : `${train} training images ready. First review the thumbnails, then choose Fit selected views.`;
  ["preview", "export", "flag"].forEach(
    (id) => ($(id).disabled = !state.result),
  );
  ["selectAll", "deselectAll"].forEach(
    (id) => ($(id).disabled = !state.views.length),
  );
  document
    .querySelectorAll("[data-inspect]")
    .forEach((b) => (b.disabled = !state.result));
  inspectionNavigation();
  $("prepareFirst").hidden = hasSession;
  $("capturePrerequisite").textContent = !hasSession
    ? "First prepare and measure your printed board, then select Use this target."
    : !stream
      ? "Your session is ready. Connect the camera, then follow the dashed outline."
      : "Camera connected. Match the outline, hold still, then press Space or Capture.";
}
function previewInstruction(text) {
  if (!$("mirrorPreview").checked) return text;
  const swaps = {
    left: "right",
    right: "left",
    clockwise: "counterclockwise",
    counterclockwise: "clockwise",
  };
  return text.replace(
    /\b(left|right|counterclockwise|clockwise)\b/gi,
    (word) => {
      const value = swaps[word.toLowerCase()];
      return word[0] === word[0].toUpperCase()
        ? value[0].toUpperCase() + value.slice(1)
        : value;
    },
  );
}
function applyPreviewMirror() {
  $("captureStage").classList.toggle(
    "mirrored-preview",
    $("mirrorPreview").checked,
  );
  try {
    localStorage.setItem(
      "calibration-mirror-preview",
      String($("mirrorPreview").checked),
    );
  } catch {}
  guide();
}
try {
  const saved = localStorage.getItem("calibration-mirror-preview");
  if (saved !== null) $("mirrorPreview").checked = saved === "true";
} catch {}
$("mirrorPreview").onchange = applyPreviewMirror;
function guideGeometry() {
  const aspect =
    $("video").videoWidth / $("video").videoHeight ||
    +$("width").value / +$("height").value;
  const boardAspect =
    $("pattern").value === "checkerboard"
      ? (+$("cols").value + 1) / (+$("rows").value + 1)
      : (+$("cols").value +
          (+$("cols").value - 1) *
            +($("spacing").value || $("designSpacing").value)) /
        (+$("rows").value +
          (+$("rows").value - 1) *
            +($("spacing").value || $("designSpacing").value));
  return {
    aspect,
    boardAspect: Number.isFinite(boardAspect) ? boardAspect : 1,
  };
}
function placementCount(index) {
  const step = CaptureGuide.steps[index],
    g = guideGeometry();
  return state.views.filter(
    (v) =>
      v.guide_step === step.id &&
      !!v.holdout === !!step.validation &&
      CaptureGuide.match(v.outline, step, g.aspect, g.boardAspect).ok,
  ).length;
}
function guide() {
  const step = CaptureGuide.steps[guideIndex],
    g = guideGeometry();
  $("captureStage").style.aspectRatio = g.aspect;
  $("guide").textContent = previewInstruction(step.title);
  $("guidance").textContent = previewInstruction(step.text);
  if (step.validation && placementCount(guideIndex) >= (step.shots || 6)) {
    $("guide").textContent = "Capture plan complete";
    $("guidance").textContent =
      "Review the thumbnails next. Keep sharp, diverse images, fit the training set, and inspect validation errors before accepting the result.";
  }
  $("guideProgress").textContent =
    `PLACEMENT ${guideIndex + 1} OF ${CaptureGuide.steps.length} · ${placementCount(guideIndex)}/${step.shots || 2} MATCHING VIEWS`;
  const points = CaptureGuide.points(step, g.aspect, g.boardAspect);
  $("guidePolygon").setAttribute(
    "points",
    points.map((p) => p.map((v) => v * 100).join(",")).join(" "),
  );
  $("guideCenter").setAttribute("cx", step.cx * 100);
  $("guideCenter").setAttribute("cy", step.cy * 100);
  $("guideOverlay").hidden = !$("showGuide").checked;
  $("captureCount").textContent =
    `${state.views.length} saved views · ${state.views.filter((v) => v.enabled && !v.holdout).length} training · ${state.views.filter((v) => v.enabled && v.holdout).length} validation. Aim for at least 20 diverse training views and 5–10 fresh validation views.`;
}
function setGuide(index) {
  guideIndex = Math.max(0, Math.min(CaptureGuide.steps.length - 1, index));
  $("holdout").checked = !!CaptureGuide.steps[guideIndex].validation;
  $("observedPolygon").setAttribute("points", "");
  $("guideFeedback").textContent =
    "Match the dashed outline, hold still, then capture. The check uses approximate 2D shape.";
  guide();
}
$("guidePrevious").onclick = () => setGuide(guideIndex - 1);
$("guideNext").onclick = () => setGuide(guideIndex + 1);
$("showGuide").onchange = guide;
$("video").addEventListener("loadedmetadata", guide);
applyPreviewMirror();
function selectionChanged() {
  state.result = null;
  files = {};
  $("intrinsics").hidden = true;
  $("fitOutcomes").hidden = false;
  $("exportText").textContent = "";
  $("stats").innerHTML =
    '<div class="card">Selection changed. Fit again before using or exporting calibration results. Table errors, if present, are from the previous fit.</div>';
  $("warnings").replaceChildren();
  drawCoverage();
  guide();
  syncRowStates();
  queueSelection();
}
function syncRowStates() {
  document.querySelectorAll("#views tr[data-view-id]").forEach((row) => {
    const v = state.views.find((v) => v.id === +row.dataset.viewId);
    row.classList.toggle("kept", v.enabled);
    row.classList.toggle("excluded", !v.enabled);
    row.setAttribute("aria-selected", String(v.enabled));
    row.querySelector('[data-field="enabled"]').checked = v.enabled;
    row.querySelector('[data-field="holdout"]').checked = v.holdout;
    row.setAttribute(
      "aria-label",
      `View ${v.id}, ${v.enabled ? "kept" : "excluded"}, ${v.holdout ? "validation" : "training"}`,
    );
  });
  availability();
  $("selectionCount").textContent =
    `${state.views.filter((v) => v.enabled).length} of ${state.views.length} kept`;
}
function toggleRow(id, range = false) {
  if (busy) return;
  const target = state.views.findIndex((v) => v.id === id),
    enabled = !state.views[target].enabled;
  let anchor =
    range && lastSelectionAnchor !== null
      ? state.views.findIndex((v) => v.id === lastSelectionAnchor)
      : target;
  if (anchor < 0) anchor = target;
  for (let i = Math.min(anchor, target); i <= Math.max(anchor, target); i++)
    state.views[i].enabled = enabled;
  lastSelectionAnchor = id;
  selectionChanged();
}
$("selectAll").onclick = () => {
  state.views.forEach((v) => (v.enabled = true));
  selectionChanged();
};
$("deselectAll").onclick = () => {
  state.views.forEach((v) => (v.enabled = false));
  selectionChanged();
};
let sourceLoading = false,
  sourcePending = null;
function sourceNavigation() {
  const index = state.views.findIndex((v) => v.id === inspectedId);
  $("viewCounter").textContent = `${index + 1} / ${state.views.length}`;
  $("viewPrevious").disabled = index <= 0;
  $("viewNext").disabled = index >= state.views.length - 1;
}
async function inspectSource(id) {
  inspectedId = id;
  sourcePending = id;
  if (!$("viewDialog").open) $("viewDialog").showModal();
  sourceNavigation();
  if (sourceLoading) return;
  sourceLoading = true;
  try {
    while (sourcePending !== null) {
      const requested = sourcePending;
      sourcePending = null;
      const v = state.views.find((v) => v.id === requested),
        requestedSession = state.session;
      $("viewCaption").textContent = `Loading view ${requested}…`;
      const d = await api({ op: "view", id: requested });
      if (
        inspectedId === requested &&
        state.session === requestedSession &&
        $("viewDialog").open
      ) {
        $("viewImage").src = d.image;
        $("viewCaption").textContent =
          `View ${requested} · ${v.enabled ? "kept" : "excluded"} ${v.holdout ? "validation" : "training"} · ${v.points} corners`;
      }
    }
  } catch (error) {
    $("viewCaption").textContent = error.message;
  } finally {
    sourceLoading = false;
    sourceNavigation();
  }
}
$("viewClose").onclick = () => $("viewDialog").close();
function adjacentView(delta) {
  const index = state.views.findIndex((v) => v.id === inspectedId);
  return inspectSource(
    state.views[Math.max(0, Math.min(state.views.length - 1, index + delta))]
      .id,
  );
}
$("viewPrevious").onclick = () => adjacentView(-1);
$("viewNext").onclick = () => adjacentView(1);
$("viewDialog").addEventListener("close", () => {
  sourcePending = null;
});
$("viewDialog").addEventListener("keydown", (event) => {
  if (
    event.target.closest("input,select,textarea") ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  )
    return;
  const delta =
    event.key === "ArrowLeft"
      ? -1
      : event.key === "ArrowRight"
        ? 1
        : event.key === "Home"
          ? -state.views.length
          : event.key === "End"
            ? state.views.length
            : 0;
  if (delta) {
    event.preventDefault();
    event.stopPropagation();
    adjacentView(delta);
  }
});
document.addEventListener("keydown", (event) => {
  if (
    event.code === "Space" &&
    $("capture").classList.contains("active") &&
    !event.target.closest("input,select,textarea,button") &&
    !event.ctrlKey &&
    !event.metaKey
  ) {
    event.preventDefault();
    $("captureFrame").click();
  }
});
async function capture(data, source = "browser stream") {
  const d = await api({
    op: "capture",
    frame: data,
    source,
    holdout: $("holdout").checked,
    guideStep: CaptureGuide.steps[guideIndex].id,
  });
  state = d;
  $("detection").src = d.overlay;
  $("detection").hidden = true;
  const saved = d.views.at(-1),
    g = guideGeometry(),
    match = CaptureGuide.match(
      saved.outline,
      CaptureGuide.steps[guideIndex],
      g.aspect,
      g.boardAspect,
    );
  render();
  $("observedPolygon").setAttribute(
    "points",
    (saved.outline || []).map((p) => p.map((v) => v * 100).join(",")).join(" "),
  );
  $("guideFeedback").textContent = "Saved. " + match.hint;
  if (
    match.ok &&
    placementCount(guideIndex) >= (CaptureGuide.steps[guideIndex].shots || 2) &&
    guideIndex < CaptureGuide.steps.length - 1
  )
    setGuide(guideIndex + 1);
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
      return `<tr data-view-id="${v.id}" tabindex="0"><td><button class="thumbnail-button" data-source-preview="${v.id}" aria-label="Enlarge view ${v.id}">${v.thumbnail ? `<img class="view-thumbnail" src="${v.thumbnail}" alt="View ${v.id}">` : "Preview"}</button></td><td><input type="checkbox" data-id="${v.id}" data-field="enabled" aria-label="Keep view ${v.id}" ${v.enabled ? "checked" : ""}></td><td><input type="checkbox" data-id="${v.id}" data-field="holdout" aria-label="Validate view ${v.id}" ${v.holdout ? "checked" : ""}></td><td>${String(v.id).padStart(3, "0")}</td><td>${v.points}</td><td>${v.sharpness.toFixed(0)}</td><td class="${m && m.rms > +$("threshold").value ? "bad" : ""}">${m ? m.rms.toFixed(3) : "—"}</td><td>${m ? m.p95.toFixed(3) : "—"}</td><td><button data-inspect="${v.id}">Inspect</button></td></tr>`;
    })
    .join("");
  const previousPreview = $("previewView").value;
  $("previewView").replaceChildren(
    ...state.views.map(
      (v) =>
        new Option(`View ${v.id}${v.holdout ? " · validation" : ""}`, v.id),
    ),
  );
  if (state.views.some((v) => String(v.id) === previousPreview))
    $("previewView").value = previousPreview;
  $("inspectionStrip").innerHTML = state.views
    .map(
      (v) =>
        `<button data-inspection-id="${v.id}" aria-label="Inspect view ${v.id}">${v.thumbnail ? `<img src="${v.thumbnail}" alt="">` : ""}<span>${v.id}</span></button>`,
    )
    .join("");
  document
    .querySelectorAll("[data-inspection-id]")
    .forEach(
      (button) =>
        (button.onclick = () => chooseInspection(+button.dataset.inspectionId)),
    );
  inspectionNavigation();
  document.querySelectorAll("[data-inspect]").forEach(
    (b) =>
      (b.onclick = () => {
        $("previewView").value = b.dataset.inspect;
        go("result");
        refreshInspection();
      }),
  );
  document.querySelectorAll("#views input").forEach(
    (input) =>
      (input.onchange = () => {
        state.views.find((v) => v.id === +input.dataset.id)[
          input.dataset.field
        ] = input.checked;
        lastSelectionAnchor = +input.dataset.id;
        selectionChanged();
      }),
  );
  document.querySelectorAll("#views tr[data-view-id]").forEach((row) => {
    row.onclick = (event) => {
      if (!event.target.closest("button,input,a"))
        toggleRow(+row.dataset.viewId, event.shiftKey);
    };
    row.onkeydown = (event) => {
      if (event.target !== row) return;
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        toggleRow(+row.dataset.viewId, event.shiftKey);
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        (event.key === "ArrowUp"
          ? row.previousElementSibling
          : row.nextElementSibling
        )?.focus();
      }
    };
  });
  document
    .querySelectorAll("[data-source-preview]")
    .forEach(
      (button) =>
        (button.onclick = () => inspectSource(+button.dataset.sourcePreview)),
    );
  syncRowStates();
  const r = state.result;
  $("fitOutcomes").hidden = !r;
  $("intrinsics").hidden = !r;
  if (r) {
    $("intrinsics").replaceChildren();
    const title = document.createElement("h2");
    title.textContent = "Fitted geometry · " + r.model;
    const K = MathUI.element(
      String.raw`\mathbf K=` + MathUI.matrix(r.K, 5),
      true,
    );
    const coeffs =
      r.model === "fisheye"
        ? String.raw`k_1&k_2&k_3&k_4`
        : String.raw`k_1&k_2&p_1&p_2`;
    const D = MathUI.element(
      String.raw`\mathbf D=\begin{bmatrix}${coeffs}\end{bmatrix}^{\!\mathsf T}= ` +
        MathUI.matrix(
          r.D.map((v) => [v]),
          8,
        ),
      true,
    );
    $("intrinsics").append(title, K, D);
    if (r.diversity) {
      const p = document.createElement("p");
      p.append(
        "Maximum board tilt: ",
        MathUI.element(
          r.diversity.max_tilt_degrees.toFixed(1) + String.raw`^\circ`,
        ),
        " · target distance ratio: ",
        MathUI.element(r.diversity.depth_ratio.toFixed(2)),
      );
      $("intrinsics").append(p);
    }
    if (r.uncertainty) {
      const p = document.createElement("p");
      p.append(
        "Approximate standard deviations: ",
        MathUI.element(
          String.raw`[\sigma_{f_x},\sigma_{f_y},\sigma_{c_x},\sigma_{c_y}]=` +
            MathUI.matrix([r.uncertainty.slice(0, 4)], 4) +
            String.raw`\,\mathrm{px}`,
        ),
      );
      $("intrinsics").append(p);
    }
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
let inspectionLoading = false,
  inspectionPending = null;
function inspectionNavigation() {
  const id = +$("previewView").value,
    index = state.views.findIndex((v) => v.id === id),
    v = state.views[index],
    metric = state.result?.views.find((v) => v.id === id);
  $("inspectCounter").textContent = v
    ? `View ${index + 1} of ${state.views.length} · ID ${id} · ${v.enabled ? "kept" : "excluded"} ${v.holdout ? "validation" : "training"}${metric ? " · " + metric.rms.toFixed(3) + " px RMS" : ""}`
    : "No captured views";
  $("inspectPrevious").disabled = !state.result || index <= 0;
  $("inspectNext").disabled = !state.result || index >= state.views.length - 1;
  document.querySelectorAll("[data-inspection-id]").forEach((button) => {
    const active = +button.dataset.inspectionId === id;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.disabled = !state.result;
  });
  if ($("viewDialog").open) sourceNavigation();
}
function chooseInspection(id) {
  $("previewView").value = id;
  inspectionNavigation();
  const active = document.querySelector(`[data-inspection-id="${id}"]`);
  active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  return refreshInspection();
}
function moveInspection(delta) {
  const index = state.views.findIndex((v) => v.id === +$("previewView").value);
  if (state.views.length)
    return chooseInspection(
      state.views[Math.max(0, Math.min(state.views.length - 1, index + delta))]
        .id,
    );
}
async function refreshInspection() {
  if (!state.result) {
    $("inspectionStatus").textContent =
      "Fit the selected images first to inspect reprojection and undistortion.";
    return;
  }
  inspectionPending = +$("previewView").value;
  inspectionNavigation();
  if (inspectionLoading) return;
  inspectionLoading = true;
  try {
    while (inspectionPending !== null) {
      const id = inspectionPending;
      inspectionPending = null;
      const calibration = state.result;
      $("inspectionStatus").textContent = `Loading view ${id}…`;
      const d = await api({ op: "preview", id, balance: +$("balance").value });
      if (+$("previewView").value === id && state.result === calibration) {
        $("original").src = d.original;
        $("undistorted").src = d.undistorted;
        $("newK").replaceChildren(
          "Rectified camera matrix:",
          MathUI.element(
            String.raw`\mathbf K_{\mathrm{new}}=` + MathUI.matrix(d.newK, 3),
            true,
          ),
          "Exported intrinsics describe the original frames.",
        );
        $("inspectionStatus").textContent =
          `View ${id} ready. Green dots are detected corners; red circles are model predictions.`;
      }
    }
  } catch (error) {
    $("inspectionStatus").textContent = error.message;
  } finally {
    inspectionLoading = false;
    inspectionNavigation();
  }
}
$("preview").onclick = refreshInspection;
$("previewView").onchange = refreshInspection;
$("balance").onchange = refreshInspection;
$("inspectPrevious").onclick = () => moveInspection(-1);
$("inspectNext").onclick = () => moveInspection(1);
document.addEventListener("keydown", (event) => {
  if (
    !$("result").classList.contains("active") ||
    $("viewDialog").open ||
    event.target.closest("input,select,textarea") ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  )
    return;
  const delta =
    event.key === "ArrowLeft"
      ? -1
      : event.key === "ArrowRight"
        ? 1
        : event.key === "Home"
          ? -state.views.length
          : event.key === "End"
            ? state.views.length
            : 0;
  if (delta && state.result) {
    event.preventDefault();
    moveInspection(delta);
  }
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
        "vins-mono.yaml",
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
    adoptSession(state);
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
      `tag36h11-${c.id}-A4.svg`,
      (await api({ op: "target", config: c, single: true })).svg,
      "image/svg+xml",
    );
  });
function stopTracking() {
  tracking = false;
  ++trackGeneration;
  trackAbort?.abort();
  if (trackFrameCallback && $("video").cancelVideoFrameCallback)
    $("video").cancelVideoFrameCallback(trackFrameCallback);
  trackFrameCallback = 0;
  ++previewGeneration;
  cancelAnimationFrame(previewAnimation);
  $("tracking").textContent = "Start tracking";
}
async function updateTrackingPreview() {
  const generation = ++previewGeneration;
  const enabled = $("trackUndistort").checked;
  $("trackingStage").classList.toggle("mirrored", $("trackMirror").checked);
  $("trackKeepBorder").disabled = !enabled;
  cancelAnimationFrame(previewAnimation);
  $("trackingStage").classList.remove("undistorted");
  $("trackUndistorted").hidden = true;
  if (!enabled) return;
  try {
    const geometry = await api({op:"preview_geometry",keep_border:$("trackKeepBorder").checked});
    if (generation !== previewGeneration) return;
    if (!trackingRenderer) trackingRenderer = new TrackingPreview($("trackUndistorted"));
    trackingGeometry = geometry;
    $("trackingStage").classList.add("undistorted");
    $("trackUndistorted").hidden = false;
    const render = () => {
      if (generation !== previewGeneration) return;
      const video = $("trackVideo"), overlay = $("trackOverlay");
      if (video.readyState >= 2 && overlay.width === geometry.size[0] && overlay.height === geometry.size[1])
        trackingRenderer.draw(video, overlay, trackingGeometry);
      previewAnimation = requestAnimationFrame(render);
    };
    render();
  } catch (error) {
    if (generation !== previewGeneration) return;
    $("trackUndistort").checked = false;
    $("trackKeepBorder").disabled = true;
    note(error.message, true);
  }
}
for (const id of ["trackUndistort","trackKeepBorder","trackMirror"]) {
  const saved = localStorage.getItem(id);
  if (saved !== null) $(id).checked = saved === "true";
  $(id).onchange = () => {
    localStorage.setItem(id, String($(id).checked));
    updateTrackingPreview();
  };
}
$("trackKeepBorder").disabled = !$("trackUndistort").checked;
$("trackTarget").onchange = () => {
  const board = $("trackTarget").value === "board";
  $("tagId").disabled = $("tagSize").disabled = board;
  $("boardTrackingReport").textContent = board ? "Uses the measured target geometry saved with the loaded calibration session." : "";
};
const savedTrackingResolution = localStorage.getItem("tracking-resolution");
if (["0", "640", "960"].includes(savedTrackingResolution)) $("trackResolution").value = savedTrackingResolution;
$("trackResolution").onchange = () => localStorage.setItem("tracking-resolution", $("trackResolution").value);
// Tracking-only transport. The calibration frame() path remains lossless color PNG.
async function trackingFrame() {
  const video = $("video");
  if (!stream || !video.videoWidth) throw Error("Connect a camera first.");
  if (video.videoWidth !== state.result.size[0] || video.videoHeight !== state.result.size[1])
    throw Error("Camera resolution must match calibration. Reconnect at the calibrated resolution.");
  const maxRms = +$("trackMaxRms").value;
  if (!Number.isFinite(maxRms) || maxRms < 0.1 || maxRms > 20)
    throw Error("Maximum pixel error must be between 0.1 and 20.");
  const canvas = trackingCaptureCanvas;
  const requestedWidth = +$("trackResolution").value || video.videoWidth;
  const width = Math.min(video.videoWidth, requestedWidth);
  const height = Math.round(video.videoHeight * width / video.videoWidth);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(video, 0, 0, width, height);
  const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const gray = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++)
    gray[j] = (77 * rgba[i] + 150 * rgba[i + 1] + 29 * rgba[i + 2] + 128) >> 8;
  trackAbort = new AbortController();
  const response = await fetch("/track", {
    signal: trackAbort.signal,
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Track-Settings": JSON.stringify({
      width: canvas.width, height: canvas.height,
      source_size: [video.videoWidth, video.videoHeight], max_rms: maxRms,
      target: $("trackTarget").value,
      tagSize: +$("tagSize").value / 1000, scale: +$("scale").value, id: +$("tagId").value,
    }) },
    body: gray,
  });
  if (!response.ok) throw Error(`Server returned ${response.status}`);
  const data = await response.json();
  if (data.error) throw Error(data.error);
  return data;
}
function trackingOverlay(pose) {
  const video = $("video"), canvas = $("trackOverlay");
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  }
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!pose) return;
  if (pose.id === "board") {
    context.strokeStyle = "#00cfe8"; context.lineWidth = 2;
    for (const line of pose.grid_lines) {
      context.beginPath(); line.forEach((point,i)=>i ? context.lineTo(...point) : context.moveTo(...point)); context.stroke();
    }
    context.strokeStyle = "#30f080"; context.setLineDash([10,8]);
    for (const line of pose.observed_lines) {
      context.beginPath();line.forEach((point,i)=>i ? context.lineTo(...point) : context.moveTo(...point));context.stroke();
    }
    context.setLineDash([]);
    pose.observed.forEach((point,i)=>{
      const predicted = pose.projected[i];
      context.strokeStyle = pose.inliers[i] ? "#ffc24b" : "#ff4d30";
      context.beginPath(); context.moveTo(...point); context.lineTo(...predicted); context.stroke();
      context.fillStyle="#30f080";context.beginPath();context.arc(...point,3,0,2*Math.PI);context.fill();
      context.strokeStyle="#f05bff";context.beginPath();context.arc(...predicted,5,0,2*Math.PI);context.stroke();
    });
  }
  if (pose.id === "board" && $("boardOverlayLabels").checked) {
    context.font = `${Math.max(16,Math.round(canvas.width/60))}px sans-serif`;
    pose.per_tag.forEach((tag,i)=>{
      const point = pose.observed[i*4];
      context.fillStyle = "#fff";context.strokeStyle = "#182b33";context.lineWidth = 4;
      const text = `${tag.id}: ${tag.rms.toFixed(2)} px`;
      context.strokeText(text,point[0],point[1]-10);context.fillText(text,point[0],point[1]-10);
    });
  }
  context.lineWidth = 3;
  for (const [i, color] of [[1, "#f33"], [2, "#0d3"], [3, "#38f"]]) {
    const points = pose.axis_pixels;
    context.strokeStyle = color; context.beginPath();
    context.moveTo(...points[0]); context.lineTo(...points[i]); context.stroke();
  }
}
$("tracking").onclick = () => {
  if (tracking) {
    stopTracking();
    return;
  }
  if (!state.result || !stream) {
    note("Fit a calibration and connect its camera first.", true);
    return;
  }
  tracking = true;
  const generation = ++trackGeneration;
  $("trackVideo").srcObject = stream;
  trackingOverlay(null);
  updateTrackingPreview();
  lastPoseText = lastTrackCompletion = 0;
  $("tracking").textContent = "Stop tracking";
  note(
    "Tracking tag pose. Frame processing is sequential; the preview is not a synchronized VIO stream.",
  );
  trackLoop(generation);
};
async function trackLoop(generation) {
  if (!tracking || generation !== trackGeneration) return;
  try {
    const started = performance.now();
    const d = await trackingFrame();
    if (!tracking || generation !== trackGeneration) return;
    const now = performance.now();
    const interval = lastTrackCompletion ? now - lastTrackCompletion : now - started;
    lastTrackCompletion = now;
    $("trackingRate").textContent = `Pose updates: ${(1000 / interval).toFixed(1)} / second · response ${(now - started).toFixed(0)} ms · vision ${d.processing_ms.toFixed(0)} ms · ${d.input_size.join(" × ")} pixels`;
    const p = d.poses[0];
    trackingOverlay(p);
    $("boardTrackingReport").textContent = p?.id === "board"
      ? `${p.tag_count ? p.tag_count + " tags · " : ""}${p.corner_count} corners · ${p.inlier_count} inliers · RMS ${p.rms.toFixed(3)} px · inlier RMS ${p.inlier_rms.toFixed(3)} px · P95 ${p.p95.toFixed(3)} px · max ${p.max_error.toFixed(3)} px`
      : $("trackTarget").value === "board" ? "Target not found: show at least three grid tags, or the whole checkerboard. No current board pose." : "";
    $("boardTagErrors").hidden = !p?.per_tag?.length;
    if (p?.per_tag?.length && now-lastPoseText >= 200)
      $("boardTagErrorList").textContent = [...p.per_tag].sort((a,b)=>a.id-b.id).map(tag=>`Tag ${tag.id}: ${tag.rms.toFixed(3)} px`).join(" · ");
    drawPose(p || null);
    if (p) {
      poseLog.push({ timestamp: d.timestamp, session: state.session, ...p });
      if (poseLog.length > 10000) poseLog.shift();
      if (now - lastPoseText >= 200) {
      lastPoseText = now;
        const heading = document.createElement("h3");
        heading.textContent = p.id === "board" ? "Calibration target" : `Tag ${p.id}`;
        const translation = MathUI.element(
          String.raw`\mathbf t_{\mathrm{cam}\leftarrow\mathrm{${p.id === "board" ? "board" : "tag"}}}=` +
            MathUI.matrix(
              p.translation.map((v) => [v]),
              4,
            ) +
            String.raw`\,\mathrm m`,
          true,
        );
        const rotation = MathUI.element(
          String.raw`\mathbf R_{\mathrm{cam}\leftarrow\mathrm{${p.id === "board" ? "board" : "tag"}}}=` +
            MathUI.matrix(p.rotation, 4),
          true,
        );
        const error = MathUI.element(
          String.raw`\operatorname{RMS}=${p.rms.toFixed(3)}\,\mathrm{px}`,
        );
        const warning = document.createElement("p");
        warning.textContent = p.id === "board"
          ? `${p.ambiguous ? "⚠ Planar board pose is ambiguous. " : ""}${p.origin}. Error includes all detected corners, including rejected ones; pose uses a robust fit. This is a live pose-fit check, not an independent calibration score.`
          : p.ambiguous
          ? "⚠ Planar pose is ambiguous."
          : p.small_tag ? "Small tag: depth may be noisy. Move closer or choose Native detail."
          : "Pose selected by positive depth and pixel error.";
        $("poseText").replaceChildren(
          heading,
          translation,
          rotation,
          error,
          warning,
        );
      }
    } else {
      $("poseText").textContent = $("trackTarget").value === "board"
        ? "Calibration target not found or insufficient reliable corners. Show more of the board and hold steady."
        : d.rejected.length
        ? "Tag found, but its pose failed the pixel-error check. Hold steady or improve lighting."
        : "Selected tag not detected. Move closer or choose Native detail. No current pose.";
    }
  } catch (e) {
    if (!tracking || generation !== trackGeneration) return;
    note(e.message, true);
    stopTracking();
  }
  if (tracking && generation === trackGeneration) {
    const video = $("video");
    if (video.requestVideoFrameCallback)
      trackFrameCallback = video.requestVideoFrameCallback(() => trackLoop(generation));
    else setTimeout(() => trackLoop(generation), 16);
  }
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
    x.fillText(`${p.id === "board" ? "Board origin" : "Tag " + p.id} · top view`, px + 12, py);
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
action(async () => {
  await generate();
  const saved = await api({ op: "state" });
  if (saved.session) {
    adoptSession(saved);
    render();
    if (saved.views.length) go("review");
    note(
      `Restored ${saved.views.length} saved views. Review thumbnails or continue guided capture.`,
    );
  }
});
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
  $("distortionLabel").replaceChildren(
    MathUI.element(String.raw`k_1=${k.toFixed(2)}`),
    ` · ${k < 0 ? "Barrel" : k > 0 ? "Pincushion" : "No radial distortion"}`,
  );
}
$("distortionK").oninput = drawDistortion;
drawDistortion();
