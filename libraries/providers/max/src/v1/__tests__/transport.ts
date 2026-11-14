import { vi } from 'vitest';
import { setSocialFetchPorts } from '@postmill-ai/provider-kernel';
export const wire = vi.fn();
export const timer = vi.fn(async () => undefined);
export class BodyError extends Error {
  constructor(
    public identifier: string,
    public json: string,
    public body: unknown,
    message: string,
  ) {
    super(message);
  }
}
export function installTransport() {
  wire.mockReset();
  timer.mockClear();
  setSocialFetchPorts({
    undiciFetch: wire,
    safeFetch: wire,
    ssrfSafeDispatcher: { synthetic: true },
    getVpnDispatcher: () => undefined,
    isSafePublicHttpsUrl: async () => true,
    BadBodyError: BodyError,
    RefreshTokenError: BodyError,
    timer,
    sharp: vi.fn(),
    readOrFetch: async () => Buffer.from(''),
  });
}
export function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
