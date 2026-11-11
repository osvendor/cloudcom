import { defineConfig } from 'vitest/config';
// Every test owns its isolated fixtures. Do not attach upstream TRUNCATE hooks.
export default defineConfig({ test: {
  environment: 'node', maxWorkers: 1, fileParallelism: false, testTimeout: 60000, hookTimeout: 60000,
  include: [
    'src/__tests__/integration/harmonyRls.integration.test.ts',
    'src/__tests__/integration/harmonyPublication.integration.test.ts',
    'src/db/preparedPolicyReads.integration.test.ts',
    'src/services/deviceIdentity.pg.test.ts',
    'src/services/agentRolloutAdmission.redis.test.ts',
  ],
} });
