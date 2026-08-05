#!/bin/sh
set -e

# go2rtc now runs in its own container. Startup ordering is compose's job
# (depends_on: service_healthy), and if go2rtc is briefly unavailable the
# camera retry ladder and circuit breaker already handle it.
exec node dist/index.js
