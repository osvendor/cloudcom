//go:build !windows && !linux

package heartbeat

func (h *Heartbeat) reconcileNativeRustDeskTarget() {}
