import cv2, numpy as np, yaml, tempfile, os, pathlib


def exports(r, c):
    K = np.array(r["K"])
    D = r["D"]
    w, h = r["size"]
    P = np.column_stack([K, np.zeros(3)])
    I = np.eye(3)
    mat = lambda x: dict(rows=x.shape[0], cols=x.shape[1], data=x.ravel().tolist())
    ros = dict(
        image_width=w,
        image_height=h,
        camera_name="decxin",
        camera_matrix=mat(K),
        distortion_model="equidistant" if r["model"] == "fisheye" else "plumb_bob",
        distortion_coefficients=mat(
            np.array(D if r["model"] == "fisheye" else D + [0.0]).reshape(1, -1)
        ),
        rectification_matrix=mat(I),
        projection_matrix=mat(P),
    )
    kal = dict(
        cam0=dict(
            camera_model="pinhole",
            intrinsics=[K[0, 0].item(), K[1, 1].item(), K[0, 2].item(), K[1, 2].item()],
            distortion_model="equidistant" if r["model"] == "fisheye" else "radtan",
            distortion_coeffs=D,
            resolution=[w, h],
            rostopic="/camera/image_raw",
            cam_overlaps=[],
        )
    )
    vins = dict(
        model_type="KANNALA_BRANDT" if r["model"] == "fisheye" else "PINHOLE",
        camera_name="decxin",
        image_width=w,
        image_height=h,
    )
    if r["model"] == "fisheye":
        vins["projection_parameters"] = dict(
            zip(
                ["k2", "k3", "k4", "k5", "mu", "mv", "u0", "v0"],
                D + [float(K[0, 0]), float(K[1, 1]), float(K[0, 2]), float(K[1, 2])],
            )
        )
    else:
        vins["distortion_parameters"] = dict(zip(["k1", "k2", "p1", "p2"], D))
        vins["projection_parameters"] = dict(
            fx=float(K[0, 0]), fy=float(K[1, 1]), cx=float(K[0, 2]), cy=float(K[1, 2])
        )
    target = target_config(c)
    fd, path = tempfile.mkstemp(suffix=".yaml")
    os.close(fd)
    try:
        fs = cv2.FileStorage(path, cv2.FILE_STORAGE_WRITE)
        fs.write("image_width", w)
        fs.write("image_height", h)
        fs.write("camera_model", r["model"])
        fs.write("camera_matrix", K)
        fs.write("distortion_coefficients", np.array(D))
        fs.release()
        opencv = pathlib.Path(path).read_text()
    finally:
        os.unlink(path)
    return {
        "ros.yaml": yaml.safe_dump(ros, sort_keys=False),
        "kalibr.yaml": yaml.safe_dump(kal, sort_keys=False),
        "target.yaml": yaml.safe_dump(target, sort_keys=False),
        "opencv.yaml": opencv,
        "vins-mono.yaml": "%YAML:1.0\n---\n" + yaml.safe_dump(vins, sort_keys=False),
        "report.json": __import__("json").dumps(r, indent=2),
    }


def target_config(c):
    target = dict(target_type=c["type"])
    if c["type"] == "aprilgrid":
        target.update(
            tagCols=c["cols"],
            tagRows=c["rows"],
            tagSize=c["size"],
            tagSpacing=c["spacing"],
        )
    else:
        target.update(
            targetCols=c["cols"],
            targetRows=c["rows"],
            rowSpacingMeters=c["size"],
            colSpacingMeters=c["size"],
        )
    return target
