// Calls the same camodocal camera interface used by VINS-Mono's feature tracker.
// Build against VINS-Mono's camera_model library; see README in this directory.
#include <camodocal/camera_models/CameraFactory.h>
#include <Eigen/Core>
#include <algorithm>
#include <cmath>
#include <iostream>
#include <stdexcept>

Eigen::Vector3d bearing(const camodocal::CameraPtr& camera,
                        const Eigen::Vector2d& pixel) {
    Eigen::Vector3d ray;
    camera->liftProjective(pixel, ray); // Inverts this camera's calibrated model.
    if (!ray.allFinite() || ray.norm() < 1e-12)
        throw std::runtime_error("Invalid camera bearing");
    return ray.normalized(); // Direction only: this does not measure depth.
}

int main(int argc, char** argv) {
    if (argc != 4) {
        std::cerr << "Usage: vins_camera_demo vins-camera.yaml u v\n";
        return 2;
    }
    try {
        auto camera = camodocal::CameraFactory::instance()
                          ->generateCameraFromYamlFile(argv[1]);
        if (!camera) throw std::runtime_error("Cannot load camera YAML");
        const Eigen::Vector2d pixel(std::stod(argv[2]), std::stod(argv[3]));
        const auto ray = bearing(camera, pixel);
        Eigen::Vector2d reprojected;
        camera->spaceToPlane(ray, reprojected); // Forward projection, same model.
        std::cout << "unit bearing: " << ray.transpose() << '\n'
                  << "round-trip error (px): " << (reprojected - pixel).norm() << '\n';
        // This is how a bearing enters normalized-plane feature coordinates.
        // It is only valid away from Z=0; a unit bearing itself has no such division.
        if (ray.z() > 1e-8)
            std::cout << "normalized plane: "
                      << (ray.head<2>() / ray.z()).transpose() << '\n';
        const double cy = (camera->imageHeight() - 1) / 2.0;
        const auto left = bearing(camera, Eigen::Vector2d(0, cy));
        const auto right = bearing(camera, Eigen::Vector2d(camera->imageWidth()-1, cy));
        const double angle = std::acos(std::clamp(left.dot(right), -1.0, 1.0));
        std::cout << "horizontal center-line edge-ray angle (deg): "
                  << angle * 180.0 / std::acos(-1.0) << '\n';
        // Edge-ray angle is a useful HFOV measure for ordinary forward-looking
        // lenses. The acos angle cannot distinguish wraparound FOV beyond 180 deg.
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n'; return 1;
    }
}
