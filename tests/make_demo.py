"""Render a known pinhole camera for UI integration tests (not real calibration data)."""

import pathlib, sys, cv2, numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "vision"))
from calibration import project
from targets import DICT

out = pathlib.Path("data/demo-input")
out.mkdir(exist_ok=True)
rng = np.random.default_rng(18)
K = np.float64([[830, 0, 640], [0, 825, 400], [0, 0, 1]])
D = np.zeros(4)
board = np.ones((700, 1000), np.uint8) * 255
for y in range(7):
    for x in range(10):
        if (x + y) % 2 == 0:
            board[y * 100 : (y + 1) * 100, x * 100 : (x + 1) * 100] = 0
obj = np.float64([[0, 0, 0], [0.25, 0, 0], [0.25, 0.175, 0], [0, 0.175, 0]])
source = np.float32([[0, 0], [1000, 0], [1000, 700], [0, 700]])
i = 0
while i < 25:
    r = rng.uniform(-0.65, 0.65, (3, 1))
    t = np.float64(
        [
            [rng.uniform(-0.18, 0.02)],
            [rng.uniform(-0.15, 0.02)],
            [rng.uniform(0.4, 0.7)],
        ]
    )
    p = project(obj, r, t, K, D, "radtan").astype(np.float32)
    if np.any(p < [25, 25]) or np.any(p > [1255, 775]):
        continue
    H = cv2.getPerspectiveTransform(source, p)
    image = cv2.warpPerspective(
        board, H, (1280, 800), flags=cv2.INTER_LINEAR, borderValue=230
    )
    cv2.imwrite(str(out / f"view-{i:02d}.png"), image)
    i += 1
marker = cv2.aruco.generateImageMarker(DICT, 0, 400)
s = 0.1
obj = np.float64(
    [[-s / 2, s / 2, 0], [s / 2, s / 2, 0], [s / 2, -s / 2, 0], [-s / 2, -s / 2, 0]]
)
r = np.float64([[2.8], [0.1], [0.2]])
t = np.float64([[0.05], [0.03], [0.8]])
p = project(obj, r, t, K, D, "radtan").astype(np.float32)
H = cv2.getPerspectiveTransform(np.float32([[0, 0], [400, 0], [400, 400], [0, 400]]), p)
image = cv2.warpPerspective(marker, H, (1280, 800), borderValue=255)
cv2.imwrite(str(out / "tracking-tag.png"), image)
print(out.resolve())
