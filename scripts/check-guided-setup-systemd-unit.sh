#!/usr/bin/env bash

# Behavioral guard: the systemd unit that guided-setup.sh installs must be a
# unit systemd actually accepts.
#
# Why this guard exists
# ---------------------
# The unit is generated from a heredoc, so nothing validated it until a
# self-hoster's `systemctl enable --now` failed at install time with
# "Unit breeze-rmm.service has a bad unit file setting." That shipped TWICE
# under #4201:
#   1. `Type=oneshot` + `Restart=on-failure` — a combination systemd rejects.
#   2. `WorkingDirectory='/home/breeze/breeze'` — the path was wrapped by
#      shell_quote(); systemd does not unquote WorkingDirectory= (unlike
#      ExecStart=), so the leading quote made the path non-absolute (-ENOEXEC).
# The first guard only grepped for case 1 and deliberately skipped
# systemd-analyze, so case 2 sailed through CI and reached the same customer.
#
# What this guard does
# --------------------
# 1. Static checks that run everywhere (macOS included): the known-bad shapes.
# 2. Renders the REAL unit + boot helper through the installer's own code path
#    (`guided-setup.sh --render-systemd-unit DIR`) and runs `systemd-analyze
#    verify` in an empty systemd root wherever systemd-analyze exists — every
#    Linux CI runner.
#    That is the same parser systemd uses at `systemctl enable`, so any future
#    directive systemd rejects fails here, in the required Lint job, instead
#    of on a self-hoster's box.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SETUP="${REPO_ROOT}/scripts/guided-setup.sh"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

fail=0

# --- 1. Static checks on the heredoc ---------------------------------------
unit_text="$(awk '/^\[Unit\]$/,/^EOF$/' "${SETUP}")"

if [[ -z "${unit_text}" ]]; then
  echo "ERROR: could not locate the generated systemd unit heredoc in ${SETUP}" >&2
  exit 1
fi

if grep -q '^Type=oneshot' <<<"${unit_text}" && grep -Eq '^Restart=(always|on-failure|on-success|on-abort|on-watchdog)' <<<"${unit_text}"; then
  echo "ERROR: generated unit combines Type=oneshot with a Restart= value systemd rejects (\"bad unit file setting\", #4201)." >&2
  fail=1
fi

# WorkingDirectory= takes a raw path: systemd does not strip quotes, so a
# shell_quote()d value is a non-absolute path and the whole unit is rejected.
if grep -Eq '^WorkingDirectory=.*(shell_quote|bash_source_quote)' <<<"${unit_text}"; then
  echo "ERROR: generated unit quotes WorkingDirectory=; systemd does not unquote it and rejects the unit (\"bad unit file setting\", #4201)." >&2
  fail=1
fi

# --- 2. Render through the installer and verify with systemd itself ---------
# An isolated systemd root prevents verify from walking units supplied by the
# host (for example, transient units under /run/systemd/system). A work dir
# with a space and a % proves the path survives unquoted and that %-specifier
# escaping is applied (systemd expands % in unit paths).
SYSTEMD_ROOT="${TMP_DIR}/systemd-root"
WORK="${TMP_DIR}/breeze work%dir"
HELPER_PATH="${TMP_DIR}/breeze-compose-boot.sh"
RENDER="${TMP_DIR}/render"
mkdir -p "${SYSTEMD_ROOT}${WORK}" "$(dirname "${SYSTEMD_ROOT}${HELPER_PATH}")" \
  "${SYSTEMD_ROOT}/etc/systemd/system"

if ! BREEZE_SETUP_SYSTEMD_HELPER_FILE="${HELPER_PATH}" \
  bash "${SETUP}" --work-dir "${WORK}" --render-systemd-unit "${RENDER}" >"${TMP_DIR}/render.log" 2>&1; then
  echo "ERROR: guided-setup.sh --render-systemd-unit failed:" >&2
  cat "${TMP_DIR}/render.log" >&2
  exit 1
fi

UNIT="${RENDER}/breeze-rmm.service"
HELPER="${RENDER}/breeze-compose-boot.sh"
[[ -f "${UNIT}" ]] || { echo "ERROR: ${UNIT} was not rendered" >&2; exit 1; }
[[ -x "${HELPER}" ]] || { echo "ERROR: ${HELPER} was not rendered executable" >&2; exit 1; }

if ! bash -n "${HELPER}"; then
  echo "ERROR: rendered boot helper has a bash syntax error" >&2
  fail=1
fi

# The rendered WorkingDirectory must be the raw absolute path (specifier-escaped).
expected_wd="WorkingDirectory=${WORK//%/%%}"
if ! grep -qxF "${expected_wd}" "${UNIT}"; then
  echo "ERROR: rendered unit does not contain the raw work dir path:" >&2
  echo "  expected: ${expected_wd}" >&2
  echo "  got:      $(grep '^WorkingDirectory=' "${UNIT}" || echo '<missing>')" >&2
  fail=1
fi

if command -v systemd-analyze >/dev/null 2>&1; then
  # Verify by unit name inside an otherwise empty root, never by an absolute
  # file path against the host's unit search path. This keeps unrelated host
  # units out of CI while still passing the generated unit through systemd's
  # parser. The required docker.service and wanted network-online.target are
  # intentionally absent: their presence is deployment state, not syntax in
  # the unit we generate.
  install -m 0644 "${UNIT}" "${SYSTEMD_ROOT}/etc/systemd/system/breeze-rmm.service"
  install -m 0755 "${HELPER}" "${SYSTEMD_ROOT}${HELPER_PATH}"

  # --recursive-errors=no (systemd >= 250): missing external dependencies in
  # the isolated root are not defects in our unit. Older systemd lacks the
  # flag, but still verifies the generated unit inside the isolated root.
  if systemd-analyze verify --help 2>/dev/null | grep -q -- '--recursive-errors'; then
    verify_cmd=(systemd-analyze --root="${SYSTEMD_ROOT}" verify --recursive-errors=no breeze-rmm.service)
  else
    verify_cmd=(systemd-analyze --root="${SYSTEMD_ROOT}" verify breeze-rmm.service)
  fi
  if ! "${verify_cmd[@]}" >"${TMP_DIR}/verify.log" 2>&1; then
    echo "ERROR: systemd-analyze verify rejected the generated unit:" >&2
    cat "${TMP_DIR}/verify.log" >&2
    fail=1
  elif grep -Eiq 'bad unit file setting|fatal error|not absolute|ignoring' "${TMP_DIR}/verify.log"; then
    # verify can exit 0 while still logging a directive it dropped ("...,
    # ignoring"); a dropped directive is a broken unit for us.
    echo "ERROR: systemd-analyze verify reported a rejected directive:" >&2
    cat "${TMP_DIR}/verify.log" >&2
    fail=1
  fi
  verified="systemd-analyze verify ($(systemd-analyze --version | head -1))"
else
  verified="static checks only (systemd-analyze not available on this host)"
fi

if [[ "${fail}" -ne 0 ]]; then
  exit 1
fi
echo "guided-setup systemd unit: OK — ${verified}"
