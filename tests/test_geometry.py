import sys, pathlib, unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "vision"))
import cv2, numpy as np, yaml
from calibration import calibrate, project, pose
from targets import detect, svg, DICT
from exports import exports


class GeometryTests(unittest.TestCase):
    def dataset(self, model):
        rng = np.random.default_rng(42)
        K = np.float64([[830, 0, 640], [0, 825, 400], [0, 0, 1]])
        D = np.float64(
            [-0.13, 0.025, 0.001, -0.002]
            if model == "radtan"
            else [-0.03, 0.006, -0.001, 0.0002]
        )
        obj = np.zeros((54, 3), np.float32)
        obj[:, :2] = np.mgrid[0:9, 0:6].T.reshape(-1, 2) * 0.025
        views = []
        for i in range(28):
            r = rng.uniform(-0.65, 0.65, (3, 1))
            t = np.float64(
                [
                    [rng.uniform(-0.18, 0.08)],
                    [rng.uniform(-0.13, 0.08)],
                    [rng.uniform(0.45, 0.85)],
                ]
            )
            p = project(obj, r, t, K, D, model) + rng.normal(0, 0.035, (54, 2))
            views.append(
                dict(
                    id=i,
                    object=obj.tolist(),
                    image=p.tolist(),
                    enabled=True,
                    holdout=i >= 23,
                )
            )
        return K, D, views

    def test_recover_both_models(self):
        for model in ["radtan", "fisheye"]:
            K, D, views = self.dataset(model)
            r = calibrate(views, [1280, 800], model)
            self.assertLess(r["rms"], 0.08)
            self.assertLess(abs(r["K"][0][0] - K[0, 0]), 1)
            self.assertLess(abs(r["K"][1][1] - K[1, 1]), 1)
            self.assertLess(max(v["rms"] for v in r["views"] if v["holdout"]), 0.1)

    def test_holdouts_never_change_intrinsics(self):
        _, _, v = self.dataset("radtan")
        a = calibrate(v, [1280, 800], "radtan")
        v[-1]["image"] = (
            np.array(v[-1]["image"]) + np.random.default_rng(3).normal(0, 3, (54, 2))
        ).tolist()
        b = calibrate(v, [1280, 800], "radtan")
        np.testing.assert_array_equal(a["K"], b["K"])
        self.assertGreater(b["views"][-1]["rms"], 2)

    def test_exports(self):
        _, _, v = self.dataset("radtan")
        r = calibrate(v, [1280, 800], "radtan")
        f = exports(r, dict(type="aprilgrid", cols=6, rows=6, size=0.025, spacing=0.3))
        ros = yaml.safe_load(f["ros.yaml"])
        kal = yaml.safe_load(f["kalibr.yaml"])
        self.assertEqual(len(ros["distortion_coefficients"]["data"]), 5)
        self.assertEqual(len(kal["cam0"]["distortion_coeffs"]), 4)
        self.assertNotIn("T_cam_imu", kal["cam0"])

    def test_tag_metric_pose(self):
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
        p = project(obj, r, t, K, D, "radtan")
        _, rs, ts, _ = cv2.solvePnPGeneric(
            obj, p.reshape(4, 1, 2), K, D, flags=cv2.SOLVEPNP_IPPE_SQUARE
        )
        errors = [
            np.linalg.norm(project(obj, rr, tt, K, D, "radtan") - p)
            for rr, tt in zip(rs, ts)
        ]
        np.testing.assert_allclose(ts[np.argmin(errors)], t, atol=1e-8)

    def test_aprilgrid_corner_mapping(self):
        c = dict(type="aprilgrid", cols=3, rows=3, size=0.03, spacing=0.3)
        image = np.ones((650, 650, 3), np.uint8) * 255
        for row in range(3):
            for col in range(3):
                marker = cv2.aruco.generateImageMarker(DICT, row * 3 + col, 120)
                x = 80 + col * 156
                y = 80 + (2 - row) * 156
                image[y : y + 120, x : x + 120] = cv2.cvtColor(
                    marker, cv2.COLOR_GRAY2BGR
                )
        obj, p, ids = detect(image, c)
        self.assertEqual(len(ids), 9)
        expected = np.column_stack(
            [80 + obj[:, 0] * 4000, 80 + (0.108 - obj[:, 1]) * 4000]
        )
        self.assertLess(np.max(np.abs(expected - p)), 2)
        self.assertIn('width="168.0mm"', svg(c))

    def test_checkerboard_detection(self):
        c = dict(type="checkerboard", cols=9, rows=6, size=0.025, spacing=0.3)
        image = np.ones((430, 610, 3), np.uint8) * 255
        for y in range(7):
            for x in range(10):
                if (x + y) % 2 == 0:
                    image[
                        40 + y * 50 : 40 + (y + 1) * 50, 40 + x * 50 : 40 + (x + 1) * 50
                    ] = 0
        found = detect(image, c)
        self.assertIsNotNone(found)
        self.assertEqual(len(found[1]), 54)


if __name__ == "__main__":
    unittest.main()
