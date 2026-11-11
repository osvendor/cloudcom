package desktop

import (
	"testing"
	"time"
)

func TestSessionManagerStartsCodecWithoutBlocking(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan struct{})
	created := make(chan *SessionManager, 1)
	defer close(release)
	go func() {
		created <- NewSessionManagerWithPreloader(func() {
			close(started)
			<-release
			close(finished)
		})
	}()
	select {
	case m := <-created:
		if m.sessions == nil {
			t.Fatal("session storage not initialized")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("constructor blocked on codec startup")
	}
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("codec startup not invoked")
	}
	select {
	case <-finished:
		t.Fatal("codec startup did not remain independent of constructor")
	default:
	}
}
