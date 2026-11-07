import test from 'node:test';
import { syncDocVersions } from '../scripts/sync-doc-versions.mjs';

test('published installation instructions use this package release', () => {
  syncDocVersions({ check: true });
});
