import pathlib, sys, unittest, xml.etree.ElementTree as ET, re

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "vision"))
from targets import svg


class A4TargetTests(unittest.TestCase):
    def bounds(self, c, single=False):
        root = ET.fromstring(svg(c, single))
        self.assertEqual(root.attrib["width"], "210mm")
        self.assertEqual(root.attrib["height"], "297mm")
        ns = {"s": "http://www.w3.org/2000/svg"}
        group = root.find("s:g", ns)
        dx, dy = map(float, re.findall(r"[-\d.]+", group.attrib["transform"]))
        rects = group.findall("s:rect", ns)
        x0 = min(float(r.attrib["x"]) + dx for r in rects)
        x1 = max(float(r.attrib["x"]) + float(r.attrib["width"]) + dx for r in rects)
        y0 = min(float(r.attrib["y"]) + dy for r in rects)
        y1 = max(float(r.attrib["y"]) + float(r.attrib["height"]) + dy for r in rects)
        return x0, x1, y0, y1

    def test_single_tag_exact_size_and_center(self):
        for size in [0.002, 0.0223, 0.1, 0.2]:
            b = self.bounds(
                dict(type="aprilgrid", cols=6, rows=6, size=size, spacing=0.3, id=0),
                True,
            )
            self.assertAlmostEqual(b[1] - b[0], size * 1000)
            self.assertAlmostEqual(b[3] - b[2], size * 1000)
            self.assertAlmostEqual((b[0] + b[1]) / 2, 105)
            self.assertAlmostEqual((b[2] + b[3]) / 2, 148.5)

    def test_grid_center_and_spacing_preserved(self):
        b = self.bounds(
            dict(type="aprilgrid", cols=6, rows=6, size=0.0223, spacing=0.3)
        )
        self.assertAlmostEqual(b[1] - b[0], 167.25)
        self.assertAlmostEqual((b[0] + b[1]) / 2, 105)
        self.assertAlmostEqual((b[2] + b[3]) / 2, 148.5)

    def test_oversized_target_rejected(self):
        with self.assertRaisesRegex(ValueError, "will not be scaled"):
            svg(dict(type="aprilgrid", cols=6, rows=6, size=0.04, spacing=0.3))


if __name__ == "__main__":
    unittest.main()
