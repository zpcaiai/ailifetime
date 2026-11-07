import json, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
graph=json.loads((ROOT/'contracts/state-machines.json').read_text())
class TestInvariants(unittest.TestCase):
    def test_paid_requires_pending(self):
        self.assertIn('PAID',graph['order']['PENDING'])
        self.assertNotIn('PAID',graph['order']['CLOSED'])
    def test_terminal_refund(self):
        self.assertEqual([],graph['order']['REFUNDED'])
    def test_ready_only_after_render(self):
        incoming=[s for s,v in graph['job'].items() if 'READY' in v]
        self.assertEqual(['RENDERING'],incoming)
    def test_cancelled_no_restart(self):
        self.assertEqual([],graph['job']['CANCELLED'])
    def test_failed_job_not_ready(self):
        self.assertNotIn('READY',graph['job']['FAILED'])
    def test_ai_templates_require_mark(self):
        for x in json.loads((ROOT/'catalog/templates.json').read_text()):
            if x['ai_mode']!='none':self.assertEqual('ai_required',x['label_policy'])
if __name__=='__main__':unittest.main()
