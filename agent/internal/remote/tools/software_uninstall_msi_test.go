package tools

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
)

func TestMSIProductCodeAcceptsOnlyInstallerGUID(t *testing.T) {
	guid := "{89F38CAB-6A94-4B76-9839-0AF9118C1E8E}"
	for _, command := range []string{
		"MsiExec.exe /X" + guid,
		`"C:\Windows\System32\msiexec.exe" /I ` + guid + " /quiet",
	} {
		if got := msiProductCode(command); got != guid {
			t.Errorf("msiProductCode(%q) = %q", command, got)
		}
	}
	for _, command := range []string{
		"cmd.exe /c msiexec.exe /X" + guid,
		"MsiExec.exe /X{not-a-guid}",
		"MsiExec.exe /X" + guid + "& calc.exe",
		"other-msiexec.exe /X" + guid,
	} {
		if got := msiProductCode(command); got != "" {
			t.Errorf("unsafe MSI command %q produced %q", command, got)
		}
	}
}

func TestWindowsMSIUninstallRetriesInLoggedInUserContext(t *testing.T) {
	const guid = "{89F38CAB-6A94-4B76-9839-0AF9118C1E8E}"
	oldInventory, oldLookPath := softwareInventoryFn, uninstallLookPath
	oldRun, oldVerify := runUninstallCommand, uninstallVerifyStillPresent
	t.Cleanup(func() {
		softwareInventoryFn, uninstallLookPath = oldInventory, oldLookPath
		runUninstallCommand, uninstallVerifyStillPresent = oldRun, oldVerify
	})
	softwareInventoryFn = func() ([]collectors.SoftwareItem, error) {
		return []collectors.SoftwareItem{{Name: "Blender", Version: "5.2.1", UninstallString: "MsiExec.exe /X" + guid}}, nil
	}
	uninstallLookPath = func(command string) (string, error) { return command, nil }
	var systemCalls, userCalls int
	runUninstallCommand = func(attempt uninstallAttempt) ([]byte, error) {
		systemCalls++
		if attempt.command != "msiexec.exe" {
			t.Fatalf("unexpected fallback provider %q", attempt.command)
		}
		return []byte("This action is only valid for products that are currently installed."), errors.New("exit status 1605")
	}
	uninstallVerifyStillPresent = func(string) (bool, error) { return false, nil }
	userExec := func(command string, args []string, timeout time.Duration) (string, string, int, error) {
		userCalls++
		if command != "msiexec.exe" || !reflect.DeepEqual(args, []string{"/x", guid, "/qn", "/norestart"}) || timeout != 10*time.Minute {
			t.Fatalf("unexpected user uninstall: %q %#v %v", command, args, timeout)
		}
		return "", "", 0, nil
	}
	if err := uninstallSoftwareWindows("Blender", "5.2.1", userExec); err != nil {
		t.Fatal(err)
	}
	if systemCalls != 1 || userCalls != 1 {
		t.Fatalf("system calls=%d, user calls=%d", systemCalls, userCalls)
	}
}

func TestWindowsMSIUninstallReportsExecutableLeftBehind(t *testing.T) {
	location := t.TempDir()
	if err := os.WriteFile(filepath.Join(location, "blender.exe"), []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := verifyWindowsMSIExecutableRemoved("Blender", location); err == nil || !strings.Contains(err.Error(), "executable remains") {
		t.Fatalf("expected incomplete-uninstall error, got %v", err)
	}
	if err := os.Remove(filepath.Join(location, "blender.exe")); err != nil {
		t.Fatal(err)
	}
	if err := verifyWindowsMSIExecutableRemoved("Blender", location); err != nil {
		t.Fatalf("removed executable should pass: %v", err)
	}
}

func TestWindowsMSIUninstallAttemptUsesExactInventoryMatch(t *testing.T) {
	original := softwareInventoryFn
	t.Cleanup(func() { softwareInventoryFn = original })
	softwareInventoryFn = func() ([]collectors.SoftwareItem, error) {
		return []collectors.SoftwareItem{
			{Name: "Blender", Version: "5.1.0", UninstallString: "MsiExec.exe /X{11111111-1111-1111-1111-111111111111}"},
			{Name: "Blender", Version: "5.2.1", UninstallString: "MsiExec.exe /X{89F38CAB-6A94-4B76-9839-0AF9118C1E8E}"},
			{Name: "Blender Add-on", Version: "5.2.1", UninstallString: "MsiExec.exe /X{22222222-2222-2222-2222-222222222222}"},
		}, nil
	}
	attempt, err := windowsMSIUninstallAttempt("Blender", "5.2.1")
	if err != nil {
		t.Fatal(err)
	}
	if attempt == nil || attempt.command != "msiexec.exe" || !reflect.DeepEqual(attempt.args, []string{"/x", "{89F38CAB-6A94-4B76-9839-0AF9118C1E8E}", "/qn", "/norestart"}) {
		t.Fatalf("wrong exact MSI attempt: %#v", attempt)
	}
}

func TestWindowsMSIUninstallAttemptRejectsAmbiguousProducts(t *testing.T) {
	original := softwareInventoryFn
	t.Cleanup(func() { softwareInventoryFn = original })
	softwareInventoryFn = func() ([]collectors.SoftwareItem, error) {
		return []collectors.SoftwareItem{
			{Name: "Blender", Version: "5.2.1", UninstallString: "MsiExec.exe /X{11111111-1111-1111-1111-111111111111}"},
			{Name: "Blender", Version: "5.2.1", UninstallString: "MsiExec.exe /X{22222222-2222-2222-2222-222222222222}"},
		}, nil
	}
	_, err := windowsMSIUninstallAttempt("Blender", "5.2.1")
	if err == nil || !strings.Contains(err.Error(), "multiple MSI products") {
		t.Fatalf("expected ambiguity failure, got %v", err)
	}
}

func TestWindowsMSIUninstallFallsBackWhenInventoryFails(t *testing.T) {
	original := softwareInventoryFn
	t.Cleanup(func() { softwareInventoryFn = original })
	softwareInventoryFn = func() ([]collectors.SoftwareItem, error) { return nil, errors.New("collector unavailable") }
	attempt, err := windowsMSIUninstallAttempt("Blender", "5.2.1")
	if err != nil || attempt != nil {
		t.Fatalf("wanted winget fallback, got attempt=%#v error=%v", attempt, err)
	}
}
