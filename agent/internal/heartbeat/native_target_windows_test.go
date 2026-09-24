//go:build windows

package heartbeat

import (
	"bytes"
	"encoding/base64"
	"testing"
)

func TestNativeTargetSeedBindsExistingRustDeskPublicKey(t *testing.T) {
	expected := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x42}, 32))
	seed, err := newNativeTargetSeed(expected)
	if err != nil {
		t.Fatal(err)
	}
	if seed.TargetPublicKey != expected || !validNativeTargetSeed(seed) {
		t.Fatal("enrollment seed did not bind the existing RustDesk public key")
	}
	if _, err := newNativeTargetSeed(base64.RawURLEncoding.EncodeToString(make([]byte, 32))); err == nil {
		t.Fatal("zero RustDesk public key accepted")
	}
	if _, err := newNativeTargetSeed(expected + "="); err == nil {
		t.Fatal("noncanonical RustDesk public key accepted")
	}
}

func TestNativeTargetDPAPIRoundTrip(t *testing.T) {
	plain := []byte("{\"version\":2,\"purpose\":\"native-admission-test\"}")
	cipher, err := protectNativeTargetBlob(plain)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(cipher, plain) {
		t.Fatal("DPAPI returned plaintext")
	}
	restored, err := unprotectNativeTargetBlob(cipher)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(restored, plain) {
		t.Fatal("DPAPI round trip changed enrollment data")
	}
	zeroBytes(cipher)
	zeroBytes(restored)
}

func TestNativeTargetOriginRequiresCanonicalHTTPSOrigin(t *testing.T) {
	for _, value := range []string{"https://breeze.example", "https://breeze.example:8443"} {
		if got, err := nativeTargetOrigin(value); err != nil || got != value {
			t.Fatalf("nativeTargetOrigin(%q) = %q, %v", value, got, err)
		}
	}
	for _, value := range []string{"http://breeze.example", "https://breeze.example/", "https://breeze.example/path", "https://user@breeze.example", "https://breeze.example?x=1"} {
		if _, err := nativeTargetOrigin(value); err == nil {
			t.Errorf("nativeTargetOrigin(%q) unexpectedly succeeded", value)
		}
	}
}

func TestNativeTargetRequestAndSeedValidation(t *testing.T) {
	agentID := "b9d5c9d3-613d-4fea-8dc7-c44db29f61b1"
	endpoint, err := nativeTargetEnrollmentURL("https://breeze.example", agentID)
	if err != nil || endpoint != "https://breeze.example/api/v1/agents/"+agentID+"/native-target/enroll" {
		t.Fatalf("nativeTargetEnrollmentURL() = %q, %v", endpoint, err)
	}
	if _, err := nativeTargetEnrollmentURL("https://breeze.example", "../../devices"); err == nil {
		t.Fatal("invalid agent ID accepted")
	}
	seed := nativeTargetSeed{Version: 2, InstallationID: agentID,
		TargetPublicKey: base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x42}, 32)),
		TargetCredential: base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x24}, 32))}
	if !validNativeTargetSeed(seed) {
		t.Fatal("canonical seed rejected")
	}
	seed.TargetCredential = base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	if validNativeTargetSeed(seed) {
		t.Fatal("zero target credential accepted")
	}
	seed.TargetCredential = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x24}, 32))
	seed.TargetCredential += "="
	if validNativeTargetSeed(seed) {
		t.Fatal("noncanonical credential accepted")
	}
}
