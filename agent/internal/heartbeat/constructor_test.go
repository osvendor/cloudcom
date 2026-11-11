package heartbeat

import (
	"crypto/tls"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/secmem"
)

// Keep external codec startup out of command/consent unit tests. Real codec
// startup and encoding run in the mandatory openh264integration CI suite.
func newTestHeartbeatWithVersion(cfg *config.Config, version string, token *secmem.SecureString, tlsCfg *tls.Config) *Heartbeat {
	return newWithVersion(cfg, version, token, tlsCfg, nil)
}

func newTestHeartbeatWithoutCodec(cfg *config.Config) *Heartbeat {
	return newTestHeartbeatWithVersion(cfg, "0.1.0", nil, nil)
}
