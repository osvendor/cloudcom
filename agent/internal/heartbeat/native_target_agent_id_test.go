//go:build windows || linux

package heartbeat

import (
	"strings"
	"testing"
)

func TestNativeTargetAcceptsExistingAgentIDFormats(t *testing.T) {
	for _, value := range []string{
		"b9d5c9d3-613d-4fea-8dc7-c44db29f61b1",
		strings.Repeat("ab", 32),
	} {
		if !isCanonicalNativeAgentID(value) {
			t.Errorf("valid agent ID format rejected: length %d", len(value))
		}
	}
	for _, value := range []string{
		"../../devices", strings.Repeat("a", 63), strings.Repeat("a", 65),
		strings.Repeat("A", 64), strings.Repeat("g", 64),
	} {
		if isCanonicalNativeAgentID(value) {
			t.Errorf("invalid agent ID format accepted: length %d", len(value))
		}
	}
}
