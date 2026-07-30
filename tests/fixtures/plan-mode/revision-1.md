# Add auth retry with backoff

## Goal

Retry transient 401/429 responses from the provider host without spinning forever.

## Approach

1. Detect retryable status codes in the provider client.
2. Apply exponential backoff with jitter, capped at 30s.
3. Surface attempt count in the error toast after the final failure.
