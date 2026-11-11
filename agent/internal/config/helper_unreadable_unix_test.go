//go:build !windows

package config

import (
	"os"
	"testing"
)

func makeHelperSecretUnreadable(t *testing.T, path string) {
	t.Helper()
	if err := os.Chmod(path, 0000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0600) })
}
