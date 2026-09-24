//go:build windows || linux

package heartbeat

// Breeze agents can have either the current UUID identifier or the legacy
// 64-character lowercase hex identifier. Both are single safe URL segments.
func isCanonicalNativeAgentID(value string) bool {
	if isCanonicalNativeUUID(value) {
		return true
	}
	if len(value) != 64 {
		return false
	}
	for i := 0; i < len(value); i++ {
		char := value[i]
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}
