package unifi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestConfigRetryAfter(t *testing.T) {
	now := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		value string
		want  time.Duration
	}{
		{"120", 2 * time.Minute}, {"999999999999999999999999", maxFetchBackoff},
		{"-1", 0}, {"garbage", 0}, {"NaN", 0}, {"", 0},
		{now.Add(90 * time.Second).Format(http.TimeFormat), 90 * time.Second},
		{now.Add(-time.Minute).Format(http.TimeFormat), 0},
		{now.Add(time.Hour).Format(http.TimeFormat), maxFetchBackoff},
	} {
		t.Run(tc.value, func(t *testing.T) {
			if got := configRetryAfter(tc.value, now); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestConfigFailureDelay(t *testing.T) {
	for _, tc := range []struct {
		failures    int
		retry, want time.Duration
	}{
		{1, 0, 30 * time.Second}, {2, 0, time.Minute}, {3, 0, 2 * time.Minute},
		{1, 5 * time.Minute, 5 * time.Minute}, {16, 0, maxFetchBackoff},
	} {
		got := configFailureDelay(tc.failures, 30*time.Second, tc.retry, func() float64 { return 0 })
		if got != tc.want {
			t.Fatalf("attempt %d got %v want %v", tc.failures, got, tc.want)
		}
	}
	for i := 0; i < 100; i++ {
		got := defaultConfigFailureDelay(1, 30*time.Second, 2*time.Minute)
		if got < 2*time.Minute || got > 150*time.Second {
			t.Fatalf("jitter violates floor/bound: %v", got)
		}
	}
}

func TestFetchConfigsPreservesOverloadRetryAfter(t *testing.T) {
	for _, status := range []int{429, 503, 401} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Retry-After", "120")
				w.WriteHeader(status)
			}))
			defer srv.Close()
			_, err := fetchConfigs(context.Background(), CollectorDeps{APIBaseURL: func() string { return srv.URL }, AgentID: "a", HTTP: srv.Client()})
			var got *configFetchStatusError
			if !errors.As(err, &got) || got.status != status {
				t.Fatalf("unexpected error %v", err)
			}
			want := time.Duration(0)
			if status == 429 || status == 503 {
				want = 2 * time.Minute
			}
			if got.retryAfter != want {
				t.Fatalf("retry delay %v want %v", got.retryAfter, want)
			}
		})
	}
}

func TestCollectorOverloadDoesNotRetryOnActiveCadenceOrWake(t *testing.T) {
	var calls, warnings atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", "60")
		w.WriteHeader(503)
	}))
	defer srv.Close()
	waker := NewWaker()
	startLoop(t, CollectorDeps{APIBaseURL: func() string { return srv.URL }, AgentID: "a", HTTP: srv.Client(), Wake: waker, schedule: fastSchedule(), Logf: func(string, ...any) { warnings.Add(1) }})
	waitFor(t, "overload warning", func() bool { return warnings.Load() == 1 })
	for i := 0; i < 10; i++ {
		waker.Wake()
		time.Sleep(10 * time.Millisecond)
	}
	if calls.Load() != 1 || warnings.Load() != 1 {
		t.Fatalf("overload retried: calls=%d warnings=%d", calls.Load(), warnings.Load())
	}
}

func TestCollectorPreservesIdleStateAcrossFailure(t *testing.T) {
	var calls, warnings atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			_, _ = w.Write([]byte(`{"collectors":[]}`))
			return
		}
		w.WriteHeader(500)
	}))
	defer srv.Close()
	waker := NewWaker()
	startLoop(t, CollectorDeps{APIBaseURL: func() string { return srv.URL }, AgentID: "a", HTTP: srv.Client(), Wake: waker, schedule: fastSchedule(), Logf: func(string, ...any) { warnings.Add(1) }})
	waitFor(t, "first empty fetch", func() bool { return calls.Load() == 1 })
	time.Sleep(20 * time.Millisecond)
	waker.Wake()
	waitFor(t, "failure", func() bool { return warnings.Load() == 1 })
	time.Sleep(80 * time.Millisecond)
	if calls.Load() != 2 {
		t.Fatalf("idle state lost after failure: %d calls", calls.Load())
	}
}

func TestCollectorFailureWarningsAreRateLimited(t *testing.T) {
	var calls, warnings atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(500) }))
	defer srv.Close()
	startLoop(t, CollectorDeps{APIBaseURL: func() string { return srv.URL }, AgentID: "a", HTTP: srv.Client(), schedule: fastSchedule(), Logf: func(string, ...any) { warnings.Add(1) }})
	waitFor(t, "multiple backed off attempts", func() bool { return calls.Load() >= 4 })
	if warnings.Load() != 1 {
		t.Fatalf("expected one warning, got %d", warnings.Load())
	}
}
