# Camera Calibration Lab

A local web app for teaching and performing **single-camera intrinsic calibration**, then measuring an AprilTag’s position and orientation. Includes a direct path that skips the lesson.

## Run

On this Mac, double-click `Open Calibration Lab.command`. The browser opens **http://localhost:8765**. The Rust server binds only to loopback; nothing uploads to a cloud service.

For a new machine:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
CALIB_PYTHON="$PWD/.venv/bin/python" cargo run
```

Python 3.12, Rust/Cargo and a Chromium-compatible browser or Safari are required. Allow camera access when the browser asks. Select DECXIN, connect, and check **actual** stream dimensions. Stop other apps that occupy the camera. Camera access requires localhost or HTTPS; this server intentionally is not a remote camera service.

## Workflow

1. Read the interactive lesson or click **Skip tutorial**.
2. Configure a checkerboard (internal corners, square size) or AprilGrid (tag36h11, rows, columns, black-edge size, gap ratio).
3. Download the metric SVG or print. Use **100% actual size**, suitable paper and a flat rigid backing. Measure the result and update the element size. The default grid is 237.5 mm square, larger than A4’s short edge: use larger paper or smaller tags. Printing software can still rescale; the ruler is the authority.
4. Create a session. Capture 20–40 sharp views with different positions, distances and tilts about two axes. Manual capture avoids control-refresh interruptions. Importing existing images also works. Resolution changes are rejected within a session.
5. Capture 5–10 additional diverse views with **validation only** checked. These never fit the intrinsic parameters.
6. Fit a model, inspect each view, uncheck suspicious views and **refit**. High-error suggestions only alter checkboxes; they do not silently delete data. Add more edge views if coverage is weak. Do not remove difficult valid views just to improve the score.
7. Inspect observed/reprojected corners and undistortion. Export ROS, OpenCV, Kalibr and target YAML plus the JSON report. The undistorted preview has a **new K**, separate from original-image calibration.
8. Configure the tracking tag’s measured black edge and ID, print it, reconnect at the calibrated resolution and track. The tag-center translation is in metres multiplied by the explicit scale parameter. Rotation maps tag coordinates into camera coordinates. Camera optical frame: X right, Y down, Z forward. Tag frame: X right, Y up, Z out of the printed face. Pose logs include timestamps and ambiguity information.

## Methods and precision

- Rust/Axum owns the HTTP server and serializes requests to a long-lived, replaceable Python worker. Python/OpenCV supplies the established numerical routines; this is **not a native Rust port of Kalibr**.
- Checkerboard: OpenCV `findChessboardCornersSB` with exhaustive/accuracy options. AprilGrid: AprilTag 36h11 dictionary with subpixel corner refinement and metric corner correspondences. IDs start at zero, bottom row left-to-right, matching Kalibr’s layout. Do not include unrelated copies of the same tag IDs.
- Moderate-angle model: pinhole/radtan, `[k1,k2,p1,p2]`, fixed k3 and zero skew. OpenCV `calibrateCameraExtended` jointly fits intrinsics/distortion and per-view extrinsics. Optional equidistant model: OpenCV fisheye four angular coefficients, fixed skew, recomputed extrinsics and condition checking.
- Errors use Euclidean corner distance: `sqrt(mean(dx² + dy²))` in pixels. Per-view RMS and 95th percentile are shown; validation summary is the RMS of per-view RMS values (equal view weighting). Stored residuals let you analyze systematic errors. Intrinsic standard deviations are reported for radtan; these are optimizer estimates, not a guarantee of true accuracy.
- AprilTag pose uses `solvePnPGeneric(IPPE_SQUARE)`, evaluates both candidates with the calibrated distortion model, rejects negative depth and selects minimum reprojection RMS. A close second solution triggers an ambiguity flag. Fisheye points are undistorted before PnP; scoring is on original distorted pixels.
- The default 0.5 px review threshold is a useful starting goal, **not a universal VIO acceptance standard**. Board flatness, detector bias, focus, coverage, diversity and held-out performance matter. Refit with different subsets and check parameter stability before critical use.
- There is no claim of demonstrated Kalibr-level real-world accuracy. Kalibr offers other models, robust estimation, multi-camera optimization and camera–IMU/time calibration that this app does not implement. Mono intrinsics plus tag pose are not stereo extrinsics, VIO or arbitrary-scene depth.

## Capture and data

All frames saved by this app are **lossless PNG at the actual browser stream resolution**. Browser capture does not expose Bayer sensor RAW and does not guarantee YUYV rather than MJPEG at the USB transport. A PNG cannot reverse earlier camera compression or processing. Imported JPEGs likewise retain their original information limits. This app deliberately does not fabricate ISO, gain or UVC settings the browser cannot access; use the existing native DECXIN control tool to lock those before connecting here.

Sessions live in `data/<date-id>/`: source PNGs, detected metric/image points, selections, calibration report and exports. Original captures are retained when excluded. A selection change requires a new fit. Saved sessions can be loaded through the sidebar. Host receive timestamps in the pose log are not hardware exposure timestamps or IMU synchronization.

## Extend

- `src/main.rs`: Rust server and worker transport.
- `vision/targets.py`: target definition, detection, true-size SVG.
- `vision/calibration.py`: model-specific fitting, projection, validation.
- `vision/exports.py`: explicit format adapters.
- `vision/worker.py`: session persistence, images and tag pose.
- `web/math.js`: explicit LaTeX rendering for equations, inline notation and live matrices; vendored KaTeX 0.19.0 and fonts work offline (MIT license in `web/vendor/katex/LICENSE`). YAML/configuration code stays literal.
- `web/index.html`, `style.css`, `app.js`: offline teaching content and browser workflow. No frontend build tool or CDN.
- `tests/test_geometry.py`: numerical recovery, held-out isolation, metric pose, target correspondences and export contracts.
- `tests/make_demo.py`: rendered synthetic camera images for manual UI integration tests. **These are demo inputs, never evidence of a physical camera’s calibration.**

Run `python -m unittest discover -s tests -v`, `cargo test`, and `node --check web/app.js` in the configured environment. `codegraph init -i .` initializes the code index; `codegraph sync .` updates it after edits. Git is initialized on `codex/calibration-lab`.

## Primary references

- [OpenCV calibration and PnP](https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html)
- [OpenCV fisheye equations](https://docs.opencv.org/4.x/db/d58/group__calib3d__fisheye.html)
- [Kalibr target practice and sizes](https://github.com/ethz-asl/kalibr/wiki/Calibration-targets)
- [Kalibr AprilGrid geometry source](https://github.com/ethz-asl/kalibr/blob/master/aslam_cv/aslam_cameras_april/src/GridCalibrationTargetAprilgrid.cpp)
- [Kalibr YAML and coefficient order](https://github.com/ethz-asl/kalibr/wiki/yaml-formats)
- [ROS CameraInfo contract](https://github.com/ros/common_msgs/blob/noetic-devel/sensor_msgs/msg/CameraInfo.msg)
- [OpenVINS calibration practice](https://docs.openvins.com/gs-calibration.html)
- [ORB-SLAM3 models](https://github.com/UZ-SLAMLab/ORB_SLAM3)

The lesson also includes linked real EuRoC and TUM VI configurations from OpenVINS and the Open3D reconstruction contract. These are examples for reading formats, not values to apply to another camera.
