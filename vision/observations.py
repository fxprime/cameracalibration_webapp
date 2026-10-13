"""Preview-only metadata. Never changes calibration corners or original frames."""

import base64
import cv2
import numpy as np


def thumbnail(frame):
    scale = min(180 / frame.shape[1], 120 / frame.shape[0])
    small = cv2.resize(
        frame,
        (max(1, round(frame.shape[1] * scale)), max(1, round(frame.shape[0] * scale))),
        interpolation=cv2.INTER_AREA,
    )
    return (
        "data:image/png;base64,"
        + base64.b64encode(cv2.imencode(".png", small)[1]).decode()
    )


def board_outline(obj, p, config, size):
    s = float(config["size"])
    cols = int(config["cols"])
    rows = int(config["rows"])
    if config["type"] == "aprilgrid":
        width = s * (cols + (cols - 1) * config["spacing"])
        height = s * (rows + (rows - 1) * config["spacing"])
        corners = [[0, height], [width, height], [width, 0], [0, 0]]
    else:
        corners = [[-s, -s], [cols * s, -s], [cols * s, rows * s], [-s, rows * s]]
    H, _ = cv2.findHomography(np.float64(obj[:, :2]), np.float64(p), 0)
    if H is None:
        return None
    outline = cv2.perspectiveTransform(np.float64(corners).reshape(1, 4, 2), H)[
        0
    ] / np.array(size)
    return outline.tolist() if np.isfinite(outline).all() else None
