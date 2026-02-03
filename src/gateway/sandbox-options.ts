import type { SandboxOptions } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';

/**
 * Build sandbox options based on environment configuration.
 * Shared by the main Worker and the GatewayState Durable Object.
 */
export function buildSandboxOptions(env: MoltbotEnv): SandboxOptions {
  const sleepAfter = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';
  if (sleepAfter === 'never') {
    return { keepAlive: true };
  }
  return { sleepAfter };
}
