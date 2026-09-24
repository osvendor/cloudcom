//go:build windows

package heartbeat

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/securefs"
)

const (
	nativeTargetEntropy = "CloudCom/RustDesk/native-target/v2"
	nativeTargetLimit   = 16 * 1024
)

type nativeTargetSeed struct {
	Version           uint8  `json:"version"`
	InstallationID    string `json:"installationId"`
	TargetPublicKey   string `json:"targetPublicKey"`
	TargetCredential  string `json:"targetCredential"`
}

type nativeTargetEnrollmentRequest struct {
	Version          uint8  `json:"version"`
	InstallationID   string `json:"installationId"`
	TargetPublicKey  string `json:"targetPublicKey"`
	TargetCredential string `json:"targetCredential"`
	RustDeskID       string `json:"rustdeskId"`
}

type nativeTargetEnrollmentResponse struct {
	Version           uint8  `json:"version"`
	TargetID           string `json:"targetId"`
	DeviceID           string `json:"deviceId"`
	OrgID              string `json:"orgId"`
	TargetGeneration   uint64 `json:"targetGeneration"`
	TargetPublicKey    string `json:"targetPublicKey"`
	PeerID             string `json:"peerId"`
}

type nativeTargetStoredConfig struct {
	Version          uint8  `json:"version"`
	DeviceID         string `json:"deviceId"`
	TargetGeneration uint64 `json:"targetGeneration"`
	TargetPublicKey  string `json:"targetPublicKey"`
	TargetCredential string `json:"targetCredential"`
	APIOrigin        string `json:"apiOrigin"`
}

type winDataBlob struct {
	Size uint32
	Data *byte
}

func (h *Heartbeat) reconcileNativeRustDeskTarget() {
	if !h.isService {
		return
	}
	startupDelay := time.Duration(h.config.HeartbeatIntervalSeconds)*time.Second + 5*time.Second
	if startupDelay < 5*time.Second {
		startupDelay = 35 * time.Second
	}
	if startupDelay > 5*time.Minute {
		startupDelay = 5 * time.Minute
	}
	select {
	case <-h.stopChan:
		return
	case <-time.After(startupDelay):
	}
	if err := h.enrollNativeRustDeskTarget(); err != nil {
		log.Debug("managed RustDesk target enrollment is not ready", "error", err.Error())
	}
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-h.stopChan:
			return
		case <-ticker.C:
			if err := h.enrollNativeRustDeskTarget(); err != nil {
				log.Debug("managed RustDesk target enrollment is not ready", "error", err.Error())
			}
		}
	}
}

func (h *Heartbeat) enrollNativeRustDeskTarget() error {
	executable, err := installedRustDeskServicePath()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	capability, err := exec.CommandContext(ctx, executable, "--cloudcom-managed-protocol").Output()
	if err != nil || strings.TrimSpace(string(capability)) != "2" {
		return errors.New("RustDesk service does not advertise managed protocol v2")
	}
	ctx, cancel = context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	peerIDBytes, err := exec.CommandContext(ctx, executable, "--get-id").Output()
	if err != nil {
		return errors.New("could not read RustDesk peer ID")
	}
	peerID := strings.TrimSpace(string(peerIDBytes))
	if len(peerID) == 0 || len(peerID) > 32 || strings.Trim(peerID, "0123456789") != "" {
		return errors.New("RustDesk peer ID is invalid")
	}
	ctx, cancel = context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	publicKeyBytes, err := exec.CommandContext(ctx, executable, "--cloudcom-managed-public-key").Output()
	if err != nil {
		return errors.New("could not read managed RustDesk public key")
	}
	publicKey := strings.TrimSpace(string(publicKeyBytes))
	if !validNativeTargetPublicKey(publicKey) {
		return errors.New("managed RustDesk public key is invalid")
	}
	apiOrigin, err := nativeTargetOrigin(h.serverURL())
	if err != nil {
		return err
	}
	seed, err := loadOrCreateNativeTargetSeed(publicKey)
	if err != nil {
		return err
	}
	request := nativeTargetEnrollmentRequest{Version: 2, InstallationID: seed.InstallationID,
		TargetPublicKey: seed.TargetPublicKey, TargetCredential: seed.TargetCredential, RustDeskID: peerID}
	body, err := json.Marshal(request)
	if err != nil {
		return err
	}
	defer zeroBytes(body)
	endpoint, err := nativeTargetEnrollmentURL(apiOrigin, h.config.AgentID)
	if err != nil {
		return err
	}
	ctx, cancel = context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", h.authHeader())
	h.clientMu.RLock()
	client := h.client
	h.clientMu.RUnlock()
	if client == nil {
		return errors.New("agent control-plane client unavailable")
	}
	clientCopy := *client
	clientCopy.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := clientCopy.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("native target enrollment returned HTTP %d", resp.StatusCode)
	}
	responseBytes, err := io.ReadAll(io.LimitReader(resp.Body, nativeTargetLimit+1))
	if err != nil || len(responseBytes) > nativeTargetLimit {
		zeroBytes(responseBytes)
		return errors.New("native target enrollment response exceeded the size limit")
	}
	defer zeroBytes(responseBytes)
	var enrolled nativeTargetEnrollmentResponse
	decoder := json.NewDecoder(bytes.NewReader(responseBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&enrolled); err != nil {
		return errors.New("native target enrollment response was invalid")
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return errors.New("native target enrollment response contained trailing data")
	}
	if enrolled.Version != 2 || enrolled.DeviceID != h.config.DeviceID || enrolled.PeerID != peerID ||
		enrolled.TargetPublicKey != seed.TargetPublicKey || enrolled.TargetGeneration == 0 ||
		enrolled.TargetGeneration > 2_147_483_646 || !isCanonicalNativeUUID(enrolled.TargetID) ||
		!isCanonicalNativeUUID(enrolled.OrgID) || !isCanonicalNativeUUID(enrolled.DeviceID) {
		return errors.New("native target enrollment response did not match this device")
	}
	stored := nativeTargetStoredConfig{Version: 2, DeviceID: enrolled.DeviceID,
		TargetGeneration: enrolled.TargetGeneration, TargetPublicKey: seed.TargetPublicKey,
		TargetCredential: seed.TargetCredential, APIOrigin: apiOrigin}
	plain, err := json.Marshal(stored)
	if err != nil {
		return err
	}
	protected, err := protectNativeTargetBlob(plain)
	zeroBytes(plain)
	if err != nil {
		return err
	}
	defer zeroBytes(protected)
	return installNativeTargetFile("native-admission.dpapi", protected)
}

func installedRustDeskServicePath() (string, error) {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Services\RustDesk`, registry.QUERY_VALUE)
	if err != nil {
		return "", errors.New("RustDesk service registration not found")
	}
	defer key.Close()
	imagePath, _, err := key.GetStringValue("ImagePath")
	if err != nil {
		return "", errors.New("RustDesk service executable path not found")
	}
	imagePath = strings.TrimSpace(imagePath)
	if strings.HasPrefix(imagePath, `"`) {
		end := strings.Index(imagePath[1:], `"`)
		if end <= 0 {
			return "", errors.New("RustDesk service executable path is malformed")
		}
		imagePath = imagePath[1 : end+1]
	} else if at := strings.IndexAny(imagePath, " \t"); at >= 0 {
		return "", errors.New("RustDesk service executable path must be quoted")
	}
	if !filepath.IsAbs(imagePath) || strings.ContainsAny(imagePath, "%") {
		return "", errors.New("RustDesk service executable path is not canonical")
	}
	return imagePath, nil
}

func nativeTargetOrigin(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("native admission requires a canonical HTTPS Breeze server URL")
	}
	if u.Path != "" && u.Path != "/" {
		return "", errors.New("native admission Breeze URL cannot contain a path")
	}
	if raw != strings.TrimSuffix(u.Scheme+"://"+u.Host, "/") {
		return "", errors.New("native admission Breeze URL is not canonical")
	}
	return raw, nil
}

func nativeTargetEnrollmentURL(origin, agentID string) (string, error) {
	if !isCanonicalNativeUUID(agentID) {
		return "", errors.New("agent ID is invalid")
	}
	return origin + "/api/v1/agents/" + url.PathEscape(agentID) + "/native-target/enroll", nil
}

func loadOrCreateNativeTargetSeed(actualPublicKey string) (nativeTargetSeed, error) {
	dir := nativeTargetDir()
	if err := securefs.EnsurePrivateDir(dir); err != nil {
		return nativeTargetSeed{}, fmt.Errorf("secure RustDesk enrollment directory: %w", err)
	}
	if err := securefs.VerifyPrivateDir(dir); err != nil {
		return nativeTargetSeed{}, fmt.Errorf("verify RustDesk enrollment directory: %w", err)
	}
	path := filepath.Join(dir, "native-admission-seed.dpapi")
	if info, err := os.Lstat(path); err == nil {
		if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > nativeTargetLimit {
			return nativeTargetSeed{}, errors.New("existing RustDesk enrollment seed is not a regular bounded file")
		}
		ciphertext, err := os.ReadFile(path)
		if err != nil {
			return nativeTargetSeed{}, err
		}
		defer zeroBytes(ciphertext)
		plain, err := unprotectNativeTargetBlob(ciphertext)
		if err != nil {
			return nativeTargetSeed{}, errors.New("existing RustDesk enrollment seed could not be decrypted")
		}
		defer zeroBytes(plain)
		var seed nativeTargetSeed
		decoder := json.NewDecoder(bytes.NewReader(plain))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&seed); err != nil || !validNativeTargetSeed(seed) {
			return nativeTargetSeed{}, errors.New("existing RustDesk enrollment seed is invalid")
		}
		if seed.TargetPublicKey != actualPublicKey {
			return nativeTargetSeed{}, errors.New("RustDesk identity changed; enrollment requires rotation")
		}
		return seed, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nativeTargetSeed{}, err
	}
	seed, err := newNativeTargetSeed(actualPublicKey)
	if err != nil {
		return nativeTargetSeed{}, err
	}
	plain, err := json.Marshal(seed)
	if err != nil {
		return nativeTargetSeed{}, err
	}
	protected, err := protectNativeTargetBlob(plain)
	zeroBytes(plain)
	if err != nil {
		return nativeTargetSeed{}, err
	}
	defer zeroBytes(protected)
	if err := installNativeTargetFile("native-admission-seed.dpapi", protected); err != nil {
		return nativeTargetSeed{}, err
	}
	return seed, nil
}

func validNativeTargetPublicKey(value string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == 32 && base64.RawURLEncoding.EncodeToString(decoded) == value &&
		!bytes.Equal(decoded, make([]byte, 32))
}

func newNativeTargetSeed(actualPublicKey string) (nativeTargetSeed, error) {
	if !validNativeTargetPublicKey(actualPublicKey) {
		return nativeTargetSeed{}, errors.New("managed RustDesk public key is invalid")
	}
	var id [16]byte
	var credential [32]byte
	if _, err := rand.Read(id[:]); err != nil {
		return nativeTargetSeed{}, err
	}
	if _, err := rand.Read(credential[:]); err != nil {
		return nativeTargetSeed{}, err
	}
	id[6] = (id[6] & 0x0f) | 0x40
	id[8] = (id[8] & 0x3f) | 0x80
	seed := nativeTargetSeed{Version: 2, InstallationID: formatNativeUUID(id),
		TargetPublicKey: actualPublicKey, TargetCredential: base64.RawURLEncoding.EncodeToString(credential[:])}
	zeroBytes(credential[:])
	if !validNativeTargetSeed(seed) {
		return nativeTargetSeed{}, errors.New("generated RustDesk enrollment seed is invalid")
	}
	return seed, nil
}

func nativeTargetDir() string { return filepath.Join(config.GetDataDir(), "rustdesk") }

func installNativeTargetFile(name string, data []byte) error {
	if len(data) == 0 || len(data) > nativeTargetLimit {
		return errors.New("RustDesk enrollment file size is invalid")
	}
	dir := nativeTargetDir()
	if err := securefs.EnsurePrivateDir(dir); err != nil {
		return err
	}
	if err := securefs.VerifyPrivateDir(dir); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".native-target-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	_, err = securefs.InstallFile(dir, name, tmpName, 0600, time.Now(), nil)
	if err != nil {
		return err
	}
	return securefs.VerifyPrivateDir(dir)
}

func protectNativeTargetBlob(plain []byte) ([]byte, error) { return nativeTargetCrypt(plain, true) }
func unprotectNativeTargetBlob(ciphertext []byte) ([]byte, error) { return nativeTargetCrypt(ciphertext, false) }

func nativeTargetCrypt(input []byte, protect bool) ([]byte, error) {
	if len(input) == 0 || len(input) > nativeTargetLimit {
		return nil, errors.New("RustDesk enrollment data size is invalid")
	}
	crypt32 := windows.NewLazySystemDLL("crypt32.dll")
	var proc *windows.LazyProc
	if protect {
		proc = crypt32.NewProc("CryptProtectData")
	} else {
		proc = crypt32.NewProc("CryptUnprotectData")
	}
	if err := proc.Find(); err != nil {
		return nil, err
	}
	inputBlob := winDataBlob{Size: uint32(len(input)), Data: &input[0]}
	entropyBytes := []byte(nativeTargetEntropy)
	entropy := winDataBlob{Size: uint32(len(entropyBytes)), Data: &entropyBytes[0]}
	var output winDataBlob
	flags := uintptr(0x1 | 0x4) // UI_FORBIDDEN | LOCAL_MACHINE
	var ok uintptr
	if protect {
		ok, _, _ = proc.Call(uintptr(unsafe.Pointer(&inputBlob)), 0, uintptr(unsafe.Pointer(&entropy)), 0, 0, flags, uintptr(unsafe.Pointer(&output)))
	} else {
		ok, _, _ = proc.Call(uintptr(unsafe.Pointer(&inputBlob)), 0, uintptr(unsafe.Pointer(&entropy)), 0, 0, flags, uintptr(unsafe.Pointer(&output)))
	}
	if ok == 0 || output.Data == nil || output.Size == 0 || output.Size > nativeTargetLimit {
		if output.Data != nil { windows.LocalFree(windows.Handle(unsafe.Pointer(output.Data))) }
		return nil, errors.New("Windows DPAPI rejected RustDesk enrollment data")
	}
	result := append([]byte(nil), unsafe.Slice(output.Data, output.Size)...)
	windows.LocalFree(windows.Handle(unsafe.Pointer(output.Data)))
	return result, nil
}

func validNativeTargetSeed(seed nativeTargetSeed) bool {
	if seed.Version != 2 || !isCanonicalNativeUUID(seed.InstallationID) { return false }
	for _, value := range []string{seed.TargetPublicKey, seed.TargetCredential} {
		decoded, err := base64.RawURLEncoding.DecodeString(value)
		if err != nil || len(decoded) != 32 || base64.RawURLEncoding.EncodeToString(decoded) != value ||
			bytes.Equal(decoded, make([]byte, 32)) { return false }
	}
	return true
}

func isCanonicalNativeUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' { return false }
	compact := strings.ReplaceAll(value, "-", "")
	if len(compact) != 32 || strings.ToLower(compact) != compact { return false }
	for _, char := range compact { if !strings.ContainsRune("0123456789abcdef", char) { return false } }
	return strings.ContainsRune("12345678", rune(compact[12])) && strings.ContainsRune("89ab", rune(compact[16]))
}

func formatNativeUUID(id [16]byte) string {
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", id[0:4], id[4:6], id[6:8], id[8:10], id[10:16])
}

func zeroBytes(value []byte) { for i := range value { value[i] = 0 } }
