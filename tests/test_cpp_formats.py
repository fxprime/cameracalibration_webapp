import pathlib, sys, tempfile, subprocess, shutil, unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "vision"))
import cv2, numpy as np
from exports import exports


class CppAndFormatsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        compiler = shutil.which("clang++") or shutil.which("g++")
        if not compiler:
            raise unittest.SkipTest("C++17 compiler unavailable")
        cls.temp = tempfile.TemporaryDirectory()
        cls.binary = pathlib.Path(cls.temp.name) / "radial_fov"
        source = (
            pathlib.Path(__file__).resolve().parents[1] / "examples/cpp/radial_fov.cpp"
        )
        subprocess.run(
            [compiler, "-std=c++17", "-O2", str(source), "-o", str(cls.binary)],
            check=True,
        )

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_cpp_fov_matches_opencv_inverse_projection(self):
        K = np.float64([[1350, 0, 960], [0, 1350, 600], [0, 0, 1]])
        pixel = np.float64([[[1920, 600]]])
        for model in ["pinhole", "kb"]:
            for k in [-0.15, 0, 0.1]:
                actual = float(
                    subprocess.check_output(
                        [str(self.binary), model, "1920", "1350", str(k)], text=True
                    )
                )
                D = np.float64([k, 0, 0, 0])
                if model == "kb":
                    ray = cv2.fisheye.undistortPoints(pixel, K, D)[0, 0]
                else:
                    ray = cv2.undistortPointsIter(
                        pixel, K, D, None, None, (3, 100, 1e-12)
                    )[0, 0]
                expected = 2 * np.degrees(np.arctan(np.linalg.norm(ray)))
                self.assertAlmostEqual(actual, expected, places=7)

    def test_invalid_branch_rejected(self):
        r = subprocess.run(
            [str(self.binary), "pinhole", "1920", "400", "-.2"],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("invertible", r.stderr)

    def test_vins_yaml_coefficient_order_and_opencv_reader(self):
        for model in ["radtan", "fisheye"]:
            r = dict(
                model=model,
                size=[1920, 1200],
                K=[[1350, 0, 960], [0, 1340, 600], [0, 0, 1]],
                D=[0.1, 0.02, 0.003, 0.0004],
            )
            c = dict(type="aprilgrid", rows=6, cols=6, size=0.025, spacing=0.3)
            text = exports(r, c)["vins-mono.yaml"]
            fs = cv2.FileStorage(text, cv2.FILE_STORAGE_READ | cv2.FILE_STORAGE_MEMORY)
            self.assertTrue(fs.isOpened())
            self.assertEqual(
                fs.getNode("model_type").string(),
                "KANNALA_BRANDT" if model == "fisheye" else "PINHOLE",
            )
            proj = fs.getNode("projection_parameters")
            if model == "fisheye":
                self.assertEqual(
                    [proj.getNode(k).real() for k in ["k2", "k3", "k4", "k5"]], r["D"]
                )
                self.assertEqual(proj.getNode("mu").real(), 1350)
                self.assertEqual(proj.getNode("u0").real(), 960)
            else:
                self.assertEqual(proj.getNode("fx").real(), 1350)
                self.assertEqual(
                    fs.getNode("distortion_parameters").getNode("p1").real(), 0.003
                )
            fs.release()


if __name__ == "__main__":
    unittest.main()
