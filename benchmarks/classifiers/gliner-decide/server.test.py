"""Question-to-head mapping for the GLiNER2.5-Decide prototype server.

Runs without the model: `gliner2` is stubbed, since only `head_for` is exercised.

    python3 benchmarks/classifiers/gliner-decide/server.test.py
"""
import importlib.util
from pathlib import Path
import sys
import types
import unittest

sys.modules.setdefault("gliner2", types.SimpleNamespace(AutoExtractor=object))
spec = importlib.util.spec_from_file_location("server", Path(__file__).with_name("server.py"))
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class HeadForTest(unittest.TestCase):
    def test_boolean_uses_supplied_true_and_false_descriptions(self):
        head, _ = server.head_for(
            {
                "type": "noul",
                "instructions": "Is the parcel delivered?",
                "criteria": {"true": "Delivered to the destination", "false": "Still in transit"},
            }
        )
        self.assertEqual(
            head["labels"], {"yes": "Delivered to the destination", "no": "Still in transit"}
        )

    def test_boolean_falls_back_per_side_to_generic_descriptions(self):
        head, _ = server.head_for({"type": "noul", "criteria": {"false": "Still in transit"}})
        self.assertEqual(
            head["labels"], {"yes": "The statement holds.", "no": "Still in transit"}
        )
        head, _ = server.head_for({"type": "noul"})
        self.assertEqual(
            head["labels"], {"yes": "The statement holds.", "no": "The statement does not hold."}
        )

    def test_boolean_decodes_yes_probability(self):
        _, decode = server.head_for({"type": "noul"})
        self.assertEqual(decode({"yes": 0.7, "no": 0.3}), {"type": "noul", "noul": 0.7})

    def test_choice_option_without_description_uses_its_name(self):
        head, _ = server.head_for(
            {"type": "choice", "criteria": {"read": None, "write": "Changes files"}}
        )
        self.assertEqual(head["labels"], {"read": "read", "write": "Changes files"})


if __name__ == "__main__":
    unittest.main()
