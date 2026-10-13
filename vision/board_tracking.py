"""Live calibration-target pose and residual diagnostics, independent of session fitting."""
import cv2
import numpy as np
from targets import detect
from calibration import project


def track_board(frame, config, calibration, pixel_scale, max_error, translation_scale):
    gray = frame if frame.ndim == 2 else cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    observation = detect(cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR), config)
    if observation is None:
        return None
    obj, image, ids = observation
    obj = np.float64(obj)
    image = (np.float64(image) + .5) * pixel_scale - .5
    K, D = np.float64(calibration['K']), np.float64(calibration['D'])
    model = calibration['model']
    points = image.reshape(-1, 1, 2)
    dist = D
    if model == 'fisheye':
        points = cv2.fisheye.undistortPoints(points, K, D, P=K)
        dist = None
    ok, r, t, inliers = cv2.solvePnPRansac(
        obj, points, K, dist, iterationsCount=100,
        reprojectionError=max_error, confidence=.995, flags=cv2.SOLVEPNP_ITERATIVE)
    selected = inliers.flatten() if ok and inliers is not None else np.array([],dtype=int)
    # Strong fisheye correction can amplify ideal-image errors dramatically.
    # Compare a full-board seed in ORIGINAL distorted pixels, not that amplified space.
    initial_ok, initial_r, initial_t = cv2.solvePnP(obj,points,K,dist,flags=cv2.SOLVEPNP_ITERATIVE)
    if initial_ok:
        initial_errors = np.linalg.norm(project(obj,initial_r,initial_t,K,D,model)-image,axis=1)
        initial_mask = np.flatnonzero(initial_errors <= max_error)
        if len(initial_mask) > len(selected):
            selected = initial_mask
    if len(selected) < 6:
        return None
    # Evaluate both planar solutions rather than inheriting a single iterative seed.
    _, rs, ts, _ = cv2.solvePnPGeneric(obj[selected], points[selected], K, dist, flags=cv2.SOLVEPNP_IPPE)
    candidates = []
    for seed_r, seed_t in zip(rs,ts):
        fit_r, fit_t = cv2.solvePnPRefineLM(obj[selected], points[selected], K, dist, seed_r, seed_t)
        rotation = cv2.Rodrigues(fit_r)[0]
        if np.all((obj @ rotation.T + fit_t.ravel())[:,2] > 0):
            error = np.linalg.norm(project(obj[selected],fit_r,fit_t,K,D,model)-image[selected],axis=1)
            if np.isfinite(error).all():
                candidates.append((float(np.mean(error**2)),fit_r,fit_t))
    if not candidates:
        return None
    candidates.sort(key=lambda candidate:candidate[0])
    best_score, r, t = candidates[0]
    alternatives = [candidate for candidate in candidates[1:]
                    if np.linalg.norm(cv2.Rodrigues(candidate[1])[0]-cv2.Rodrigues(r)[0]) > 1e-3]
    alternative_rms = float(np.sqrt(alternatives[0][0])) if alternatives else None
    ambiguous = alternative_rms is not None and alternative_rms-np.sqrt(best_score) < .2
    R = cv2.Rodrigues(r)[0]
    if not np.isfinite(t).all() or np.any((obj @ R.T + t.ravel())[:, 2] <= 0):
        return None
    predicted = project(obj, r, t, K, D, model)
    errors = np.linalg.norm(predicted-image, axis=1)
    if not np.isfinite(errors).all():
        return None
    # Report every detected corner as well as the robust pose-fitting subset.
    accepted = errors <= max_error
    if np.count_nonzero(accepted) < 6:
        return None
    per_tag = []
    if ids:
        per_tag = [dict(id=i, rms=float(np.sqrt(np.mean(errors[j*4:j*4+4]**2)))) for j,i in enumerate(ids)]
    side = float(config['size'])
    cols, rows = int(config['cols']), int(config['rows'])
    if config['type'] == 'aprilgrid':
        pitch = side*(1+float(config['spacing']))
        xs = sorted([v for col in range(cols) for v in (col*pitch, col*pitch+side)])
        ys = sorted([v for row in range(rows) for v in (row*pitch, row*pitch+side)])
    else:
        xs = [col*side for col in range(cols)]
        ys = [row*side for row in range(rows)]
    lines = []
    for x in xs:
        line = np.array([[x,y,0] for y in np.linspace(ys[0],ys[-1],24)],np.float64)
        if np.all((line @ R.T+t.ravel())[:,2] > 0):
            lines.append(project(line,r,t,K,D,model).tolist())
    for y in ys:
        line = np.array([[x,y,0] for x in np.linspace(xs[0],xs[-1],24)],np.float64)
        if np.all((line @ R.T+t.ravel())[:,2] > 0):
            lines.append(project(line,r,t,K,D,model).tolist())
    observed_lines = []
    # Join observations that share a metric row/column; gaps remain visible.
    for coordinate in (0,1):
        for value in np.unique(obj[:,coordinate]):
            indices = np.flatnonzero(np.isclose(obj[:,coordinate],value,atol=1e-7))
            indices = indices[np.argsort(obj[indices,1-coordinate])]
            if len(indices) >= 2:
                observed_lines.append(image[indices].tolist())
    axis = np.float64([[0,0,0],[side,0,0],[0,side,0],[0,0,side]])
    return dict(id='board', target_type=config['type'], origin='target origin (bottom-left tag corner)' if ids else 'first checkerboard inner corner',
                translation=(t.ravel()*translation_scale).tolist(), rotation=R.tolist(), rvec=r.ravel().tolist(),
                rms=float(np.sqrt(np.mean(errors**2))), inlier_rms=float(np.sqrt(np.mean(errors[accepted]**2))),
                p95=float(np.percentile(errors,95)), max_error=float(np.max(errors)),
                corner_count=len(image), inlier_count=int(np.count_nonzero(accepted)), tag_count=len(ids),
                per_tag=per_tag, observed=image.tolist(), projected=predicted.tolist(), errors=errors.tolist(),
                inliers=accepted.tolist(), grid_lines=lines, observed_lines=observed_lines, axis_pixels=project(axis,r,t,K,D,model).tolist(),
                ambiguous=bool(ambiguous), alternative_rms=alternative_rms, small_tag=False, translation_scale=translation_scale)
