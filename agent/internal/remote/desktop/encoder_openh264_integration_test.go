//go:build openh264integration && linux && !cgo

package desktop

import (
	openh264 "github.com/y9o/go-openh264"
	"testing"
	"time"
)

// Run separately from race tests, using the release's CGO_ENABLED=0 mode:
// CGO_ENABLED=0 go test -tags=openh264integration ./internal/remote/desktop
// This intentionally exercises the real verified codec download/native load.
// Go's cgo + purego + retiring locked threads can crash in runtime crosscall1
// (see golang/go#80723); ordinary session unit tests inject codec startup instead.
func TestOpenH264IntegrationWithLockedThreadLifecycle(t *testing.T) {
	m := NewSessionManager()
	if m.sessions == nil {
		t.Fatal("session storage not initialized")
	}
	// Observe the public constructor's asynchronous preload, rather than
	// calling loadOpenH264 ourselves and concealing a missing startup call.
	deadline := time.Now().Add(time.Minute)
	for {
		openH264Mu.Lock()
		loaded, err := openH264Loaded, openH264LoadErr
		openH264Mu.Unlock()
		if err != nil {
			t.Fatal(err)
		}
		if loaded {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("public constructor did not preload codec")
		}
		time.Sleep(10 * time.Millisecond)
	}
	v := openh264.WelsGetCodecVersion()
	if v.UMajor == 0 {
		t.Fatal("real codec returned no version")
	}
	t.Logf("loaded real OpenH264 %d.%d.%d", v.UMajor, v.UMinor, v.URevision)
	enc, err := newOpenH264Encoder(DefaultEncoderConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer enc.Close()
	if enc.IsPlaceholder() {
		t.Fatal("integration must use real codec")
	}
	if err := enc.SetDimensions(64, 64); err != nil {
		t.Fatal(err)
	}
	frame := make([]byte, 64*64*4)
	for i := 0; i < len(frame); i += 4 {
		frame[i], frame[i+1], frame[i+2], frame[i+3] = byte(i/4), 100, 200, 255
	}
	encoded, err := enc.Encode(frame)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) == 0 {
		t.Fatal("real codec produced no frame")
	}
	t.Logf("encoded 64x64 RGBA frame: %d bytes", len(encoded))
	for i := 0; i < 25; i++ {
		lt := startLockedThread(nil)
		if err := lt.Do(func() {
			got := openh264.WelsGetCodecVersion()
			if got != v {
				t.Errorf("codec version changed: got %+v want %+v", got, v)
			}
		}); err != nil {
			t.Fatal(err)
		}
		lt.Stop()
	}
}
