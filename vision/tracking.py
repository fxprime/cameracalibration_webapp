"""Tracking-only coarse detection and guarded subpixel refinement; no calibration state."""
import cv2
import numpy as np
from targets import DICT

params = cv2.aruco.DetectorParameters()
params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
DETECTOR = cv2.aruco.ArucoDetector(DICT, params)


def selected_corners(frame, tag_id, detector_width=960):
    gray = frame if frame.ndim == 2 else cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape
    detector_width = int(detector_width)
    if not 128 <= detector_width <= 4096:
        raise ValueError("Invalid detector width")
    dw = min(width, detector_width)
    dh = max(1, round(height * dw / width))
    small = gray if dw == width else cv2.resize(gray, (dw, dh), interpolation=cv2.INTER_AREA)
    corners, ids, _ = DETECTOR.detectMarkers(small)
    selected = [p for p, i in zip(corners, ids.flatten() if ids is not None else []) if int(i) == tag_id]
    fallback = False
    if not selected and dw < width:
        # Native mode can recover tags which disappear during coarse detection.
        corners, ids, _ = DETECTOR.detectMarkers(gray)
        selected = [p for p, i in zip(corners, ids.flatten() if ids is not None else []) if int(i) == tag_id]
        dw, dh, fallback = width, height, True
    accepted = []
    for p in selected:
        points = ((p.reshape(4, 2) + .5) * np.float32([width/dw, height/dh]) - .5).astype(np.float32)
        side = float(np.min(np.linalg.norm(points - np.roll(points, -1, axis=0), axis=1)))
        if side < 12 or not cv2.isContourConvex(points):
            continue
        window = min(7, max(2, int(np.ceil(width/dw*2))), max(2, int(side/8)))
        refined = points.reshape(4, 1, 2).copy()
        cv2.cornerSubPix(gray, refined, (window, window), (-1, -1),
                         (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, .01))
        refined = refined.reshape(4, 2)
        if (np.max(np.linalg.norm(refined-points, axis=1)) > window*1.5
                or not cv2.isContourConvex(refined)
                or np.any(refined < 0) or np.any(refined >= [width, height])):
            continue
        accepted.append(refined.reshape(1, 4, 2))
    return accepted, [dw, dh], fallback
