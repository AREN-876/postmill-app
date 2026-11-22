import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Editorial 13 — private draft ingress excludes public all-in-one nginx', () => {
  it('blocks the machine create and read routes before the public /api proxy', () => {
    const nginx = fs.readFileSync(
      path.resolve(__dirname, '../../../../docker/nginx.prod.conf'),
      'utf8',
    );
    const deny = nginx.indexOf('location ^~ /api/internal/editorial/v1/drafts {');
    const general = nginx.indexOf('location /api/ {');
    expect(deny).toBeGreaterThan(-1);
    expect(general).toBeGreaterThan(deny);
    const block = nginx.slice(deny, nginx.indexOf('}', deny) + 1);
    expect(block).toMatch(/return\s+404\s*;/);
    expect(block).not.toMatch(/proxy_pass|allow\s+all/);
  });
});
