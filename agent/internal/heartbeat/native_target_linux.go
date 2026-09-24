//go:build linux

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
	"sync"
	"syscall"
	"time"

	"github.com/breeze-rmm/agent/internal/securefs"
)

const (
	linuxNativeTargetLimit = 16 * 1024
	linuxNativeTargetData  = "/var/lib/breeze/rustdesk"
)

var linuxNativeTargetMu sync.Mutex

type linuxNativeTargetSeed struct {
	Version          uint8  `json:"version"`
	InstallationID   string `json:"installationId"`
	TargetPublicKey  string `json:"targetPublicKey"`
	TargetCredential string `json:"targetCredential"`
}

type linuxNativeTargetRequest struct {
	Version          uint8  `json:"version"`
	InstallationID   string `json:"installationId"`
	TargetPublicKey  string `json:"targetPublicKey"`
	TargetCredential string `json:"targetCredential"`
	RustDeskID       string `json:"rustdeskId"`
}

type linuxNativeTargetResponse struct {
	Version          uint8  `json:"version"`
	DeviceID         string `json:"deviceId"`
	OrgID            string `json:"orgId"`
	TargetID         string `json:"targetId"`
	TargetGeneration uint64 `json:"targetGeneration"`
	TargetPublicKey  string `json:"targetPublicKey"`
	PeerID           string `json:"peerId"`
}

type linuxNativeTargetStored struct {
	Version          uint8  `json:"version"`
	DeviceID         string `json:"deviceId"`
	TargetGeneration uint64 `json:"targetGeneration"`
	TargetPublicKey  string `json:"targetPublicKey"`
	TargetCredential string `json:"targetCredential"`
	APIOrigin        string `json:"apiOrigin"`
}

func (h *Heartbeat) reconcileNativeRustDeskTarget() {
	if !h.isService {
		return
	}
	delay := time.Duration(h.config.HeartbeatIntervalSeconds)*time.Second + 5*time.Second
	if delay < 5*time.Second || delay > 5*time.Minute {
		delay = 35 * time.Second
	}
	select {
	case <-h.stopChan:
		return
	case <-time.After(delay):
	}
	if err := h.enrollNativeRustDeskTargetLinux(); err != nil {
		log.Debug("managed RustDesk target enrollment is not ready", "error", err.Error())
	}
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-h.stopChan:
			return
		case <-ticker.C:
			if err := h.enrollNativeRustDeskTargetLinux(); err != nil {
				log.Debug("managed RustDesk target enrollment is not ready", "error", err.Error())
			}
		}
	}
}

func (h *Heartbeat) enrollNativeRustDeskTargetLinux() error {
	executable, err := installedRustDeskServicePathLinux()
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
	peerBytes, err := exec.CommandContext(ctx, executable, "--get-id").Output()
	if err != nil {
		return errors.New("could not read RustDesk peer ID")
	}
	peerID := strings.TrimSpace(string(peerBytes))
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
	if !validLinuxNativeTargetPublicKey(publicKey) {
		return errors.New("managed RustDesk public key is invalid")
	}
	origin, err := nativeTargetOrigin(h.serverURL())
	if err != nil {
		return err
	}
	seed, err := loadOrCreateLinuxNativeTargetSeed(publicKey)
	if err != nil {
		return err
	}
	requestBody, err := json.Marshal(linuxNativeTargetRequest{Version: 2, InstallationID: seed.InstallationID,
		TargetPublicKey: seed.TargetPublicKey, TargetCredential: seed.TargetCredential, RustDeskID: peerID})
	if err != nil {
		return err
	}
	defer zeroBytes(requestBody)
	if !isCanonicalNativeUUID(h.config.AgentID) || !isCanonicalNativeUUID(h.config.DeviceID) {
		return errors.New("Breeze device identity is invalid")
	}
	endpoint := origin + "/api/v1/agents/" + url.PathEscape(h.config.AgentID) + "/native-target/enroll"
	ctx, cancel = context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(requestBody))
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
	responseBytes, err := io.ReadAll(io.LimitReader(resp.Body, linuxNativeTargetLimit+1))
	if err != nil || len(responseBytes) > linuxNativeTargetLimit {
		zeroBytes(responseBytes)
		return errors.New("native target enrollment response exceeded the size limit")
	}
	defer zeroBytes(responseBytes)
	var enrolled linuxNativeTargetResponse
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
	plain, err := json.Marshal(linuxNativeTargetStored{Version: 2, DeviceID: enrolled.DeviceID,
		TargetGeneration: enrolled.TargetGeneration, TargetPublicKey: seed.TargetPublicKey,
		TargetCredential: seed.TargetCredential, APIOrigin: origin})
	if err != nil {
		return err
	}
	defer zeroBytes(plain)
	return installLinuxNativeTargetFile("native-admission.json", plain)
}

func installedRustDeskServicePathLinux() (string, error) {
	for _, path := range []string{"/usr/bin/rustdesk", "/usr/local/bin/rustdesk", "/opt/rustdesk/rustdesk", "/usr/share/rustdesk/rustdesk"} {
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil {
			continue
		}
		if resolved != "/usr/bin/rustdesk" && resolved != "/usr/local/bin/rustdesk" && resolved != "/opt/rustdesk/rustdesk" && resolved != "/usr/share/rustdesk/rustdesk" {
			continue
		}
		info, err := os.Stat(resolved)
		if err != nil {
			return "", err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.Mode().IsRegular() || info.Mode().Perm()&0o022 != 0 || stat.Uid != 0 {
			return "", errors.New("RustDesk executable path is not a trusted regular file")
		}
		return resolved, nil
	}
	return "", errors.New("RustDesk service executable not found in a supported system path")
}

func loadOrCreateLinuxNativeTargetSeed(actualPublicKey string) (linuxNativeTargetSeed, error) {
	if !validLinuxNativeTargetPublicKey(actualPublicKey) {
		return linuxNativeTargetSeed{}, errors.New("managed RustDesk public key is invalid")
	}
	linuxNativeTargetMu.Lock()
	defer linuxNativeTargetMu.Unlock()
	if err := securefs.EnsurePrivateDir(nativeTargetDirLinux()); err != nil {
		return linuxNativeTargetSeed{}, fmt.Errorf("secure RustDesk enrollment directory: %w", err)
	}
	if err := verifyLinuxNativeTargetDir(nativeTargetDirLinux()); err != nil {
		return linuxNativeTargetSeed{}, fmt.Errorf("verify RustDesk enrollment directory: %w", err)
	}
	path := filepath.Join(nativeTargetDirLinux(), "native-admission-seed.json")
	if info, err := os.Lstat(path); err == nil {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 || stat.Uid != 0 || info.Size() <= 0 || info.Size() > linuxNativeTargetLimit {
			return linuxNativeTargetSeed{}, errors.New("existing RustDesk enrollment seed is not a private regular bounded file")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return linuxNativeTargetSeed{}, err
		}
		defer zeroBytes(data)
		var seed linuxNativeTargetSeed
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&seed); err != nil || !validLinuxNativeTargetSeed(seed) {
			return linuxNativeTargetSeed{}, errors.New("existing RustDesk enrollment seed is invalid")
		}
		var trailing any
		if decoder.Decode(&trailing) != io.EOF {
			return linuxNativeTargetSeed{}, errors.New("existing RustDesk enrollment seed contained trailing data")
		}
		if seed.TargetPublicKey != actualPublicKey {
			return linuxNativeTargetSeed{}, errors.New("RustDesk identity changed; enrollment requires rotation")
		}
		return seed, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return linuxNativeTargetSeed{}, err
	}
	var installationID [16]byte
	var credential [32]byte
	if _, err := rand.Read(installationID[:]); err != nil {
		return linuxNativeTargetSeed{}, err
	}
	if _, err := rand.Read(credential[:]); err != nil {
		return linuxNativeTargetSeed{}, err
	}
	installationID[6] = (installationID[6] & 0x0f) | 0x40
	installationID[8] = (installationID[8] & 0x3f) | 0x80
	seed := linuxNativeTargetSeed{Version: 2, InstallationID: formatNativeUUID(installationID),
		TargetPublicKey:  actualPublicKey,
		TargetCredential: base64.RawURLEncoding.EncodeToString(credential[:])}
	zeroBytes(credential[:])
	data, err := json.Marshal(seed)
	if err != nil {
		return linuxNativeTargetSeed{}, err
	}
	defer zeroBytes(data)
	if err := installNativeTargetFileLinux("native-admission-seed.json", data); err != nil {
		return linuxNativeTargetSeed{}, err
	}
	return seed, nil
}

func installLinuxNativeTargetFile(name string, data []byte) error {
	if len(data) == 0 || len(data) > linuxNativeTargetLimit {
		return errors.New("RustDesk enrollment file size is invalid")
	}
	return installNativeTargetFileLinux(name, data)
}

func validLinuxNativeTargetSeed(seed linuxNativeTargetSeed) bool {
	if seed.Version != 2 || !isCanonicalNativeUUID(seed.InstallationID) {
		return false
	}
	for _, value := range []string{seed.TargetPublicKey, seed.TargetCredential} {
		decoded, err := base64.RawURLEncoding.DecodeString(value)
		if err != nil || len(decoded) != 32 || base64.RawURLEncoding.EncodeToString(decoded) != value || bytes.Equal(decoded, make([]byte, 32)) {
			return false
		}
	}
	return true
}

func validLinuxNativeTargetPublicKey(value string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == 32 && base64.RawURLEncoding.EncodeToString(decoded) == value &&
		!bytes.Equal(decoded, make([]byte, 32))
}

func nativeTargetDirLinux() string { return linuxNativeTargetData }

func installNativeTargetFileLinux(name string, data []byte) error {
	if len(data) == 0 || len(data) > linuxNativeTargetLimit {
		return errors.New("RustDesk enrollment file size is invalid")
	}
	dir := nativeTargetDirLinux()
	if err := securefs.EnsurePrivateDir(dir); err != nil {
		return err
	}
	if err := verifyLinuxNativeTargetDir(dir); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".native-target-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
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
	if _, err := securefs.InstallFile(dir, name, tmpName, 0o600, time.Now(), nil); err != nil {
		return err
	}
	if err := verifyLinuxNativeTargetDir(dir); err != nil {
		return err
	}
	info, err := securefs.StatFile(dir, name)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 || stat.Uid != 0 || info.Size() != int64(len(data)) {
		return errors.New("RustDesk enrollment file was not stored privately")
	}
	return nil
}

func verifyLinuxNativeTargetDir(dir string) error {
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o700 || stat.Uid != 0 {
		return errors.New("RustDesk enrollment directory is not root-owned and private")
	}
	return nil
}

func nativeTargetOrigin(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("native admission requires a canonical HTTPS Breeze server URL")
	}
	if u.Path != "" && u.Path != "/" {
		return "", errors.New("native admission Breeze URL cannot contain a path")
	}
	if raw != u.Scheme+"://"+u.Host {
		return "", errors.New("native admission Breeze URL is not canonical")
	}
	return raw, nil
}

func isCanonicalNativeUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	compact := strings.ReplaceAll(value, "-", "")
	if len(compact) != 32 || strings.ToLower(compact) != compact {
		return false
	}
	for _, char := range compact {
		if !strings.ContainsRune("0123456789abcdef", char) {
			return false
		}
	}
	return strings.ContainsRune("12345678", rune(compact[12])) && strings.ContainsRune("89ab", rune(compact[16]))
}

func formatNativeUUID(id [16]byte) string {
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", id[0:4], id[4:6], id[6:8], id[8:10], id[10:16])
}

func zeroBytes(value []byte) {
	for i := range value {
		value[i] = 0
	}
}
