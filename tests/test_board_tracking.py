"""Board diagnostics must use original calibrated pixels and retain outlier errors."""
import pathlib,sys,unittest,json
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'vision'))
import cv2,numpy as np
from board_tracking import track_board
from calibration import project

class BoardTrackingTests(unittest.TestCase):
    def test_metric_pose_resizing_and_outlier_report_for_both_models(self):
        config=dict(type='aprilgrid',cols=4,rows=3,size=.0223,spacing=.3)
        side=config['size'];pitch=side*1.3
        obj=np.float64([[x,y,0] for row in range(3) for col in range(4)
                        for x,y in [(col*pitch,row*pitch+side),(col*pitch+side,row*pitch+side),
                                    (col*pitch+side,row*pitch),(col*pitch,row*pitch)]])
        K=np.float64([[900,0,960],[0,905,600],[0,0,1]])
        r=np.float64([[2.8],[.1],[.05]]);t=np.float64([[-.06],[.04],[.5]])
        frame=np.zeros((400,640),np.uint8)
        for model in ('radtan','fisheye'):
            D=np.float64([-.1,.01,.001,-.002])
            predicted=project(obj,r,t,K,D,model)
            observed=predicted.copy();observed[0]+=[15,-10]
            small=(observed+.5)/3-.5
            with patch('board_tracking.detect',return_value=(obj,small,list(range(12)))):
                result=track_board(frame,config,dict(K=K.tolist(),D=D.tolist(),model=model),np.array([3,3]),3,1)
            self.assertIsNotNone(result)
            json.dumps(result,allow_nan=False)
            np.testing.assert_allclose(result['translation'],t.ravel(),atol=1e-4)
            np.testing.assert_allclose(result['observed'],observed,atol=1e-6)
            self.assertEqual(result['corner_count'],48)
            self.assertEqual(result['inlier_count'],47)
            self.assertGreater(result['rms'],2)
            self.assertLess(result['inlier_rms'],1e-4)
            self.assertGreater(result['per_tag'][0]['rms'],8)
            self.assertTrue(result['observed_lines'])
            self.assertTrue(result['grid_lines'])
            # Predicted 3D grid lines become collinear after calibrated undistortion.
            for line in result['grid_lines']:
                points=np.float64(line).reshape(-1,1,2)
                und=cv2.fisheye.undistortPoints(points,K,D,P=K) if model=='fisheye' else cv2.undistortPoints(points,K,D,P=K)
                xy=und.reshape(-1,2);delta=xy[-1]-xy[0]
                cross=(xy[:,0]-xy[0,0])*delta[1]-(xy[:,1]-xy[0,1])*delta[0]
                self.assertLess(np.max(abs(cross))/np.linalg.norm(delta),1e-3)

    def test_fisheye_edge_noise_is_judged_in_original_pixels(self):
        config=dict(type='aprilgrid',cols=6,rows=6,size=.0223,spacing=.3)
        pitch=.0223*1.3
        obj=np.float64([[x,y,0] for row in range(6) for col in range(6)
                        for x,y in [(col*pitch,row*pitch+.0223),(col*pitch+.0223,row*pitch+.0223),
                                    (col*pitch+.0223,row*pitch),(col*pitch,row*pitch)]])
        K=np.float64([[660,0,960],[0,660,600],[0,0,1]])
        D=np.float64([-.1,.01,.001,-.002])
        r=np.float64([[2.8],[.1],[.05]]);t=np.float64([[-.31],[-.04],[.3]])
        observations=project(obj,r,t,K,D,'fisheye')+np.random.default_rng(3).normal(0,.25,(144,2))
        with patch('board_tracking.detect',return_value=(obj,observations,list(range(36)))):
            out=track_board(np.zeros((1200,1920),np.uint8),config,dict(K=K.tolist(),D=D.tolist(),model='fisheye'),np.ones(2),3,1)
        self.assertIsNotNone(out)
        self.assertGreater(out['inlier_count'],140)
        self.assertLess(out['rms'],1)
        self.assertLess(abs(out['translation'][2]-.3),.003)

if __name__=='__main__':unittest.main()
