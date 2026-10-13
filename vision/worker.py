"""Newline JSON worker. Saved source frames are lossless PNG, never resized."""

import os

os.environ.setdefault("OPENCV_OPENCL_RUNTIME", "disabled")
import sys, json, base64, time, uuid, pathlib, cv2, numpy as np
from targets import detect, svg, DICT, validate
from calibration import calibrate, project, pose
from exports import exports, target_config
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
        frame = decode(q["frame"])
        if list(frame.shape[1::-1]) != result["size"]:
            raise ValueError("Tracking resolution must match calibration")
        s = float(q["tagSize"])
        scale = float(q.get("scale", 1))
        if not 0.001 <= s <= 2 or not 0 < scale <= 1000:
            raise ValueError("Invalid size or scale")
        K = np.array(result["K"])
        D = np.array(result["D"])
        params = cv2.aruco.DetectorParameters()
        params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
        cs, ids, _ = cv2.aruco.ArucoDetector(DICT, params).detectMarkers(frame)
        poses = []
        obj = np.float64(
            [
                [-s / 2, s / 2, 0],
                [s / 2, s / 2, 0],
                [s / 2, -s / 2, 0],
                [-s / 2, -s / 2, 0],
            ]
        )
        for p, i in zip(cs, ids.flatten() if ids is not None else []):
            if int(i) != int(q.get("id", 0)):
                continue
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
                if t[2, 0] > 0:
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
                    candidates.append((error, r, t))
            candidates.sort(key=lambda x: x[0])
            if not candidates:
                continue
            error, r, t = candidates[0]
            R = cv2.Rodrigues(r)[0]
            translation = (t.ravel() * scale).tolist()
            poses.append(
                dict(
                    id=int(i),
                    translation=translation,
                    rotation=R.tolist(),
                    rvec=r.ravel().tolist(),
                    rms=error,
                    tag_size_meters=s,
                    translation_scale=scale,
                    alternative_rms=candidates[1][0] if len(candidates) > 1 else None,
                    ambiguous=len(candidates) > 1 and candidates[1][0] - error < 0.2,
                )
            )
            axis = np.float64([[0, 0, 0], [s / 2, 0, 0], [0, s / 2, 0], [0, 0, s / 2]])
            pix = project(axis, r, t, K, D, result["model"]).astype(int)
            for j, color in [(1, (0, 0, 255)), (2, (0, 255, 0)), (3, (255, 0, 0))]:
                cv2.line(frame, tuple(pix[0]), tuple(pix[j]), color, 3)
        return dict(poses=poses, overlay=png(frame), timestamp=time.time())
    raise ValueError("Unknown operation")


if __name__ == "__main__":
    import signal

    signal.signal(signal.SIGINT, signal.SIG_IGN)  # Rust owns graceful shutdown.
    for line in sys.stdin:
        try:
            answer = handle(json.loads(line))
            print(json.dumps(answer, allow_nan=False), flush=True)
        except Exception as e:
            print(json.dumps({"error": str(e)}), flush=True)
