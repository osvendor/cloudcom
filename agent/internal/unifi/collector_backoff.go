package unifi

import (
	"fmt"
	"math/rand/v2"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const maxFetchBackoff = 15 * time.Minute
const fetchErrorLogInterval = 5 * time.Minute

type configFetchStatusError struct {
	status     int
	retryAfter time.Duration
}

func (e *configFetchStatusError) Error() string {
	return fmt.Sprintf("fetch configs: status %d", e.status)
}

// Retry-After is untrusted server input. Bound both delta-seconds and HTTP dates
// before converting to a duration, including huge numeric values.
func configRetryAfter(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if seconds, err := strconv.ParseFloat(value, 64); err == nil {
		if seconds >= maxFetchBackoff.Seconds() {
			return maxFetchBackoff
		}
		if seconds > 0 {
			return time.Duration(seconds * float64(time.Second))
		}
		return 0
	}
	if date, err := http.ParseTime(value); err == nil {
		delay := date.Sub(now)
		if delay > maxFetchBackoff {
			return maxFetchBackoff
		}
		if delay > 0 {
			return delay
		}
	}
	return 0
}

// Add jitter above the floor, never retrying sooner than Retry-After. The cap
// also prevents an unreachable service from permanently disabling discovery.
func configFailureDelay(failures int, base, retryAfter time.Duration, rnd func() float64) time.Duration {
	if base <= 0 {
		base = ActiveFetchInterval
	}
	delay := base
	for i := 1; i < failures && delay < maxFetchBackoff; i++ {
		delay *= 2
	}
	if retryAfter > delay {
		delay = retryAfter
	}
	if delay >= maxFetchBackoff {
		return maxFetchBackoff
	}
	delay += time.Duration(float64(delay) * .25 * rnd())
	if delay > maxFetchBackoff {
		return maxFetchBackoff
	}
	return delay
}

func defaultConfigFailureDelay(failures int, base, retryAfter time.Duration) time.Duration {
	return configFailureDelay(failures, base, retryAfter, rand.Float64)
}
