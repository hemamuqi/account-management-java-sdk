import unittest

from runner import assert_subset, sample, verify_request


class ContractRunnerTests(unittest.TestCase):
    def test_sample_selects_required_and_shallow_optional_fields(self):
        schema = {
            "type": "object",
            "required": ["requiredField"],
            "properties": {
                "optionalField": {"type": "string"},
                "requiredField": {"type": "integer"},
                "skippedField": {"type": "boolean"},
            },
        }

        self.assertEqual(sample({}, schema), {"optionalField": "contract123", "requiredField": 1})

    def test_verify_request_checks_path_query_headers_and_body(self):
        case = {
            "method": "POST",
            "path": "/items/{item_id}",
            "parameters": [
                {"name": "item_id", "in": "path", "value": "a/b"},
                {"name": "filter", "in": "query", "value": "active"},
                {"name": "X-Region", "in": "header", "value": "US"},
            ],
            "body": {"name": "example"},
        }
        request = {
            "method": "POST",
            "path": "/items/a%2Fb?filter=active",
            "headers": {"authorization": "Bearer contract-token", "x-region": "US"},
            "body": {"name": "example"},
        }

        verify_request(case, request)
        request["body"] = {"name": "wrong"}
        with self.assertRaisesRegex(AssertionError, "request body.name"):
            verify_request(case, request)

    def test_missing_decoded_response_field_fails(self):
        with self.assertRaisesRegex(AssertionError, "decoded response: missing limit"):
            assert_subset({"limit": 1}, {}, "decoded response")


if __name__ == "__main__":
    unittest.main()