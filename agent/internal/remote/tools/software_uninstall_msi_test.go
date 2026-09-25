package tools

import (
	"errors"
	"reflect"
	"strings"
	"testing"

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
