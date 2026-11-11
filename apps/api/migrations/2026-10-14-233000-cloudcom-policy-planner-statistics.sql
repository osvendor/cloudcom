-- Small configuration tables may never cross PostgreSQL's default 50-change
-- autoanalyze threshold. Missing statistics made the RLS-heavy policy queries
-- plan for hundreds of rows when only 0-8 rows existed. Initialize statistics
-- and refresh after small edits; this changes no rows, policies or permissions.
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'configuration_policies',
    'config_policy_assignments',
    'config_policy_feature_links',
    'config_policy_alert_rules',
    'config_policy_automations',
    'config_policy_backup_settings',
    'config_policy_compliance_rules',
    'config_policy_event_log_settings',
    'config_policy_hardware_monitoring_settings',
    'config_policy_maintenance_settings',
    'config_policy_monitoring_settings',
    'config_policy_monitoring_watches',
    'config_policy_monitors',
    'config_policy_onedrive_libraries',
    'config_policy_onedrive_settings',
    'config_policy_patch_settings',
    'config_policy_remote_access_settings',
    'config_policy_sensitive_data_settings',
    'config_policy_time_sync_settings'
  ] LOOP
    IF to_regclass(format('public.%I', target)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I SET (autovacuum_analyze_threshold = 0, autovacuum_analyze_scale_factor = 0.1)', target);
      EXECUTE format('ANALYZE public.%I', target);
    END IF;
  END LOOP;
END $$;
