/**
 * GatewayState Durable Object: single-owner gateway lifecycle and concurrency-safe lock.
 * All ensure/restart calls are serialized here so only one start/restart runs at a time.
 */

import { getSandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import {
  ensureGatewayRunningLogic,
  restartGatewayLogic,
  type GatewayStateRef,
} from './lifecycle';
import { buildSandboxOptions } from './sandbox-options';

const SANDBOX_ID = 'moltbot';

/**
 * Durable Object that holds gateway state and a single start/restart lock.
 */
export class GatewayState implements DurableObject {
  private state: GatewayStateRef;
  private startLock: Promise<void> | null = null;
  private env: MoltbotEnv;

  constructor(_state: DurableObjectState, env: MoltbotEnv) {
    this.env = env;
    this.state = {
      gatewayProcessId: null,
      lastGatewayStartAttempt: 0,
      gatewayReady: false,
      lastHealthCheck: 0,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, '') || 'ensure';

    if (path === 'ensure') {
      return this.handleEnsure();
    }
    if (path === 'restart') {
      return this.handleRestart();
    }
    if (path === 'state') {
      return this.handleGetState();
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private getSandbox() {
    const options = buildSandboxOptions(this.env);
    return getSandbox(this.env.Sandbox, SANDBOX_ID, options);
  }

  private async runWithLock<T>(fn: () => Promise<T>): Promise<T> {
    while (this.startLock) {
      await this.startLock;
    }
    const promise = (async () => {
      try {
        return await fn();
      } finally {
        this.startLock = null;
      }
    })();
    this.startLock = promise as Promise<void>;
    return promise;
  }

  private async handleEnsure(): Promise<Response> {
    try {
      await this.runWithLock(async () => {
        const sandbox = this.getSandbox();
        await ensureGatewayRunningLogic(sandbox, this.env, this.state);
      });
      return new Response(
        JSON.stringify({
          ok: true,
          gatewayReady: this.state.gatewayReady,
          processId: this.state.gatewayProcessId,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('[GatewayState] ensure failed:', message);
      return new Response(
        JSON.stringify({ ok: false, error: message }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  private async handleRestart(): Promise<Response> {
    try {
      await this.runWithLock(async () => {
        const sandbox = this.getSandbox();
        await restartGatewayLogic(sandbox, this.env, this.state);
      });
      return new Response(
        JSON.stringify({
          ok: true,
          gatewayReady: this.state.gatewayReady,
          processId: this.state.gatewayProcessId,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('[GatewayState] restart failed:', message);
      return new Response(
        JSON.stringify({ ok: false, error: message }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  private handleGetState(): Response {
    return new Response(
      JSON.stringify({
        gatewayReady: this.state.gatewayReady,
        gatewayProcessId: this.state.gatewayProcessId,
        lastGatewayStartAttempt: this.state.lastGatewayStartAttempt
          ? new Date(this.state.lastGatewayStartAttempt).toISOString()
          : null,
        lastHealthCheck: this.state.lastHealthCheck
          ? new Date(this.state.lastHealthCheck).toISOString()
          : null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
