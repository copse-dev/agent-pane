#!/usr/bin/env python3
"""Check Decisions access with one small, billable request (Python 3.10+).

Run: python3 scripts/probe-openai-decisions.py
Requires OPENAI_API_KEY; optionally uses OPENAI_ORG_ID and OPENAI_PROJECT_ID.
OAuth experiment: add --oauth and set OPENAI_OAUTH_ACCESS_TOKEN instead.
This tests the public API endpoint only, not an undocumented ChatGPT endpoint.
OAuth mode ignores API-key, organization, and project environment variables.
Exit codes: 0 = valid decision, 1 = failed/inconclusive probe, 2 = missing key.
Docs: https://developers.openai.com/api/docs/guides/decisions
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request


def main():
    if sys.argv[1:] == ["--help"]:
        print(__doc__)
        return 0
    oauth = sys.argv[1:] == ["--oauth"]
    if sys.argv[1:] and not oauth:
        print("Usage: python3 scripts/probe-openai-decisions.py [--help | --oauth]")
        return 2
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
    request = urllib.request.Request(
        "https://api.openai.com/v1/decisions",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )

    # Never forward authorization to a redirect destination.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    print("Checking gpt-6-luna via POST /v1/decisions (one small API request)...")
    print("Authentication: " + ("OAuth access token (experimental)" if oauth else "API key"))
    started = time.monotonic()
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            body = json.load(response)
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
            print("This result applies only to this token at api.openai.com/v1/decisions.")
        # Provider bodies can echo credentials; do not print them.
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
