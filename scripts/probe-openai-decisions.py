#!/usr/bin/env python3
"""Check Decisions access with one small, billable request (Python 3.10+).

Run: python3 scripts/probe-openai-decisions.py
Requires OPENAI_API_KEY; optionally uses OPENAI_ORG_ID and OPENAI_PROJECT_ID.
OAuth experiment: add --oauth and set OPENAI_OAUTH_ACCESS_TOKEN instead.
Use --responses to check public Responses, or --codex-responses for Codex OAuth.
Optional --model selects the Responses model (default: gpt-5.4).
Codex mode optionally uses OPENAI_CHATGPT_ACCOUNT_ID.
Use --check-token for a read-only Codex usage request (no inference).
Use --list-models for GET /v1/models; add --oauth to test the OAuth credential.
OAuth mode ignores API-key, organization, and project environment variables.
Exit codes: 0 = valid decision, 1 = failed/inconclusive probe, 2 = missing key.
Docs: https://developers.openai.com/api/docs/guides/decisions
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request


def print_api_error(body, credential):
    """Show only diagnostic fields, with credentials and terminal controls removed."""
    if not isinstance(body, dict):
        return
    detail = body.get("error") or body.get("detail") or body
    if isinstance(detail, str):
        detail = {"message": detail}
    if isinstance(detail, list):
        for item in detail[:5]:
            if isinstance(item, dict):
                print_api_error({"message": item.get("msg")}, credential)
        return
    if not isinstance(detail, dict):
        return
    shown = False
    for field in ("code", "type", "param", "message"):
        value = detail.get(field)
        if not isinstance(value, str):
            continue
        value = value.replace(credential, "[redacted]")
        value = re.sub(r"(?i)Bearer\s+\S+|sk-[\w-]+|eyJ[\w.-]+", "[redacted]", value)
        value = "".join(c if c.isprintable() else " " for c in value)
        print(f"API {field}: {value[:1000]}")
        shown = True
    if not shown:
        print("API error had no recognized diagnostic fields; body withheld.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--oauth", action="store_true")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--responses", action="store_true")
    modes.add_argument("--codex-responses", action="store_true")
    modes.add_argument("--check-token", action="store_true")
    modes.add_argument("--list-models", action="store_true")
    parser.add_argument("--model", default="gpt-5.4")
    args = parser.parse_args()
    oauth = args.oauth or args.codex_responses or args.check_token
    responses = args.responses or args.codex_responses
    variable = "OPENAI_OAUTH_ACCESS_TOKEN" if oauth else "OPENAI_API_KEY"
    key = os.environ.get(variable, "").strip()
    if not key:
        print(f"{variable} is not set. Export it locally, then rerun this script.")
        return 2

    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    for variable, header in (
        ("OPENAI_ORG_ID", "OpenAI-Organization"),
        ("OPENAI_PROJECT_ID", "OpenAI-Project"),
    ):
        if not oauth and os.environ.get(variable):
            headers[header] = os.environ[variable]
    payload = {
        "model": "gpt-6-luna",
        "input": "The bicycle is red.",
        "questions": [{
            "type": "predicate",
            "name": "is_red",
            "instructions": "Is the bicycle red?",
        }],
    }
    endpoint = "https://api.openai.com/v1/decisions"
    if responses:
        endpoint = (
            "https://chatgpt.com/backend-api/codex/responses"
            if args.codex_responses else "https://api.openai.com/v1/responses"
        )
        payload = {
            "model": args.model,
            "instructions": "Reply with only OK.",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "Say OK."}]}],
            "store": False,
            "stream": True,
        }
        headers["Accept"] = "text/event-stream"
        if args.codex_responses and os.environ.get("OPENAI_CHATGPT_ACCOUNT_ID"):
            headers["ChatGPT-Account-Id"] = os.environ["OPENAI_CHATGPT_ACCOUNT_ID"]
    if args.check_token:
        endpoint = "https://chatgpt.com/backend-api/wham/usage"
        headers["Accept"] = "application/json"
        if os.environ.get("OPENAI_CHATGPT_ACCOUNT_ID"):
            headers["ChatGPT-Account-Id"] = os.environ["OPENAI_CHATGPT_ACCOUNT_ID"]
    if args.list_models:
        endpoint = "https://api.openai.com/v1/models"
        headers["Accept"] = "application/json"
    read_only = args.check_token or args.list_models
    request = urllib.request.Request(
        endpoint,
        data=None if read_only else json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="GET" if read_only else "POST",
    )

    # Never forward authorization to a redirect destination.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    if args.list_models:
        print(f"Listing models via GET {endpoint} (no inference)...")
    elif args.check_token:
        print(f"Checking OAuth token via GET {endpoint} (no inference)...")
    else:
        print(f"Checking {payload['model']} via POST {endpoint} (one small request)...")
    print("Authentication: " + ("OAuth access token (experimental)" if oauth else "API key"))
    started = time.monotonic()
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            if responses:
                for raw_line in response:
                    line = raw_line.decode("utf-8").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    event = json.loads(data)
                    if not isinstance(event, dict):
                        continue
                    if event.get("type") == "response.completed":
                        result = event.get("response")
                        if isinstance(result, dict) and result.get("status") == "completed":
                            print(f"RESPONSES CONFIRMED: completed in {time.monotonic() - started:.2f}s.")
                            print("This confirms this credential works at the endpoint shown above.")
                            return 0
                    if event.get("type") in ("error", "response.failed", "response.incomplete"):
                        print("Responses stream reported failure/incomplete; control check is inconclusive.")
                        print_api_error(event.get("response", event), key)
                        return 1
                print("No completed Responses event received; control check is inconclusive.")
                return 1
            body = json.load(response)
            if args.list_models:
                models = body.get("data") if isinstance(body, dict) else None
                if not isinstance(models, list) or not all(
                    isinstance(model, dict) and isinstance(model.get("id"), str)
                    and model["id"] and len(model["id"]) <= 256
                    and re.fullmatch(r"[A-Za-z0-9_.:/-]+", model["id"])
                    for model in models
                ):
                    print("Unexpected model-list response; listing failed.")
                    return 1
                print(f"MODELS LISTED: {len(models)} available to this credential.")
                for model_id in sorted({model["id"] for model in models}):
                    print(model_id.replace(key, "[redacted]"))
                print("Listing does not establish Responses or Decisions compatibility.")
                return 0
            if args.check_token:
                if isinstance(body, dict) and any(
                    field in body for field in ("plan_type", "rate_limit", "credits")
                ):
                    print("TOKEN ACCEPTED: Codex returned account usage data.")
                    print("This validates access to Codex usage, not public Responses or Decisions.")
                    return 0
                print("Unexpected usage response; token validation is inconclusive.")
                return 1
    except urllib.error.HTTPError as error:
        explanations = {
            400: "Request rejected; access is not confirmed. The API contract may have changed.",
            401: "Credential rejected. It may be expired, invalid, or unsupported by this endpoint.",
            403: "Permission denied for this credential/account/project.",
            404: "Endpoint or model unavailable to this request; access is not confirmed.",
            429: "Rate limit or quota reached; access is inconclusive. Check API billing and limits.",
        }
        print(f"HTTP {error.code}: " + explanations.get(
            error.code, "Request failed; access is not confirmed. Try again later."
        ))
        if oauth:
            print(f"This result applies only to this token at {endpoint}.")
        try:
            print_api_error(json.loads(error.read(65536)), key)
        except (ValueError, UnicodeError, OSError):
            pass  # Never dump an HTML response or an unparsed error body.
        error.close()
        return 1
    except (urllib.error.URLError, TimeoutError, OSError):
        print("Network/TLS error or timeout; access is inconclusive.")
        return 1
    except (ValueError, UnicodeError):
        print("Received an invalid JSON response; access is inconclusive.")
        return 1

    answers = body.get("answers") if isinstance(body, dict) else None
    if isinstance(answers, list) and len(answers) == 1:
        answer = answers[0]
        if isinstance(answer, dict) and answer.get("name") == "is_red":
            probability = answer.get("probability")
            if (
                answer.get("type") == "predicate"
                and type(probability) in (int, float)
                and 0 <= probability <= 1
            ):
                print(f"ACCESS CONFIRMED: valid decision in {time.monotonic() - started:.2f}s.")
                print(f"P(bicycle is red) = {probability:.4f}")
                return 0
            if answer.get("type") == "refusal":
                print("API responded with a refusal; classifier operation is not confirmed.")
                return 1
    print("API returned an unexpected answer format; classifier operation is not confirmed.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
