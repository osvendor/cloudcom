package desktop

import (
	"errors"
	"fmt"
)

// Keep the recovery decision and sequencing portable so Linux CI can cover
// them without pretending to exercise a Windows display driver.
func shouldEnableDIBSectionFallback(usingDIBSection bool, err error) bool {
	return !usingDIBSection && errors.Is(err, errGDIReadback) && !errors.Is(err, errGDIHandlesUnusable)
}

type gdiDIBSectionFrameOps interface {
	BitBlt(dstDC uintptr, width, height int, srcDC uintptr, rop uint32) (bool, error)
	Flush() (bool, error)
	CopyPixels(dst []byte) error
}

func gdiFrameBufferSize(width, height int) (int, error) {
	maxInt := int(^uint(0) >> 1)
	if width <= 0 || height <= 0 || width > maxInt/4/height {
		return 0, fmt.Errorf("invalid capture dimensions %dx%d", width, height)
	}
	return width * height * 4, nil
}

// captureGDIDIBSectionFrame reads an already-selected, top-down DIB section.
// GDI may batch writes to its native memory. Flush MUST complete before the
// pixels are copied into the capturer's owned Go buffer; no native view escapes.
func captureGDIDIBSectionFrame(ops gdiDIBSectionFrameOps, h gdiFrameHandles, dst []byte) error {
	need, err := gdiFrameBufferSize(h.width, h.height)
	if err != nil {
		return err
	}
	if len(dst) < need {
		return fmt.Errorf("capture buffer is %d bytes, need %d", len(dst), need)
	}
	ok, _ := ops.BitBlt(h.memDC, h.width, h.height, h.screenDC, srcCopy|captureBlt)
	if !ok {
		var errno error
		ok, errno = ops.BitBlt(h.memDC, h.width, h.height, h.screenDC, srcCopy)
		if !ok {
			return gdiCallError("BitBlt", errno)
		}
	}
	if ok, errno := ops.Flush(); !ok {
		return gdiCallError("GdiFlush", errno)
	}
	return ops.CopyPixels(dst[:need])
}
