// Standalone, runnable reference for the symmetric models in the lesson.
// Same forward equations as VINS-Mono/OpenCV; inverse uses bounded bisection
// rather than VINS-Mono's polynomial-root implementation.
#include <array>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>
struct RadialModel {
    enum class Type { PinholeRadtan, KannalaBrandt };
    Type type;
    std::array<double,4> coefficients{}; // KB angular k1..k4 (VINS k2..k5).
    double radius(double theta) const {
        if (type == Type::PinholeRadtan) {
            double r=std::tan(theta), r2=r*r;
            return r*(1+coefficients[0]*r2+coefficients[1]*r2*r2);
        }
        double t2=theta*theta;
        return theta*(1+t2*(coefficients[0]+t2*(coefficients[1]+t2*(coefficients[2]+t2*coefficients[3]))));
    }
    double angle(double image_radius) const {
        if (!std::isfinite(image_radius) || image_radius < 0)
            throw std::runtime_error("Radius must be finite and nonnegative");
        // Find a bracket only on the first increasing, forward-facing branch.
        double lo=0, previous=0;
        const double limit=std::acos(-1.0)/2-1e-6;
        for(int i=1;i<=10000;++i) {
            double hi=limit*i/10000, value=radius(hi);
            if(!std::isfinite(value) || value<=previous)
                throw std::runtime_error("Image edge lies beyond the invertible model branch");
            if(value>=image_radius) {
                for(int j=0;j<70;++j){double mid=(lo+hi)/2;if(radius(mid)<image_radius)lo=mid;else hi=mid;}
                return (lo+hi)/2;
            }
            lo=hi;previous=value;
        }
        throw std::runtime_error("Image edge lies outside the forward hemisphere");
    }
};
int main(int argc,char** argv) {
    try {
        if(argc!=5){std::cerr<<"Usage: radial_fov pinhole|kb width_px focal_px k1\n";return 2;}
        const std::string name=argv[1];
        if(name!="pinhole" && name!="kb")throw std::runtime_error("Unknown model");
        double width=std::stod(argv[2]),focal=std::stod(argv[3]),k1=std::stod(argv[4]);
        if(!std::isfinite(width)||!std::isfinite(focal)||!std::isfinite(k1)||width<=0||focal<=0)throw std::runtime_error("Invalid camera parameters");
        RadialModel model{name=="kb"?RadialModel::Type::KannalaBrandt:RadialModel::Type::PinholeRadtan,{k1,0,0,0}};
        const double theta=model.angle(width/(2*focal));
        std::cout.precision(12);std::cout<<2*theta*180/std::acos(-1.0)<<'\n';
    } catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
