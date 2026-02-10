# Cloudflare Email Queue Consumer

A minimal Cloudflare Worker that consumes messages from a Cloudflare Queue and sends emails via the `send_email`
binding. It includes exponential backoff retries for common transient SMTP errors (e.g., greylisting) and moves messages
to a Dead Letter Queue (DLQ) after the maximum retries.
Non-retryable errors throw and rely on queue semantics to count towards max retries and ultimately route to DLQ.