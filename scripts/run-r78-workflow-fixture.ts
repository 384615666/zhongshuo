import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildR78WorkflowFixture } from './lib/r78-workflow-fixture.ts';

const root = process.argv[2];
if (root == null || root.trim().length === 0) {
  throw new Error('usage: node --experimental-strip-types scripts/run-r78-workflow-fixture.ts <fresh-dedicated-root>');
}
process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_REAL_BATCH_ID;
const result = await buildR78WorkflowFixture(root);
writeFileSync(join(result.root, 'r78-fixture-report.json'), JSON.stringify(result, null, 2), 'utf8');
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
