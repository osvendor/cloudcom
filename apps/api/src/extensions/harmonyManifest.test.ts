import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseExtensionManifestV1 } from '@breeze/extension-sdk';
import { isSelfManagedDbContextRoute } from '../middleware/selfManagedDbContextRoutes';

describe('Harmony host registration', () => {
  it('validates the real manifest, including jobs and client erasure declarations', () => {
    const manifest = parseExtensionManifestV1(JSON.parse(readFileSync('../../packages/ext-cloud-command/manifest.json','utf8')));
    expect(manifest.jobs).toContainEqual({ name: 'harmony-sync', cron: '*/5 * * * *' });
    expect(manifest.tenancy.orgCascadeDeleteTables).toEqual(expect.arrayContaining(['cloudcommand_harmony_clients','cloudcommand_harmony_endpoints','cloudcommand_harmony_scopes']));
  });
  it.each(['ext/cloudcommand','cloud-command'])('only exempts exact Harmony routes under %s', namespace => {
    const path = `/api/v1/${namespace}/harmony/`;
    for (const [method, suffix] of [['GET','connection'],['GET','inventory'],['POST','discover'],['POST','sync'],['PUT','connection'],['PUT','mappings'],['PUT','link']]) {
      expect(isSelfManagedDbContextRoute(method!,path+suffix)).toBe(true);
      expect(isSelfManagedDbContextRoute('DELETE',path+suffix)).toBe(false);
      expect(isSelfManagedDbContextRoute(method!,path+suffix+'/nested')).toBe(false);
    }
  });
});
