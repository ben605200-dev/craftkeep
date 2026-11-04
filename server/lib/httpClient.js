/**
 * HTTPS client used for every upstream call (Mojang, PaperMC, Fabric, Adoptium).
 *
 * Adds: timeouts, exponential-backoff retries on transient failures, an
 * in-memory TTL cache for metadata endpoints, streaming downloads with
 * progress callbacks, and SHA-1/SHA-256 verification.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { ensureDir } from './fsUtil.js';
import createLogger from '../logger.js';

const log = createLogger('http');

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

class HttpError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status ?? 502;
    this.url = url;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Very small TTL cache: `key -> { value, expires }`. */
const cache = new Map();

export function clearCache(prefix) {
  if (!prefix) return cache.clear();
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
}

/**
 * `fetch` with retries + timeout. Returns the raw `Response`.
 */
async function request(url, { method = 'GET', headers = {}, body, retries, signal, timeout } = {}) {
  const attempts = retries ?? config.httpRetries;
  let lastError;

  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout ?? config.httpTimeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(url, {
        method,
        headers: { 'user-agent': config.userAgent, accept: '*/*', ...headers },
        body,
        signal: controller.signal,
        redirect: 'follow',
      });

      if (response.ok) return response;

      // Non-retryable client errors bubble straight up.
      if (!RETRYABLE_STATUS.has(response.status)) {
        let text = '';
        try {
          text = (await response.text()).slice(0, 500);
        } catch {
          /* ignore */
        }
        throw new HttpError(`${method} ${url} failed with ${response.status}`, {
          status: response.status,
          url,
          body: text,
        });
      }

      lastError = new HttpError(`${method} ${url} failed with ${response.status}`, {
        status: response.status,
        url,
      });
    } catch (error) {
      if (error instanceof HttpError && error.status < 500 && error.status !== 408 && error.status !== 429) {
        throw error;
      }
      if (signal?.aborted) throw error;
      lastError = error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (attempt < attempts) {
      const backoff = Math.min(8000, 400 * 2 ** attempt) + Math.random() * 250;
      log.debug(`retry ${attempt + 1}/${attempts} for ${url} in ${Math.round(backoff)}ms`);
      await sleep(backoff);
    }
  }

  throw lastError instanceof HttpError
    ? lastError
    : new HttpError(`Network error contacting ${url}: ${lastError?.message ?? 'unknown'}`, { url });
}

/** GET + JSON parse, with optional TTL caching. */
export async function getJson(url, { cacheTtlMs = 0, ...options } = {}) {
  const key = `json:${url}`;
  if (cacheTtlMs > 0) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
  }
  const response = await request(url, { ...options, headers: { accept: 'application/json', ...options.headers } });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(`Invalid JSON from ${url}`, { status: 502, url, body: text.slice(0, 300) });
  }
  if (cacheTtlMs > 0) cache.set(key, { value: parsed, expires: Date.now() + cacheTtlMs });
  return parsed;
}

/** GET + text (used for checksum files and manifests). */
export async function getText(url, options = {}) {
  const response = await request(url, options);
  return response.text();
}

/**
 * Stream a URL to disk, reporting progress.
 *
 * @param {string} url
 * @param {string} destination
 * @param {{ onProgress?: (p: {received:number,total:number,percent:number,speedBps:number})=>void,
 *           expectedSha256?: string, expectedSha1?: string, signal?: AbortSignal }} [opts]
 */
export async function download(url, destination, opts = {}) {
  const { onProgress, expectedSha256, expectedSha1, signal } = opts;

  const response = await request(url, { signal, retries: 2 });
  const total = Number(response.headers.get('content-length') || 0);
  const hash256 = crypto.createHash('sha256');
  const hash1 = crypto.createHash('sha1');

  await ensureDir(path.dirname(destination));
  const tmp = `${destination}.part`;
  const handle = await fsp.open(tmp, 'w');

  let received = 0;
  const startedAt = Date.now();
  let lastEmit = 0;

  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      await handle.write(value);
      hash256.update(value);
      hash1.update(value);
      received += value.length;

      if (onProgress) {
        const now = Date.now();
        // Throttle UI updates to ~10/s.
        if (now - lastEmit >= 100 || received === total) {
          lastEmit = now;
          const elapsed = Math.max(1, now - startedAt) / 1000;
          onProgress({
            received,
            total,
            percent: total > 0 ? Math.min(100, (received / total) * 100) : 0,
            speedBps: received / elapsed,
          });
        }
      }
    }
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();

  const digest256 = hash256.digest('hex');
  const digest1 = hash1.digest('hex');

  if (expectedSha256 && expectedSha256.toLowerCase() !== digest256) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw new HttpError(`Checksum mismatch for ${path.basename(destination)} (SHA-256)`, {
      status: 502,
      url,
      body: `expected ${expectedSha256}, got ${digest256}`,
    });
  }
  if (expectedSha1 && expectedSha1.toLowerCase() !== digest1) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw new HttpError(`Checksum mismatch for ${path.basename(destination)} (SHA-1)`, {
      status: 502,
      url,
      body: `expected ${expectedSha1}, got ${digest1}`,
    });
  }

  await fsp.rm(destination, { force: true }).catch(() => {});
  await fsp.rename(tmp, destination);

  if (onProgress && total > 0) {
    onProgress({ received, total, percent: 100, speedBps: received / (Math.max(1, Date.now() - startedAt) / 1000) });
  }

  return { bytes: received, sha256: digest256, sha1: digest1, path: destination };
}

/**
 * Follow the common `<file>.sha256` / `.sha1` sidecar convention used by
 * PaperMC and Mojang. Returns `null` when the sidecar does not exist.
 */
export async function fetchChecksum(url, { algorithm = 'sha256' } = {}) {
  try {
    const text = await getText(url, { retries: 1, timeout: 10_000 });
    const match = text.match(/\b([a-f0-9]{40,64})\b/i);
    if (!match) return null;
    const value = match[1].toLowerCase();
    const wanted = algorithm === 'sha1' ? 40 : 64;
    return value.length === wanted ? value : null;
  } catch {
    return null;
  }
}

export { HttpError };
