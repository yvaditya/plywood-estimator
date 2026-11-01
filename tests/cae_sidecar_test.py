import sys
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server import main
class SidecarSupports(unittest.TestCase):
 def model(self,**kw):
  return main.Model(nodes=[[0,0,0]],materials=[],quads=[],links=[],supports=[0],loads=[],**kw)
 def fake(self):
  fe=MagicMock();fe.load_combos={'Combo 1':object()};node=MagicMock()
  for dof in ['DX','DY','DZ','RX','RY','RZ']: setattr(node,dof,{'Combo 1':0.})
  fe.nodes={'N0':node};return fe
 def test_zero_and_omitted_foundation_add_no_springs(self):
  self.assertEqual(self.model().kSoft,0)
  for model in [self.model(),self.model(kSoft=0)]:
   fe=self.fake()
   with patch.object(main,'FEModel3D',return_value=fe): result=main.solve(model)
   self.assertTrue(result.ok);fe.def_support_spring.assert_not_called()
 def test_stability_failure_is_not_retried_without_check(self):
  fe=self.fake();fe.analyze_linear.side_effect=ValueError('Unstable unsupported structure')
  with patch.object(main,'FEModel3D',return_value=fe): result=main.solve(self.model())
  self.assertFalse(result.ok);self.assertEqual(fe.analyze_linear.call_count,1)
  self.assertTrue(fe.analyze_linear.call_args.kwargs['check_stability'])
 def physical_model(self):
  return main.Model(nodes=[[0,0,0],[100,0,0],[100,0,80],[0,0,80]],
   materials=[dict(name='ply',E=6500,G=2600,nu=.25,rho=680)],
   quads=[dict(n=[0,1,2,3],t=10,mat='ply')],links=[],supports=[0,1],
   loads=[dict(node=2,fx=0,fy=1,fz=0)])
 def test_actual_supported_pynite_quad_without_foundation(self):
  result=main.solve(self.physical_model())
  self.assertTrue(result.ok,result.message)
  self.assertGreater(max(abs(v) for v in result.disp),0)
 def test_actual_unsupported_pynite_quad_fails(self):
  model=self.physical_model();model.supports=[]
  result=main.solve(model)
  self.assertFalse(result.ok)
if __name__=='__main__': unittest.main()
