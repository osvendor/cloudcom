//go:build linux

package heartbeat

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"github.com/breeze-rmm/agent/internal/config"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func TestLinuxNativeTargetOriginAndSeedValidation(t *testing.T) {
	for _, value := range []string{"https://breeze.example", "https://breeze.example:8443"} {
		if got, err := nativeTargetOrigin(value); err != nil || got != value {
			t.Fatalf("valid origin %q: %q, %v", value, got, err)
		}
	}
	for _, value := range []string{"http://breeze.example", "https://breeze.example/", "https://breeze.example/path", "https://user@breeze.example", "https://breeze.example?x=1"} {
		if _, err := nativeTargetOrigin(value); err == nil {
			t.Errorf("invalid origin %q accepted", value)
		}
	}
	seed := linuxNativeTargetSeed{Version: 2, InstallationID: "b9d5c9d3-613d-4fea-8dc7-c44db29f61b1",
		TargetPublicKey:  base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32)),
		TargetCredential: base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{2}, 32))}
	if !validLinuxNativeTargetSeed(seed) {
		t.Fatal("canonical seed rejected")
	}
	if !validLinuxNativeTargetPublicKey(seed.TargetPublicKey) {
		t.Fatal("canonical RustDesk key rejected")
	}
	for _, invalid := range []string{"", seed.TargetPublicKey + "=", base64.RawURLEncoding.EncodeToString(make([]byte, 32))} {
		if validLinuxNativeTargetPublicKey(invalid) {
			t.Fatalf("invalid RustDesk key accepted: %q", invalid)
		}
	}
	seed.TargetCredential += "="
	if validLinuxNativeTargetSeed(seed) {
		t.Fatal("noncanonical credential accepted")
	}
	seed.TargetCredential = base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	if validLinuxNativeTargetSeed(seed) {
		t.Fatal("all-zero credential accepted")
	}
}

func TestLinuxNativeTargetDirectoryRejectsLooseModesAndLinks(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("root-owned enrollment directory requires root; covered by the root-run Linux acceptance suite")
	}
	parent := t.TempDir()
	private := filepath.Join(parent, "private")
	if err := os.Mkdir(private, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := verifyLinuxNativeTargetDir(private); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(private, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := verifyLinuxNativeTargetDir(private); err == nil {
		t.Fatal("loose directory accepted")
	}
	link := filepath.Join(parent, "link")
	if err := os.Symlink(private, link); err != nil {
		t.Fatal(err)
	}
	if err := verifyLinuxNativeTargetDir(link); err == nil {
		t.Fatal("symlink directory accepted")
	}
}

func TestLinuxNativeTargetFirstProvisioningAndReuse(t *testing.T) {
	publicKey := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{3}, 32))
	if os.Geteuid() != 0 {
		t.Skip("root-only enrollment")
	}
	if _, err := os.Lstat(nativeTargetDirLinux()); err == nil {
		t.Fatal("test container already contains an enrollment directory")
	}
	first, err := loadOrCreateLinuxNativeTargetSeed(publicKey)
	if err != nil {
		t.Fatal(err)
	}
	second, err := loadOrCreateLinuxNativeTargetSeed(publicKey)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatal("reconciliation rotated an existing device seed")
	}
	if first.TargetPublicKey != publicKey {
		t.Fatal("enrollment seed does not match RustDesk identity")
	}
	changedKey := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{4}, 32))
	if _, err := loadOrCreateLinuxNativeTargetSeed(changedKey); err == nil {
		t.Fatal("RustDesk identity change accepted without rotation")
	}
	path := filepath.Join(nativeTargetDirLinux(), "native-admission-seed.json")
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		t.Fatalf("seed is not private: %v", info.Mode())
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(t.TempDir(), "missing"), path); err != nil {
		t.Fatal(err)
	}
	if _, err := loadOrCreateLinuxNativeTargetSeed(publicKey); err == nil {
		t.Fatal("symlink seed accepted")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(nativeTargetDirLinux()); err != nil {
		t.Fatal(err)
	}
}

func TestLinuxNativeTargetInstalledBinaryResolution(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("root-only installation paths")
	}
	link := "/usr/bin/rustdesk"
	target := "/usr/share/rustdesk/rustdesk"
	if _, err := os.Lstat(link); err == nil {
		t.Skip("test container already has RustDesk installed")
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("fixture"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	got, err := installedRustDeskServicePathLinux()
	if err != nil || got != target {
		t.Fatalf("package symlink = %q, %v", got, err)
	}
	if err := os.Chmod(target, 0o777); err != nil {
		t.Fatal(err)
	}
	if _, err := installedRustDeskServicePathLinux(); err == nil {
		t.Fatal("writable binary accepted")
	}
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Dir(target)); err != nil {
		t.Fatal(err)
	}
}

func TestLinuxNativeTargetCrossLanguageFixture(t *testing.T) {
	if os.Getenv("CLOUDCOM_LINUX_ENROLLMENT_FIXTURE") != "1" {
		t.Skip("external fixture run only")
	}
	record := linuxNativeTargetStored{
		Version:          2,
		DeviceID:         "b9d5c9d3-613d-4fea-8dc7-c44db29f61b1",
		TargetGeneration: 3,
		TargetPublicKey:  base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32)),
		TargetCredential: base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{2}, 32)),
		APIOrigin:        "https://breeze.example",
	}
	data, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := installLinuxNativeTargetFile("native-admission.json", data); err != nil {
		t.Fatal(err)
	}
}

func TestLinuxNativeTargetEnrollmentHTTPAndMismatch(t *testing.T) {
	publicKey := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{3}, 32))
	if os.Geteuid() != 0 {
		t.Skip("root-only enrollment")
	}
	if _, err := os.Lstat("/usr/bin/rustdesk"); err == nil {
		t.Skip("disposable container only")
	}
	if err := os.MkdirAll("/usr/share/rustdesk", 0o755); err != nil {
		t.Fatal(err)
	}
	binary := "/usr/share/rustdesk/rustdesk"
	if err := os.WriteFile(binary, []byte("#!/bin/sh\ncase \"$1\" in\n--cloudcom-managed-protocol) echo 2;;\n--get-id) echo 123456789;;\n--cloudcom-managed-public-key) echo "+publicKey+";;\nesac\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(binary, "/usr/bin/rustdesk"); err != nil {
		t.Fatal(err)
	}
	const agentID = "b9d5c9d3-613d-4fea-8dc7-c44db29f61b1"
	const deviceID = "e2867f61-b8d0-4342-9f8d-e99fac1abbb3"
	const orgID = "cdaf191a-fc12-49ea-a2db-79b728b9dcd4"
	const targetID = "d8cb23af-f136-4e1c-940b-e0485a7276c9"
	var mismatch atomic.Bool
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/agents/"+agentID+"/native-target/enroll" || r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("unexpected enrollment request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		var request linuxNativeTargetRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			http.Error(w, "bad JSON", 400)
			return
		}
		if request.Version != 2 || request.RustDeskID != "123456789" || request.TargetPublicKey != publicKey || !validLinuxNativeTargetSeed(linuxNativeTargetSeed{
			Version: request.Version, InstallationID: request.InstallationID,
			TargetPublicKey: request.TargetPublicKey, TargetCredential: request.TargetCredential,
		}) {
			t.Error("invalid enrollment request")
			http.Error(w, "bad request", 400)
			return
		}
		peer := request.RustDeskID
		if mismatch.Load() {
			peer = "999999999"
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(linuxNativeTargetResponse{
			Version: 2, DeviceID: deviceID, OrgID: orgID, TargetID: targetID,
			TargetGeneration: 3, TargetPublicKey: request.TargetPublicKey, PeerID: peer,
		})
	}))
	defer server.Close()
	h := &Heartbeat{config: &config.Config{AgentID: agentID, DeviceID: deviceID,
		ServerURL: server.URL, AuthToken: "test-token"}, client: server.Client()}
	if err := h.enrollNativeRustDeskTargetLinux(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(nativeTargetDirLinux(), "native-admission.json")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var stored linuxNativeTargetStored
	if err := json.Unmarshal(before, &stored); err != nil {
		t.Fatal(err)
	}
	if stored.DeviceID != deviceID || stored.TargetGeneration != 3 || stored.APIOrigin != server.URL {
		t.Fatal("wrong enrollment file")
	}
	mismatch.Store(true)
	if err := h.enrollNativeRustDeskTargetLinux(); err == nil {
		t.Fatal("mismatched peer accepted")
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("rejected response changed enrollment file")
	}
	for _, created := range []string{path, filepath.Join(nativeTargetDirLinux(), "native-admission-seed.json"), "/usr/bin/rustdesk", binary} {
		if err := os.Remove(created); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Remove(nativeTargetDirLinux()); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Dir(binary)); err != nil {
		t.Fatal(err)
	}
}
