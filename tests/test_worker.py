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
        self.assertTrue(
            response["views"][0]["thumbnail"].startswith("data:image/png;base64,")
        )
        self.assertEqual(len(response["views"][0]["outline"]), 4)
        view = worker.handle(dict(op="view", id=0))
        decoded = cv2.imdecode(
            np.frombuffer(base64.b64decode(view["image"].split(",")[1]), np.uint8),
            cv2.IMREAD_COLOR,
        )
        np.testing.assert_array_equal(decoded, original)
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

    def test_coarse_detector_falls_back_for_a_tiny_tag(self):
        from tracking import selected_corners
        image = np.full((800,1280), 255, np.uint8)
        image[380:404,600:624] = cv2.aruco.generateImageMarker(DICT, 0, 24)
        corners, dimensions, fallback = selected_corners(image, 0, detector_width=128)
        self.assertTrue(fallback)
        self.assertEqual(dimensions, [1280,800])
        self.assertEqual(len(corners), 1)

    def test_resized_fisheye_pose_uses_original_camera_geometry(self):
        K = np.float64([[900,0,640],[0,890,400],[0,0,1]])
        D = np.float64([-.08,.008,-.001,.0001])
        r = np.float64([[2.8],[.1],[.15]])
        t = np.float64([[.04],[.02],[.6]])
        s = .1
        obj = np.float64([[-s/2,s/2,0],[s/2,s/2,0],[s/2,-s/2,0],[-s/2,-s/2,0]])
        corners = project(obj,r,t,K,D,"fisheye").astype(np.float32)
        H = cv2.getPerspectiveTransform(np.float32([[0,0],[400,0],[400,400],[0,400]]),corners)
        image = cv2.warpPerspective(cv2.aruco.generateImageMarker(DICT,0,400),H,(1280,800),borderValue=255)
        worker.result = dict(K=K.tolist(),D=D.tolist(),size=[1280,800],model="fisheye")
        for width in (1280,960,640):
            small=cv2.resize(image,(width,round(800*width/1280)),interpolation=cv2.INTER_AREA)
            response=worker.handle(dict(op="track",compact=True,frame=self.encode(small),source_size=[1280,800],tagSize=s))
            self.assertEqual(len(response["poses"]),1)
            np.testing.assert_allclose(response["poses"][0]["translation"],t.ravel(),atol=.015)
            np.testing.assert_allclose(response["poses"][0]["corners"],corners,atol=3)

    def test_live_checkerboard_diagnostics_through_worker_api(self):
        worker.config=dict(type="checkerboard",cols=9,rows=6,size=.025,spacing=.3)
        worker.result=dict(K=[[800,0,305],[0,800,215],[0,0,1]],D=[0,0,0,0],model="radtan",size=[610,430])
        response=worker.handle(dict(op="track",target="board",frame=self.encode(self.board()),scale=1))
        board=response["poses"][0]
        self.assertEqual(board["corner_count"],54)
        self.assertEqual(board["tag_count"],0)
        self.assertLess(board["rms"],.1)
        self.assertLess(abs(board["translation"][2]-.4),.005)
        import json
        json.dumps(response,allow_nan=False)

    def test_preview_geometry_matches_opencv_and_keeps_calibration(self):
        K = np.float64([[300, 0, 160], [0, 305, 120], [0, 0, 1]])
        for model in ("radtan", "fisheye"):
            D = np.float64([-0.2, 0.03, 0.001, -0.002])
            worker.result = dict(K=K.tolist(), D=D.tolist(), model=model, size=[320, 240])
            original = str(worker.result)
            matrices = []
            for keep in (False, True):
                geometry = worker.handle(dict(op="preview_geometry", keep_border=keep))
                if model == "fisheye":
                    expected = cv2.fisheye.estimateNewCameraMatrixForUndistortRectify(K, D, (320,240), np.eye(3), balance=float(keep))
                else:
                    expected, _ = cv2.getOptimalNewCameraMatrix(K, D, (320,240), float(keep), (320,240))
                np.testing.assert_allclose(geometry["newK"], expected)
                self.assertEqual(str(worker.result), original)
                matrices.append(geometry["newK"])
            self.assertLess(matrices[1][0][0], matrices[0][0][0])

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
        compact = worker.handle(dict(q, compact=True, encoding="gray8", width=1280, height=800,
                                     frame=base64.b64encode(image.tobytes()).decode()))
        self.assertNotIn("overlay", compact)
        self.assertGreaterEqual(compact["processing_ms"], 0)
        self.assertEqual(len(compact["poses"][0]["axis_pixels"]), 4)
        np.testing.assert_allclose(compact["poses"][0]["translation"], a["translation"], atol=1e-9)
        with self.assertRaisesRegex(ValueError, "frame length"):
            worker.handle(dict(q, compact=True, encoding="gray8", width=1280, height=800, frame="AA=="))
        for width in (640, 960):
            small = cv2.resize(image, (width, round(800*width/1280)), interpolation=cv2.INTER_AREA)
            resized = worker.handle(dict(q, compact=True, encoding="gray8", width=small.shape[1], height=small.shape[0],
                                         source_size=[1280,800], frame=base64.b64encode(small.tobytes()).decode()))
            self.assertEqual(resized["input_size"], list(small.shape[1::-1]))
            pose = resized["poses"][0]
            self.assertLess(abs(pose["translation"][2]-.8), .025)
            np.testing.assert_allclose(pose["corners"], p, atol=3)
            self.assertEqual(len(pose["axis_pixels"]), 4)
        with self.assertRaisesRegex(ValueError, "preserve"):
            worker.handle(dict(q, frame=self.encode(cv2.resize(image,(640,300))), source_size=[1280,800]))
        with self.assertRaisesRegex(ValueError, "quality"):
            worker.handle(dict(q, max_rms=float("nan")))
        from unittest.mock import patch
        with patch("worker.project", return_value=np.zeros((4,2))):
            rejected = worker.handle(dict(q, compact=True))
            self.assertFalse(rejected["poses"])
            self.assertEqual(rejected["rejected"][0]["reason"], "Reprojection error exceeds limit")
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
