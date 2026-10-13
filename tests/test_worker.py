"""Session/PNG persistence contracts and tracking through the actual worker API."""

import sys, pathlib, unittest, tempfile, base64

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "vision"))
import cv2, numpy as np
import worker
from calibration import project
from targets import DICT


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        worker.ROOT = pathlib.Path(self.directory.name)
        worker.views = []
        worker.result = None
        worker.config = None
        worker.size = None
        worker.session = None

    def tearDown(self):
        self.directory.cleanup()

    def encode(self, image):
        return base64.b64encode(cv2.imencode(".png", image)[1]).decode()

    def board(self):
        image = np.ones((430, 610, 3), np.uint8) * 255
        for y in range(7):
            for x in range(10):
                if (x + y) % 2 == 0:
                    image[
                        40 + y * 50 : 40 + (y + 1) * 50, 40 + x * 50 : 40 + (x + 1) * 50
                    ] = 0
        return image

    def test_lossless_capture_selection_and_reload(self):
        worker.handle(
            dict(
                op="new",
                config=dict(
                    type="checkerboard", cols=9, rows=6, size=0.025, spacing=0.3
                ),
            )
        )
        original = self.board()
        response = worker.handle(
            dict(op="capture", frame=self.encode(original), holdout=True)
        )
        name = response["session"]
        np.testing.assert_array_equal(
            cv2.imread(str(worker.ROOT / name / "0000.png")), original
        )
        worker.handle(
            dict(op="select", selection={"0": dict(enabled=False, holdout=True)})
        )
        worker.views = []
        loaded = worker.handle(dict(op="load", session=name))
        self.assertFalse(loaded["views"][0]["enabled"])
        self.assertTrue(loaded["views"][0]["holdout"])
        self.assertIsNone(loaded["result"])
        self.assertFalse((worker.ROOT / name / "session.tmp").exists())
        with self.assertRaisesRegex(ValueError, "Resolution changed"):
            worker.handle(
                dict(op="capture", frame=self.encode(cv2.resize(original, (305, 215))))
            )

    def test_actual_tag_tracking_and_translation_scale(self):
        K = np.float64([[800, 0, 640], [0, 800, 400], [0, 0, 1]])
        D = np.zeros(4)
        s = 0.1
        obj = np.float64(
            [
                [-s / 2, s / 2, 0],
                [s / 2, s / 2, 0],
                [s / 2, -s / 2, 0],
                [-s / 2, -s / 2, 0],
            ]
        )
        r = np.float64([[2.8], [0.1], [0.2]])
        t = np.float64([[0.05], [0.03], [0.8]])
        p = project(obj, r, t, K, D, "radtan").astype(np.float32)
        H = cv2.getPerspectiveTransform(
            np.float32([[0, 0], [400, 0], [400, 400], [0, 400]]), p
        )
        marker = cv2.aruco.generateImageMarker(DICT, 0, 400)
        image = cv2.warpPerspective(marker, H, (1280, 800), borderValue=255)
        worker.result = dict(
            K=K.tolist(), D=D.tolist(), model="radtan", size=[1280, 800]
        )
        q = dict(op="track", frame=self.encode(image), tagSize=s, scale=1, id=0)
        a = worker.handle(q)["poses"][0]
        q["scale"] = 2
        b = worker.handle(q)["poses"][0]
        self.assertLess(abs(a["translation"][2] - 0.8), 0.02)
        np.testing.assert_allclose(
            b["translation"], np.array(a["translation"]) * 2, atol=1e-8
        )
        self.assertEqual(b["translation_scale"], 2)
        self.assertIn("alternative_rms", b)
        q["frame"] = self.encode(cv2.resize(image, (640, 400)))
        with self.assertRaisesRegex(ValueError, "resolution"):
            worker.handle(q)


if __name__ == "__main__":
    unittest.main()
