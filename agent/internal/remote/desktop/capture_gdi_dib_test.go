package desktop

import (
	"errors"
	"fmt"
	"strings"
	"syscall"
	"testing"
)

func TestGetDIBitsFailureSelectsDIBFallbackOnlyAfterRestore(t *testing.T) {
	for _, tc := range []struct {
		name      string
		configure func(*fakeGDI)
		want      bool
	}{
		{"no error code", func(f *fakeGDI) { f.getDIBitsFailNoErrno = true }, true},
		{"with error code", func(f *fakeGDI) { f.getDIBitsErrno = syscall.Errno(8) }, true},
		{"partial readback", func(f *fakeGDI) { f.getDIBitsPartial = true }, true},
		{"blit failure", func(f *fakeGDI) { f.bitBltFailAlways = true }, false},
		{"deselect failure", func(f *fakeGDI) { f.failSelectTo = testHandles().oldBitmap }, false},
		{"readback and restore failure", func(f *fakeGDI) { f.getDIBitsFailNoErrno = true; f.failSelectTo = testHandles().hBitmap }, false},
		{"success", func(*fakeGDI) {}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := testHandles()
			f := newFakeGDI(h)
			tc.configure(f)
			bi := newCaptureBitmapInfo(h.width, h.height)
			err := captureGDIFrame(f, h, &bi, make([]byte, h.width*h.height*4))
			if got := shouldEnableDIBSectionFallback(false, err); got != tc.want {
				t.Fatalf("fallback = %v, want %v for %v", got, tc.want, err)
			}
			if shouldEnableDIBSectionFallback(true, err) {
				t.Fatal("an active DIB fallback must not switch or rebuild again")
			}
			if tc.want && f.selected[h.memDC] != h.hBitmap {
				t.Fatal("readback marker must only follow restored bitmap selection")
			}
			if tc.name == "with error code" && !errors.Is(err, syscall.Errno(8)) {
				t.Fatalf("Win32 error was not preserved: %v", err)
			}
			if tc.name == "no error code" && !strings.Contains(err.Error(), "Win32 recorded no error code") {
				t.Fatalf("observed failure detail was lost: %v", err)
			}
		})
	}
	combined := fmt.Errorf("%w: %w", errGDIHandlesUnusable, errGDIReadback)
	if shouldEnableDIBSectionFallback(false, combined) {
		t.Fatal("unusable handles must not qualify as a readback-only failure")
	}
}

type fakeDIBSectionOps struct {
	calls          []string
	failCaptureBlt bool
	blitErr        error
	flushErr       error
	copyErr        error
	pixels         []byte
}

func (f *fakeDIBSectionOps) BitBlt(_ uintptr, _, _ int, _ uintptr, rop uint32) (bool, error) {
	f.calls = append(f.calls, "BitBlt")
	if f.blitErr != nil {
		return false, f.blitErr
	}
	if f.failCaptureBlt && rop&captureBlt != 0 {
		return false, syscall.Errno(87)
	}
	return true, nil
}

func (f *fakeDIBSectionOps) Flush() (bool, error) {
	f.calls = append(f.calls, "Flush")
	return f.flushErr == nil, f.flushErr
}

func (f *fakeDIBSectionOps) CopyPixels(dst []byte) error {
	f.calls = append(f.calls, "Copy")
	if f.copyErr != nil {
		return f.copyErr
	}
	copy(dst, f.pixels)
	return nil
}

func TestDIBSectionFlushesBeforeCopyingOwnedPixels(t *testing.T) {
	h := testHandles()
	for _, fallback := range []bool{false, true} {
		f := &fakeDIBSectionOps{failCaptureBlt: fallback, pixels: make([]byte, h.width*h.height*4)}
		f.pixels[0] = 29
		dst := make([]byte, len(f.pixels))
		if err := captureGDIDIBSectionFrame(f, h, dst); err != nil {
			t.Fatal(err)
		}
		want := "BitBlt,Flush,Copy"
		if fallback {
			want = "BitBlt,BitBlt,Flush,Copy"
		}
		if got := strings.Join(f.calls, ","); got != want {
			t.Fatalf("calls = %s, want %s", got, want)
		}
		f.pixels[0] = 99
		if dst[0] != 29 {
			t.Fatal("returned pixels alias the native backing buffer")
		}
	}
}

func TestDIBSectionNeverCopiesFailedFrames(t *testing.T) {
	h := testHandles()
	for _, tc := range []struct {
		name  string
		ops   fakeDIBSectionOps
		calls string
		want  error
	}{
		{"blit", fakeDIBSectionOps{blitErr: syscall.Errno(5)}, "BitBlt,BitBlt", syscall.Errno(5)},
		{"flush", fakeDIBSectionOps{flushErr: syscall.Errno(6)}, "BitBlt,Flush", syscall.Errno(6)},
		{"copy", fakeDIBSectionOps{copyErr: errGDIHandlesUnusable}, "BitBlt,Flush,Copy", errGDIHandlesUnusable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dst := make([]byte, h.width*h.height*4)
			dst[0] = 41
			err := captureGDIDIBSectionFrame(&tc.ops, h, dst)
			if !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
			if got := strings.Join(tc.ops.calls, ","); got != tc.calls {
				t.Fatalf("calls = %s, want %s", got, tc.calls)
			}
			if dst[0] != 41 {
				t.Fatal("failed frame overwrote destination")
			}
			if shouldEnableDIBSectionFallback(false, err) {
				t.Fatal("DIB failures must not masquerade as GetDIBits failures")
			}
		})
	}
}

func TestDIBSectionRejectsInvalidBuffersBeforeNativeCalls(t *testing.T) {
	for _, tc := range []struct {
		name                string
		width, height, size int
	}{
		{"empty", 4, 3, 0},
		{"short", 4, 3, 47},
		{"zero width", 0, 3, 0},
		{"negative height", 4, -1, 0},
		{"overflow", int(^uint(0) >> 1), 2, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeDIBSectionOps{}
			h := gdiFrameHandles{width: tc.width, height: tc.height}
			if err := captureGDIDIBSectionFrame(f, h, make([]byte, tc.size)); err == nil {
				t.Fatal("invalid buffer accepted")
			}
			if len(f.calls) != 0 {
				t.Fatalf("native calls made before validation: %v", f.calls)
			}
		})
	}
}
