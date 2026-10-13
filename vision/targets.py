"""Metric targets; IDs increase left-to-right from the bottom row (Kalibr layout)."""

import cv2, numpy as np

DICT = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_APRILTAG_36h11)


def validate(c):
    if c["type"] not in ("checkerboard", "aprilgrid"):
        raise ValueError("Unknown target")
    if not 2 <= int(c["cols"]) <= 20 or not 2 <= int(c["rows"]) <= 20:
        raise ValueError("Rows and columns must be 2–20")
    if not 0.002 <= float(c["size"]) <= 0.5:
        raise ValueError("Element size must be 2–500 mm")
    if not 0.1 <= float(c["spacing"]) <= 1:
        raise ValueError("Tag gap ratio must be 0.1–1")
    if c["rows"] * c["cols"] > DICT.bytesList.shape[0]:
        raise ValueError("Too many tags")


def detect(image, c):
    validate(c)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    cols, rows = int(c["cols"]), int(c["rows"])
    s = float(c["size"])
    if c["type"] == "checkerboard":
        ok, p = cv2.findChessboardCornersSB(
            gray,
            (cols, rows),
            cv2.CALIB_CB_EXHAUSTIVE
            | cv2.CALIB_CB_ACCURACY
            | cv2.CALIB_CB_NORMALIZE_IMAGE,
        )
        if not ok:
            return None
        obj = np.zeros((cols * rows, 3), np.float32)
        obj[:, :2] = np.mgrid[0:cols, 0:rows].T.reshape(-1, 2) * s
        return obj, p.reshape(-1, 2), []
    params = cv2.aruco.DetectorParameters()
    params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    corners, ids, _ = cv2.aruco.ArucoDetector(DICT, params).detectMarkers(gray)
    if ids is not None and len(set(ids.flatten().tolist())) != len(ids):
        raise ValueError("Duplicate tag IDs detected; hide unrelated tags.")
    obj = []
    img = []
    valid = []
    pitch = s * (1 + float(c["spacing"]))
    for p, i in zip(corners, ids.flatten() if ids is not None else []):
        if i >= cols * rows:
            continue
        if np.any(p[0] < 4) or np.any(p[0] > np.array(gray.shape[::-1]) - 4):
            continue
        # OpenCV canonical corners TL,TR,BR,BL; target +Y is up.
        x = (int(i) % cols) * pitch
        y = (int(i) // cols) * pitch
        obj.extend([[x, y + s, 0], [x + s, y + s, 0], [x + s, y, 0], [x, y, 0]])
        img.extend(p[0])
        valid.append(int(i))
    if len(valid) < 3:
        return None
    return np.float32(obj), np.float32(img), valid


def svg(c, single=False):
    validate(c)
    cols, rows = (1, 1) if single else (int(c["cols"]), int(c["rows"]))
    s = float(c["size"]) * 1000
    gap = s * float(c["spacing"])
    border = s
    w = (
        cols * s + (cols - 1) * gap
        if c["type"] == "aprilgrid" or single
        else (cols + 1) * s
    ) + 2 * border
    h = (
        rows * s + (rows - 1) * gap
        if c["type"] == "aprilgrid" or single
        else (rows + 1) * s
    ) + 2 * border
    # Center the black pattern on A4; page whitespace supplies the quiet border.
    pattern_width, pattern_height = w - 2 * border, h - 2 * border
    if pattern_width > 200 + 1e-9 or pattern_height > 287 + 1e-9:
        raise ValueError(
            f"Target black pattern is {pattern_width:.1f} × {pattern_height:.1f} mm; it does not fit A4 portrait with 5 mm margins. Reduce tag/square size or grid dimensions. It will not be scaled down."
        )
    dx, dy = (210 - w) / 2, (297 - h) / 2
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 210 297"><title>A4 calibration target — print at 100% actual size</title><rect width="210" height="297" fill="white"/><g transform="translate({dx} {dy})">'
    ]
    if c["type"] == "checkerboard" and not single:
        for y in range(rows + 1):
            for x in range(cols + 1):
                if (x + y) % 2 == 0:
                    parts.append(
                        f'<rect x="{border + x * s}" y="{border + y * s}" width="{s}" height="{s}"/>'
                    )
    else:
        for row in range(rows):
            for col in range(cols):
                i = int(c.get("id", 0)) if single else row * cols + col
                if not 0 <= i < DICT.bytesList.shape[0]:
                    raise ValueError("Invalid tag ID")
                marker = cv2.aruco.generateImageMarker(DICT, i, 8)
                step = s / 8
                for y in range(8):
                    for x in range(8):
                        if marker[y, x] == 0:
                            parts.append(
                                f'<rect x="{border + col * (s + gap) + x * step}" y="{border + (rows - 1 - row) * (s + gap) + y * step}" width="{step}" height="{step}"/>'
                            )
    parts.append("</g></svg>")
    return "".join(parts)
