-- Periodic monitor reconciliation looks up a command by its execution ID.
-- Without this expression index every pending offline probe scans command history.
-- Include type in the key so parameterized/generic plans can use the index too.
CREATE INDEX IF NOT EXISTS cloudcom_device_commands_execution_idx
  ON device_commands (type, (payload->>'executionId'));

-- Support both last-run cadence checks and active-run suppression by monitor/device.
CREATE INDEX IF NOT EXISTS cloudcom_script_executions_monitor_device_status_idx
  ON script_executions (monitor_id, device_id, status, created_at DESC);
