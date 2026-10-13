"""Newline JSON worker. Saved source frames are lossless PNG, never resized."""

import os

os.environ.setdefault("OPENCV_OPENCL_RUNTIME", "disabled")
import sys, json, base64, time, uuid, pathlib, cv2, numpy as np
from targets import detect, svg, DICT, validate
from calibration import calibrate, project, pose
from exports import exports, target_config
from observations import thumbnail, board_outline
from tracking import selected_corners
import yaml

ROOT = pathlib.Path("data")
ROOT.mkdir(exist_ok=True)
cv2.ocl.setUseOpenCL(False)
views = []
result = None
config = None
size = None
session = None



def decode(s):
    raw = base64.b64decode(s.split(",")[-1])
    frame = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("Invalid image")
    if frame.shape[0] * frame.shape[1] > 12000000:
        raise ValueError("Image too large")
    return frame


def png(frame):
    return (
        "data:image/png;base64,"
        + base64.b64encode(cv2.imencode(".png", frame)[1]).decode()
    )


def persist():
    if session:
        (ROOT / session / "session.tmp").write_text(
            json.dumps(
                dict(config=config, size=size, views=views, result=result), indent=2
            )
        )
        (ROOT / session / "session.tmp").replace(ROOT / session / "session.json")


def summary():
    for view in views:
        if "outline" not in view and size:
            view["outline"] = board_outline(
                np.float64(view["object"]), np.float64(view["image"]), config, size
            )
        if "thumbnail" not in view:
            frame = cv2.imread(str(ROOT / session / f"{view['id']:04d}.png"))
            if frame is not None:
                view["thumbnail"] = thumbnail(frame)
    return dict(
        session=session,
        views=[
            {k: v for k, v in x.items() if k not in ("object", "image")} for x in views
        ],
        result=result,
    )


def handle(q):
    global views, result, config, size, session
    op = q["op"]
    if op == "state":
        return dict(**summary(), config=config, size=size)
    if op == "health":
        return dict(
            app="Camera Calibration Lab",
            opencv=cv2.__version__,
            models=["radtan", "fisheye"],
        )
    if op == "target":
        return dict(
            svg=svg(q["config"], q.get("single", False)),
            yaml=yaml.safe_dump(target_config(q["config"]), sort_keys=False),
        )
    if op == "new":
        validate(q["config"])
        config = q["config"]
        views = []
        result = None
        size = None
        session = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
        (ROOT / session).mkdir()
        persist()
        return summary()
    if op == "sessions":
        return dict(
            sessions=sorted(
                [p.name for p in ROOT.iterdir() if (p / "session.json").exists()],
                reverse=True,
            )
        )
    if op == "load":
        name = q["session"]
        if name not in [p.name for p in ROOT.iterdir() if p.is_dir()]:
            raise ValueError("Unknown session")
        state = json.loads((ROOT / name / "session.json").read_text())
        session = name
        config = state["config"]
        size = state["size"]
        views = state["views"]
        result = state["result"]
        return dict(**summary(), config=config)
    if op == "capture":
        if config is None:
            raise ValueError("Create a target/session first")
        frame = decode(q["frame"])
        s = list(frame.shape[1::-1])
        if size and size != s:
            raise ValueError(
                "Resolution changed. Start a new session; calibration is resolution-specific."
            )
        found = detect(frame, config)
        if found is None:
            raise ValueError(
                "Target not detected. Show all checkerboard corners or at least 3 AprilGrid tags, improve light and hold still."
            )
        obj, p, ids = found
        size = s
        i = len(views)
        if not cv2.imwrite(str(ROOT / session / f"{i:04d}.png"), frame):
            raise ValueError(
                "Cannot save frame. Check available disk space and folder permissions."
            )
        v = dict(
            id=i,
            source=str(q.get("source", "browser stream"))[:200],
            captured_at=time.time(),
            object=obj.tolist(),
            image=p.tolist(),
            enabled=True,
            holdout=bool(q.get("holdout")),
            points=len(p),
            thumbnail=thumbnail(frame),
            outline=board_outline(obj, p, config, size),
            guide_step=q.get("guideStep"),
            tags=ids,
            sharpness=float(
                cv2.Laplacian(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var()
            ),
            center=(p.mean(0) / np.array(size)).tolist(),
        )
        views.append(v)
        result = None
        persist()
        for point in p:
            cv2.circle(frame, tuple(point.astype(int)), 4, (60, 230, 120), -1)
        return dict(**summary(), overlay=png(frame))
    if op == "select":
        for v in views:
            s = q["selection"].get(str(v["id"]), {})
            v["enabled"] = bool(s.get("enabled", v["enabled"]))
            v["holdout"] = bool(s.get("holdout", v["holdout"]))
        result = None
        persist()
        return summary()
    if op == "calibrate":
        if not size:
            raise ValueError("Capture images first")
        result = calibrate(views, size, q["model"])
        persist()
        return summary()
    if op == "export":
        if not result:
            raise ValueError("Calibrate first")
        files = exports(result, config)
        for n, data in files.items():
            (ROOT / session / n).write_text(data)
        return dict(files=files)
    if op == "view":
        i = int(q["id"])
        if not any(v["id"] == i for v in views):
            raise ValueError("Unknown view")
        frame = cv2.imread(str(ROOT / session / f"{i:04d}.png"))
        if frame is None:
            raise ValueError("Saved image is unavailable")
        return dict(image=png(frame))
    if op == "preview_geometry":
        if not result:
            raise ValueError("Calibrate first")
        K, D = np.array(result["K"]), np.array(result["D"])
        wh = tuple(result["size"])
        balance = 1.0 if q.get("keep_border", True) else 0.0
        if result["model"] == "fisheye":
            newK = cv2.fisheye.estimateNewCameraMatrixForUndistortRectify(K, D, wh, np.eye(3), balance=balance)
        else:
            newK, _ = cv2.getOptimalNewCameraMatrix(K, D, wh, balance, wh)
        return dict(K=K.tolist(), D=D.flatten().tolist(), newK=newK.tolist(), size=list(wh), model=result["model"])
    if op == "preview":
        if not result:
            raise ValueError("Calibrate first")
        i = int(q["id"])
        v = next(v for v in views if v["id"] == i)
        frame = cv2.imread(str(ROOT / session / f"{i:04d}.png"))
        K = np.array(result["K"])
        D = np.array(result["D"])
        wh = tuple(result["size"])
        if result["model"] == "fisheye":
            newK = cv2.fisheye.estimateNewCameraMatrixForUndistortRectify(
                K, D, wh, np.eye(3), balance=float(q.get("balance", 0))
            )
            und = cv2.fisheye.undistortImage(frame, K, D, Knew=newK)
        else:
            newK, _ = cv2.getOptimalNewCameraMatrix(
                K, D, wh, float(q.get("balance", 0)), wh
            )
            und = cv2.undistort(frame, K, D, None, newK)
        r, t = pose(
            np.float32(v["object"]), np.float32(v["image"]), K, D, result["model"]
        )
        pred = project(np.float32(v["object"]), r, t, K, D, result["model"])
        for observed, projected in zip(v["image"], pred):
            a = tuple(np.int32(observed))
            b = tuple(np.int32(projected))
            cv2.circle(frame, a, 3, (0, 255, 0), -1)
            cv2.circle(frame, b, 5, (0, 0, 255), 1)
        return dict(original=png(frame), undistorted=png(und), newK=newK.tolist())
    if op == "track":
        if not result:
            raise ValueError("Calibrate first")
        started = time.perf_counter()
        if q.get("encoding") == "gray8":
            width, height = int(q["width"]), int(q["height"])
            if width <= 0 or height <= 0 or width * height > 12000000:
                raise ValueError("Invalid grayscale frame dimensions")
            raw = base64.b64decode(q["frame"], validate=True)
            if len(raw) != width * height:
                raise ValueError("Invalid grayscale frame length")
            frame = np.frombuffer(raw, np.uint8).reshape(height, width)
        else:
            frame = decode(q["frame"])
        input_size = list(frame.shape[1::-1])
        source_size = q.get("source_size", input_size)
        if source_size != result["size"]:
            raise ValueError("Tracking resolution must match calibration")
        width, height = input_size
        native_width, native_height = source_size
        if (width > native_width or height > native_height or width < 128
                or abs(height - round(native_height * width / native_width)) > 1):
            raise ValueError("Invalid tracking resize; preserve the full camera view")
        pixel_scale = np.float64([native_width/width, native_height/height])
        max_rms = float(q.get("max_rms", 3.0))
        tag_id = int(q.get("id", 0))
        if not np.isfinite(max_rms) or not .1 <= max_rms <= 20 or not 0 <= tag_id < DICT.bytesList.shape[0]:
            raise ValueError("Invalid tracking quality settings")
        s = float(q["tagSize"])
        scale = float(q.get("scale", 1))
        if not 0.001 <= s <= 2 or not 0 < scale <= 1000:
            raise ValueError("Invalid size or scale")
        K = np.array(result["K"])
        D = np.array(result["D"])
        detection_started = time.perf_counter()
        cs, detection_size, fallback = selected_corners(frame, tag_id, q.get("detector_width", 960))
        detection_ms = (time.perf_counter()-detection_started)*1000
        rejected = []
        poses = []
        obj = np.float64(
            [
                [-s / 2, s / 2, 0],
                [s / 2, s / 2, 0],
                [s / 2, -s / 2, 0],
                [-s / 2, -s / 2, 0],
            ]
        )
        for p in cs:
            i = tag_id
            tag_pixels = float(np.min(np.linalg.norm(p.reshape(4,2)-np.roll(p.reshape(4,2),-1,axis=0),axis=1)))
            # Pixel-center mapping preserves the original K and distorted pixel geometry.
            p = (p.astype(np.float64) + .5) * pixel_scale - .5
            points = p.reshape(4, 1, 2).astype(np.float64)
            dist = D
            if result["model"] == "fisheye":
                points = cv2.fisheye.undistortPoints(points, K, D, P=K)
                dist = None
            n, rs, ts, _ = cv2.solvePnPGeneric(
                obj, points, K, dist, flags=cv2.SOLVEPNP_IPPE_SQUARE
            )
            candidates = []
            for r, t in zip(rs, ts):
                rotation = cv2.Rodrigues(r)[0]
                if np.all((obj @ rotation.T + t.ravel())[:, 2] > 0):
                    error = float(
                        np.sqrt(
                            np.mean(
                                np.sum(
                                    (
                                        project(obj, r, t, K, D, result["model"])
                                        - p.reshape(4, 2)
                                    )
                                    ** 2,
                                    axis=1,
                                )
                            )
                        )
                    )
                    if np.isfinite(error) and np.all(np.isfinite(t)):
                        candidates.append((error, r, t))
            candidates.sort(key=lambda x: x[0])
            if not candidates:
                continue
            error, r, t = candidates[0]
            if error > max_rms:
                rejected.append(dict(id=tag_id, rms=error, reason="Reprojection error exceeds limit"))
                continue
            R = cv2.Rodrigues(r)[0]
            translation = (t.ravel() * scale).tolist()
            poses.append(
                dict(
                    id=int(i),
                    translation=translation,
                    rotation=R.tolist(),
                    rvec=r.ravel().tolist(),
                    rms=error,
                    tag_pixels=tag_pixels,
                    small_tag=tag_pixels < 24,
                    tag_size_meters=s,
                    translation_scale=scale,
                    alternative_rms=candidates[1][0] if len(candidates) > 1 else None,
                    ambiguous=len(candidates) > 1 and candidates[1][0] - error < 0.2,
                )
            )
            axis = np.float64([[0, 0, 0], [s / 2, 0, 0], [0, s / 2, 0], [0, 0, s / 2]])
            pix = project(axis, r, t, K, D, result["model"]).astype(int)
            poses[-1]["axis_pixels"] = pix.tolist()
            poses[-1]["corners"] = p.reshape(4, 2).tolist()
            if not q.get("compact"):
                for j, color in [(1, (0, 0, 255)), (2, (0, 255, 0)), (3, (255, 0, 0))]:
                    display_pix = ((pix+.5)/pixel_scale-.5).astype(int)
                    cv2.line(frame, tuple(display_pix[0]), tuple(display_pix[j]), color, 3)
        response = dict(poses=poses, timestamp=time.time(), processing_ms=(time.perf_counter()-started)*1000,
                        detection_ms=detection_ms, input_size=input_size, detection_size=detection_size,
                        full_resolution_fallback=fallback, rejected=rejected)
        if not q.get("compact"):
            response["overlay"] = png(frame)
        return response
    raise ValueError("Unknown operation")


if __name__ == "__main__":
    import signal

    signal.signal(signal.SIGINT, signal.SIG_IGN)  # Rust owns graceful shutdown.
    if os.environ.get("CALIB_RESUME_SESSION"):
        handle(dict(op="load", session=os.environ["CALIB_RESUME_SESSION"]))
    for line in sys.stdin:
        try:
            answer = handle(json.loads(line))
            print(json.dumps(answer, allow_nan=False), flush=True)
        except Exception as e:
            print(json.dumps({"error": str(e)}), flush=True)
