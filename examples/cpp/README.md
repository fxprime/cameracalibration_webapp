# C++ camera geometry

`vins_camera_demo.cpp` is an integration example calling **the actual camodocal API used by VINS-Mono**, not a substitute camera class. It loads this app's `vins-mono.yaml`, lifts pixels to bearings, reprojects them and computes a center-line edge-ray angle. It requires a built VINS-Mono `camera_model` library and its Eigen/OpenCV/Boost dependencies; VINS-Mono's standard build uses ROS/catkin. Add this executable to that build and link `camera_model`.

```cmake
add_executable(vins_camera_demo /absolute/path/to/vins_camera_demo.cpp)
target_compile_features(vins_camera_demo PRIVATE cxx_std_17)
target_link_libraries(vins_camera_demo camera_model ${OpenCV_LIBS})
```

The pinned source version used to check the interfaces and conventions is VINS-Mono commit `90dabb5ec79946ae42fd2e1e91d4e69aabe1e25d`:

- [feature tracker](https://github.com/HKUST-Aerial-Robotics/VINS-Mono/blob/90dabb5ec79946ae42fd2e1e91d4e69aabe1e25d/feature_tracker/src/feature_tracker.cpp)
- [factory and YAML model names](https://github.com/HKUST-Aerial-Robotics/VINS-Mono/blob/90dabb5ec79946ae42fd2e1e91d4e69aabe1e25d/camera_model/src/camera_models/CameraFactory.cc)
- [EquidistantCamera: Kannala–Brandt projection and backprojection](https://github.com/HKUST-Aerial-Robotics/VINS-Mono/blob/90dabb5ec79946ae42fd2e1e91d4e69aabe1e25d/camera_model/src/camera_models/EquidistantCamera.cc)

`radial_fov.cpp` is a separately runnable, original reference implementation of the same symmetric forward equations. Its inverse is bounded bisection, **not** VINS-Mono's polynomial-root solver. It omits tangential distortion and only covers the first increasing branch inside the forward hemisphere. This makes the educational slider's assumptions explicit.

```sh
c++ -std=c++17 -O2 radial_fov.cpp -o /tmp/radial_fov
/tmp/radial_fov pinhole 1920 1350 0
/tmp/radial_fov kb 1920 1350 0
```

For a centered camera, solve `g(theta_edge)=width/(2*fx)` then `HFOV=2*theta_edge`. For off-center principal points use separate left/right rays; for radtan tangential distortion use the complete 2D inverse. A bearing supplies direction, not scene depth.

VINS-Mono's four KB coefficients are `k2,k3,k4,k5`; OpenCV fisheye/Kalibr equidistant label these `k1,k2,k3,k4`. Its `mu,mv,u0,v0` correspond to `fx,fy,cx,cy`. This equivalence is for the symmetric four-coefficient angular polynomial with compatible axes/skew assumptions, not every model called Kannala–Brandt.

Validation: the integration adapter was compiler-checked against those actual upstream headers on this machine; a linked VINS runtime was not available. The standalone radial reference was compiled and numerically compared with OpenCV inverse projection.
