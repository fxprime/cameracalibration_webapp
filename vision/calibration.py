"""OpenCV solvers with explicit model order and independently held-out views."""

import cv2, numpy as np


def project(obj, r, t, K, D, model):
    if model == "fisheye":
        return cv2.fisheye.projectPoints(np.float64(obj).reshape(-1, 1, 3), r, t, K, D)[
            0
        ].reshape(-1, 2)
    return cv2.projectPoints(obj, r, t, K, D)[0].reshape(-1, 2)


def pose(obj, img, K, D, model):
    points = np.float64(img).reshape(-1, 1, 2)
    if model == "fisheye":
        points = cv2.fisheye.undistortPoints(points, K, D, P=K)
        dist = None
    else:
        dist = D
    ok, r, t = cv2.solvePnP(
        np.float64(obj), points, K, dist, flags=cv2.SOLVEPNP_ITERATIVE
    )
    if not ok or t[2, 0] <= 0:
        raise ValueError("Invalid pose")
    return r, t


def calibrate(views, size, model):
    train = [v for v in views if v.get("enabled", True) and not v.get("holdout", False)]
    if len(train) < 10:
        raise ValueError(
            "Capture at least 10 training views; 20–40 varied views recommended."
        )
    obj = [np.float32(v["object"]) for v in train]
    img = [np.float32(v["image"]).reshape(-1, 1, 2) for v in train]
    uncertainty = None
    if model == "fisheye":
        rms, K, D, rs, ts = cv2.fisheye.calibrate(
            [np.float64(o).reshape(-1, 1, 3) for o in obj],
            [np.float64(p) for p in img],
            tuple(size),
            None,
            None,
            flags=cv2.fisheye.CALIB_RECOMPUTE_EXTRINSIC
            | cv2.fisheye.CALIB_CHECK_COND
            | cv2.fisheye.CALIB_FIX_SKEW,
            criteria=(3, 100, 1e-9),
        )
    elif model == "radtan":
        rms, K, D, rs, ts, std, _, _ = cv2.calibrateCameraExtended(
            obj,
            img,
            tuple(size),
            None,
            None,
            flags=cv2.CALIB_FIX_K3,
            criteria=(3, 100, 1e-9),
        )
        D = D.ravel()[:4]
        uncertainty = std.ravel().tolist()
    else:
        raise ValueError("Unknown camera model")
    if (
        not np.isfinite(K).all()
        or not np.isfinite(D).all()
        or min(K[0, 0], K[1, 1]) <= 0
    ):
        raise ValueError("Solver produced invalid intrinsics")
    metrics = []
    for v in views:
        if not v.get("enabled", True):
            continue
        r, t = pose(np.float32(v["object"]), np.float32(v["image"]), K, D, model)
        residual = project(np.float32(v["object"]), r, t, K, D, model) - np.float32(
            v["image"]
        )
        norms = np.linalg.norm(residual, axis=1)
        metrics.append(
            dict(
                id=v["id"],
                rms=float(np.sqrt(np.mean(norms**2))),
                p95=float(np.percentile(norms, 95)),
                holdout=v.get("holdout", False),
                residuals=residual.tolist(),
                rvec=r.ravel().tolist(),
                tvec=t.ravel().tolist(),
            )
        )
    points = np.concatenate(img).reshape(-1, 2)
    cells = set(
        (min(3, int(p[0] / size[0] * 4)), min(2, int(p[1] / size[1] * 3)))
        for p in points
    )
    normals = np.array([cv2.Rodrigues(r)[0][:, 2] for r in rs])
    depths = np.array([t.ravel()[2] for t in ts])
    diversity = dict(
        max_tilt_degrees=float(
            np.degrees(np.arccos(np.clip(np.min(np.abs(normals[:, 2])), 0, 1)))
        ),
        depth_ratio=float(depths.max() / depths.min()),
        depth_range_meters=[float(depths.min()), float(depths.max())],
    )
    warnings = []
    if np.max(np.abs(normals[:, 0])) < 0.25 or np.max(np.abs(normals[:, 1])) < 0.25:
        warnings.append(
            "Target tilt about both axes is insufficient. Capture oblique views in two directions."
        )
    if diversity["depth_ratio"] < 1.3:
        warnings.append("Target distances are similar. Mix near and far views.")
    if len(cells) < 10:
        warnings.append(
            "Image coverage is incomplete. Capture corners near all image edges."
        )
    if not any(m["holdout"] for m in metrics):
        warnings.append(
            "No held-out views: fitting error alone does not validate calibration."
        )
    if len(train) < 20:
        warnings.append("Collect 20–40 diverse views for stronger calibration.")
    if not 0 <= K[0, 2] < size[0] or not 0 <= K[1, 2] < size[1]:
        warnings.append(
            "Principal point lies outside the image; review model and poses."
        )
    return dict(
        model=model,
        size=list(size),
        K=K.tolist(),
        D=D.ravel().tolist(),
        rms=float(rms),
        views=metrics,
        coverage=len(cells) / 12,
        uncertainty=uncertainty,
        diversity=diversity,
        warnings=warnings,
    )
