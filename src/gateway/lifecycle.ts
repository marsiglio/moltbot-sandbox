/**
 * Gateway lifecycle: health check, ensure running, stop, restart.
 * Used by the GatewayState Durable Object; state and locking are owned by the DO.
 */

import type { Sandbox, Process } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { MOLTBOT_PORT, STARTUP_TIMEOUT_MS } from '../config';
import { buildEnvVars } from './env';
import { mountR2Storage } from './r2';
import { findExistingMoltbotProcess } from './process';
import { waitForProcess } from './utils';

/** Gateway state held by the Durable Object (mutated in place). */
export interface GatewayStateRef {
  gatewayProcessId: string | null;
  lastGatewayStartAttempt: number;
  gatewayReady: boolean;
  lastHealthCheck: number;
}

const GATEWAY_WS_URL = 'ws://localhost:18789';
const CLAWDBOT_DATA_DIR = '/root/.clawdbot';
const STOP_GRACEFUL_TIMEOUT_MS = 10_000;
const PORT_FREE_WAIT_MS = 3_000;

/**
 * Lightweight health check: if the gateway responds on port 18789, treat as running.
 * Tries HTTP GET first; avoids starting a new gateway when one is already up.
 */
export async function isGatewayHealthy(sandbox: Sandbox): Promise<boolean> {
  try {
    const url = `http://localhost:${MOLTBOT_PORT}/`;
    const res = await sandbox.containerFetch(new Request(url), MOLTBOT_PORT);
    // Any response (including 4xx/5xx) means the gateway is listening
    return res.status > 0;
  } catch {
    return false;
  }
}

/**
 * Clear *.lock files in the clawdbot data directory and known lock paths.
 * Only call after confirming the gateway process has exited.
 */
export async function clearLockFiles(sandbox: Sandbox): Promise<void> {
  try {
    const proc = await sandbox.startProcess(
      `rm -f /tmp/clawdbot-gateway.lock "${CLAWDBOT_DATA_DIR}/gateway.lock" ${CLAWDBOT_DATA_DIR}/*.lock 2>/dev/null || true`
    );
    await waitForProcess(proc, 5000);
  } catch (e) {
    console.log('[Gateway] clearLockFiles error (non-fatal):', e);
  }
}

/**
 * Stop the gateway: prefer graceful (clawdbot gateway stop), then force kill by process id.
 */
export async function stopGateway(
  sandbox: Sandbox,
  processId: string | null
): Promise<void> {
  // 1) Try graceful stop via CLI
  try {
    const proc = await sandbox.startProcess(`clawdbot gateway stop --url ${GATEWAY_WS_URL}`);
    await waitForProcess(proc, STOP_GRACEFUL_TIMEOUT_MS);
    const logs = await proc.getLogs();
    console.log('[Gateway] Stopping gateway (graceful):', processId, 'stdout:', logs.stdout?.slice(0, 200));
  } catch (e) {
    console.log('[Gateway] Graceful stop failed or timed out:', e);
  }

  // 2) Force kill by process id if we have it
  if (processId) {
    try {
      const processes = await sandbox.listProcesses();
      const proc = processes.find((p) => p.id === processId);
      if (proc && (proc.status === 'running' || proc.status === 'starting')) {
        console.log('[Gateway] Force killing process:', processId);
        await proc.kill();
      }
    } catch (e) {
      console.log('[Gateway] Force kill failed:', e);
    }
  }

  // 3) Fallback: find any gateway process and kill it
  const existing = await findExistingMoltbotProcess(sandbox);
  if (existing) {
    console.log('[Gateway] Killing remaining gateway process:', existing.id);
    try {
      await existing.kill();
    } catch (e) {
      console.log('[Gateway] Kill failed:', e);
    }
  }
}

/**
 * Wait until port 18789 is free (no listener). Polls with a short timeout.
 */
async function waitForPortFree(sandbox: Sandbox): Promise<void> {
  await new Promise((r) => setTimeout(r, PORT_FREE_WAIT_MS));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const healthy = await isGatewayHealthy(sandbox);
    if (!healthy) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Ensure the Moltbot gateway is running (single-owner logic; caller holds the lock).
 * Updates stateRef in place.
 */
export async function ensureGatewayRunningLogic(
  sandbox: Sandbox,
  env: MoltbotEnv,
  stateRef: GatewayStateRef
): Promise<void> {
  // 1) Fast path: cached ready
  if (stateRef.gatewayReady) {
    console.log('[Gateway] gateway already healthy (cached), processId:', stateRef.gatewayProcessId);
    return;
  }

  // 2) Lightweight health check before starting
  if (await isGatewayHealthy(sandbox)) {
    stateRef.gatewayReady = true;
    stateRef.lastHealthCheck = Date.now();
    const existing = await findExistingMoltbotProcess(sandbox);
    if (existing) stateRef.gatewayProcessId = existing.id;
    console.log('[Gateway] gateway already healthy (health check), processId:', stateRef.gatewayProcessId);
    return;
  }

  // 3) Existing process might be starting
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  if (existingProcess) {
    console.log('[Gateway] Found existing process:', existingProcess.id, 'status:', existingProcess.status);
    try {
      await existingProcess.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
      stateRef.gatewayReady = true;
      stateRef.gatewayProcessId = existingProcess.id;
      stateRef.lastGatewayStartAttempt = Date.now();
      stateRef.lastHealthCheck = Date.now();
      console.log('[Gateway] gateway ready (existing process), processId:', existingProcess.id);
      return;
    } catch (e) {
      console.log('[Gateway] Existing process not reachable, killing and restarting:', e);
      try {
        await existingProcess.kill();
      } catch (killErr) {
        console.log('[Gateway] Kill failed:', killErr);
      }
    }
  }

  // 4) Mount R2 (do not start gateway here; only ensure mount for startup script)
  await mountR2Storage(sandbox, env);

  // 5) Start new gateway
  stateRef.lastGatewayStartAttempt = Date.now();
  console.log('[Gateway] Starting gateway...');
  const envVars = buildEnvVars(env);
  const command = '/usr/local/bin/start-moltbot.sh';

  let process: Process;
  try {
    process = await sandbox.startProcess(command, {
      env: Object.keys(envVars).length > 0 ? envVars : undefined,
    });
    stateRef.gatewayProcessId = process.id;
    console.log('[Gateway] Process started, id:', process.id, 'status:', process.status);
  } catch (startErr) {
    console.error('[Gateway] Failed to start process:', startErr);
    throw startErr;
  }

  try {
    await process.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
    stateRef.gatewayReady = true;
    stateRef.lastHealthCheck = Date.now();
    console.log('[Gateway] Gateway ready, processId:', process.id);
  } catch (e) {
    console.error('[Gateway] waitForPort failed:', e);
    try {
      const logs = await process.getLogs();
      console.error('[Gateway] Stderr:', logs.stderr);
      throw new Error(`Moltbot gateway failed to start. Stderr: ${logs.stderr || '(empty)'}`);
    } catch (logErr) {
      console.error('[Gateway] Failed to get logs:', logErr);
      throw e;
    }
  }
}

/**
 * Restart gateway: stop (graceful then force), clear lock files, wait for port free, start.
 * Caller must hold the same lock as ensureGatewayRunning.
 */
export async function restartGatewayLogic(
  sandbox: Sandbox,
  env: MoltbotEnv,
  stateRef: GatewayStateRef
): Promise<void> {
  console.log('[Gateway] Restarting gateway...');
  const processId = stateRef.gatewayProcessId;

  await stopGateway(sandbox, processId);
  stateRef.gatewayProcessId = null;
  stateRef.gatewayReady = false;

  await clearLockFiles(sandbox);
  await waitForPortFree(sandbox);

  await ensureGatewayRunningLogic(sandbox, env, stateRef);
  console.log('[Gateway] Restart complete, processId:', stateRef.gatewayProcessId);
}
