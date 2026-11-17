#!/usr/bin/env python3
"""OpenAPI-driven, language-neutral SDK HTTP contract runner."""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

from jsonschema import Draft4Validator, Draft202012Validator, RefResolver


METHODS = {"get", "post", "put", "patch", "delete"}


def server_path(spec):
    servers = spec.get("servers", [])
    if not servers:
        return ""
    server = servers[0]
    url = server["url"]
    for name, variable in server.get("variables", {}).items():
        url = url.replace("{" + name + "}", str(variable["default"]))
    if "{" in url or "}" in url:
        raise ValueError(f"Unresolved server URL: {url}")
    return urlsplit(url).path.rstrip("/")


def resolve(spec, schema):
    while "$ref" in schema:
        ref = schema["$ref"]
        if not ref.startswith("#/"):
            raise ValueError(f"External reference not supported: {ref}")
        schema = spec
        for segment in ref[2:].split("/"):
            schema = schema[segment.replace("~1", "/").replace("~0", "~")]
    return schema


def sample(spec, schema, depth=0, seen=None):
    seen = seen or set()
    if "$ref" in schema:
        ref = schema["$ref"]
        if ref in seen:
            return None
        return sample(spec, resolve(spec, schema), depth, seen | {ref})
    if "example" in schema:
        return schema["example"]
    if "const" in schema:
        return schema["const"]
    if "enum" in schema and schema["enum"]:
        return schema["enum"][0]
    for choice in ("oneOf", "anyOf"):
        if choice in schema:
            return sample(spec, schema[choice][0], depth, seen)
    if "allOf" in schema:
        merged = {}
        for part in schema["allOf"]:
            value = sample(spec, part, depth, seen)
            if isinstance(value, dict):
                merged.update(value)
        return merged
    kind = schema.get("type", "object" if "properties" in schema else "string")
    if isinstance(kind, list):
        kind = next((item for item in kind if item != "null"), "null")
    if kind == "object":
        properties = schema.get("properties", {})
        required = set(schema.get("required", []))
        selected = required | (set(list(properties)[:2]) if depth < 2 else set())
        return {key: sample(spec, properties[key], depth + 1, seen)
                for key in properties if key in selected and not properties[key].get("readOnly")}
    if kind == "array":
        return [sample(spec, schema.get("items", {}), depth + 1, seen)] * max(1, schema.get("minItems", 0))
    if kind == "integer":
        return max(1, schema.get("minimum", 1))
    if kind == "number":
        return max(1.0, schema.get("minimum", 1.0))
    if kind == "boolean":
        return True
    if kind == "null":
        return None
    if schema.get("format") == "date-time":
        return "2025-01-01T00:00:00Z"
    if schema.get("format") == "date":
        return "2025-01-01"
    return "contract123"


def check_schema(spec, schema, value):
    validator = Draft202012Validator if spec["openapi"].startswith("3.1") else Draft4Validator
    normalized = json.loads(json.dumps(spec))
    def fix_enums(node):
        if isinstance(node, dict):
            if node.get("type") == "object" and node.get("enum") and all(
                    isinstance(item, str) for item in node["enum"]):
                node.pop("type")
            for child in node.values():
                fix_enums(child)
        elif isinstance(node, list):
            for child in node:
                fix_enums(child)
    fix_enums(normalized)
    validator(schema, resolver=RefResolver.from_schema(normalized)).validate(value)


def make_cases(spec_file, include_errors=False):
    spec = json.loads(Path(spec_file).read_text(encoding="utf-8"))
    base = server_path(spec)
    cases = []
    for path, path_item in spec["paths"].items():
        for method, operation in path_item.items():
            if method not in METHODS:
                continue
            case_id = f"{Path(spec_file).stem}:{method.upper()}:{path}"
            parameters = []
            for param in path_item.get("parameters", []) + operation.get("parameters", []):
                param = resolve(spec, param)
                if param["in"] not in ("path", "query", "header"):
                    continue
                value = sample(spec, param.get("schema", {"type": "string"}))
                if param["name"].lower() in ("content-type", "accept"):
                    value = "application/json"
                parameters.append({"name": param["name"], "in": param["in"], "value": value})
            request_body = operation.get("requestBody", {})
            request_body = resolve(spec, request_body)
            body_schema = request_body.get("content", {}).get("application/json", {}).get("schema")
            body = sample(spec, body_schema) if body_schema else None
            if body_schema:
                check_schema(spec, body_schema, body)
            responses = [(int(code), resolve(spec, response)) for code, response in operation["responses"].items()
                         if code.isdigit() and 200 <= int(code) < 300]
            if not responses:
                raise ValueError(f"No success response: {case_id}")
            status, response = sorted(responses)[0]
            response_schema = (response.get("content", {}).get("application/json", {}).get("schema")
                               if status != 204 else None)
            if response_schema:
                resolved_response = resolve(spec, response_schema)
                if resolved_response.get("type") == "object" and not any(
                        field in resolved_response for field in ("properties", "required", "allOf", "oneOf", "anyOf")):
                    response_schema = None
            expected = sample(spec, response_schema) if response_schema else None
            if response_schema:
                check_schema(spec, response_schema, expected)
            cases.append({"id": case_id, "operationId": operation["operationId"],
                          "method": method.upper(), "path": base + path, "parameters": parameters,
                          "body": body, "status": status, "response": expected,
                          "responseUnspecified": status != 204 and response_schema is None,
                          "responseHeaders": {"Location": "/contract123"} if status == 201 else {}})
            if include_errors:
                errors = [(int(code), resolve(spec, value)) for code, value in operation["responses"].items()
                          if code.isdigit() and 400 <= int(code) < 500]
                if errors:
                    error_status, error_response = sorted(errors)[0]
                    error_schema = error_response.get("content", {}).get("application/json", {}).get("schema")
                    error_body = sample(spec, error_schema) if error_schema else None
                    if error_schema:
                        check_schema(spec, error_schema, error_body)
                    cases.append({"id": case_id + f":{error_status}", "operationId": operation["operationId"],
                                  "method": method.upper(), "path": base + path, "parameters": parameters,
                                  "body": body, "status": error_status, "response": error_body,
                                  "responseUnspecified": False, "responseHeaders": {}})
    return cases


def assert_subset(expected, actual, label):
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            raise AssertionError(f"{label}: expected object, got {actual!r}")
        for key, value in expected.items():
            if key not in actual:
                raise AssertionError(f"{label}: missing {key}")
            assert_subset(value, actual[key], f"{label}.{key}")
    elif isinstance(expected, list):
        if not isinstance(actual, list) or len(actual) != len(expected):
            raise AssertionError(f"{label}: array mismatch: {actual!r}")
        for index, value in enumerate(expected):
            assert_subset(value, actual[index], f"{label}[{index}]")
    elif expected != actual:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def verify_request(case, request):
    if request["method"] != case["method"]:
        raise AssertionError(f"HTTP method: {request['method']} != {case['method']}")
    expected_path = case["path"]
    for param in case["parameters"]:
        if param["in"] == "path":
            expected_path = expected_path.replace("{" + param["name"] + "}", quote(str(param["value"]), safe=""))
    parsed = urlsplit(request["path"])
    if parsed.path.rstrip("/") != expected_path.rstrip("/"):
        raise AssertionError(f"path: {parsed.path} != {expected_path}")
    query = parse_qs(parsed.query)
    for param in case["parameters"]:
        if param["in"] == "query" and param["value"] is not None:
            values = param["value"] if isinstance(param["value"], list) else [param["value"]]
            if query.get(param["name"]) != [str(v) for v in values]:
                raise AssertionError(f"query {param['name']}: {query.get(param['name'])} != {values}")
        if param["in"] == "header" and param["name"].lower() not in ("content-type", "accept"):
            if request["headers"].get(param["name"].lower()) != str(param["value"]):
                raise AssertionError(f"header {param['name']} mismatch")
    if request["headers"].get("authorization") != "Bearer contract-token":
        raise AssertionError("Bearer authorization missing")
    if case["body"] is not None:
        assert_subset(case["body"], request["body"], "request body")


def case_log(case, request, result, error_message, detailed=False):
    logged_request = None
    if request is not None:
        allowed_headers = {"content-type", "accept", "x-contract-case-id"}
        allowed_headers.update(param["name"].lower() for param in case["parameters"]
                               if param["in"] == "header" and param["name"].lower() not in
                               {"authorization", "cookie", "proxy-authorization", "x-api-key"})
        logged_request = {
            "method": request["method"], "path": request["path"],
            "headers": {name: value for name, value in request["headers"].items()
                        if name in allowed_headers},
            "body": request["body"],
        }
    fixture = {"method": case["method"], "path": case["path"],
               "parameters": case["parameters"], "body": case["body"]}
    mock = {"status": case["status"], "body": case["response"]}
    label = f"{'FAIL' if error_message else 'PASS'} {case['id']} ({case['operationId']})"
    if detailed:
        parts = [label, f"  Reason: {error_message}"]
        for name, value in (("Fixture request", fixture), ("Actual request", logged_request),
                            ("Mock response", mock), ("SDK result", result)):
            parts.append(f"  {name}: {json.dumps(value, ensure_ascii=False, indent=2)}")
        return "\n".join(parts)
    parts = [label]
    for name, value in (("fixture", fixture), ("actual", logged_request),
                        ("mock", mock), ("sdk", result)):
        parts.append(f"{name}={json.dumps(value, ensure_ascii=False, separators=(',', ':'))}")
    if error_message:
        parts.append(f"reason={json.dumps(error_message, ensure_ascii=False)}")
    return " | ".join(parts)


def run(specs, adapter, include_errors=False):
    cases = [case for spec in specs for case in make_cases(spec, include_errors)]
    if not cases:
        raise ValueError("No OpenAPI operations found")
    received = {}
    by_id = {case["id"]: case for case in cases}
    unexpected = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self): self.handle_case()
        def do_POST(self): self.handle_case()
        def do_PUT(self): self.handle_case()
        def do_PATCH(self): self.handle_case()
        def do_DELETE(self): self.handle_case()

        def handle_case(self):
            size = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(size)
            try:
                body = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                body = raw.decode("utf-8", errors="replace")
            case_id = self.headers.get("X-Contract-Case-Id")
            case = by_id.get(case_id)
            if case is None or case_id in received:
                unexpected.append(f"{self.command} {self.path} ({case_id})")
                self.send_error(500, "Unknown or duplicate contract case")
                return
            received[case_id] = {"method": self.command, "path": self.path,
                                 "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body}
            data = json.dumps(case["response"]).encode() if case["response"] is not None else b""
            self.send_response(case["status"])
            if data:
                self.send_header("Content-Type", "application/json")
            for key, value in case["responseHeaders"].items():
                self.send_header(key, value)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *_args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server, tempfile.TemporaryDirectory() as temp:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        manifest = Path(temp) / "cases.json"
        results = Path(temp) / "results.json"
        manifest.write_text(json.dumps({"port": server.server_port, "cases": cases}), encoding="utf-8")
        env = dict(os.environ, CONTRACT_CASES=str(manifest), CONTRACT_RESULTS=str(results))
        try:
            completed = subprocess.run(adapter, env=env, text=True, capture_output=True, check=False)
        finally:
            server.shutdown()
            thread.join()
        failures = []
        failed_cases = []
        if completed.returncode:
            failures.append(f"Adapter exit {completed.returncode}: {completed.stderr[-3000:]}")
        decoded = json.loads(results.read_text(encoding="utf-8")) if results.exists() else []
        for index, case in enumerate(cases):
            request = received.get(case["id"])
            result = decoded[index] if index < len(decoded) else None
            error_message = None
            try:
                if result is None:
                    raise AssertionError("Adapter produced no result")
                if "error" in result:
                    raise AssertionError(result["error"])
                if request is None:
                    raise AssertionError("SDK sent no request")
                verify_request(case, request)
                if case["status"] >= 400 and result.get("status") != case["status"]:
                    raise AssertionError(f"SDK error status: {result.get('status')} != {case['status']}")
                if case["response"] is not None:
                    assert_subset(case["response"], result.get("response"), "decoded response")
            except AssertionError as error:
                error_message = str(error)
                failed_cases.append(case_log(case, request, result, error_message, detailed=True))
            print(case_log(case, request, result, error_message), flush=True)
        if len(received) != len(cases) or len(decoded) != len(cases):
            failures.append(f"Coverage: {len(received)} requests, {len(decoded)} results / {len(cases)} operations")
        failures.extend(f"Unexpected request: {request}" for request in unexpected)
        unspecified = sum(case["responseUnspecified"] for case in cases)
        error_count = sum(case["status"] >= 400 for case in cases)
        summary = (f"Contract: {len(cases)} cases ({len(cases) - len(failed_cases)} passed, "
               f"{len(failed_cases)} failed); {len(cases) - error_count} success fixtures, "
               f"{error_count} error fixtures; {unspecified} unspecified response bodies; "
                   f"other issues: {len(failures)}")
        print("=" * 72)
        print(summary)
        print("=" * 72)
        if failed_cases:
            print(f"Failed cases ({len(failed_cases)}):")
            for failed_case in failed_cases:
                print(f"\n{failed_case}")
        if failures:
            print("\nOther failures:")
            for failure in failures:
                print(f"FAIL {failure}")
        return 1 if failures or failed_cases else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", action="append", required=True, help="OpenAPI JSON file (repeatable)")
    parser.add_argument("--errors", action="store_true", help="Also exercise one declared 4xx response per operation")
    parser.add_argument("adapter", nargs=argparse.REMAINDER, help="Adapter command after --")
    args = parser.parse_args()
    command = args.adapter[1:] if args.adapter[:1] == ["--"] else args.adapter
    if not command:
        parser.error("adapter command required after --")
    sys.exit(run(args.spec, command, args.errors))