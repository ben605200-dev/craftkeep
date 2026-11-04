/**
 * Shared Express middleware: request context, JSON-limit errors, auth, and
 * uniform error shaping.
 */

import crypto from 'node:crypto';
import { config } from '../config.js';
import createLogger from '../logger.js';

const log = createLogger('http');

/** Attach a request id + timing, and log slow/failed requests. */
export function requestContext(req, res, next) {
  req.id = crypto.randomUUID().slice(0, 8);
  req.startedAt = process.hrtime.bigint();
  res.setHeader('x-request-id', req.id);
  res.setHeader('x-content-type-options', 'nosniff');

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - req.startedAt) / 1e6;
    const level = res.statusCode >= 500 ? 'warn' : 'debug';
    if (res.statusCode >= 400 || ms > 2000) {
      log[level](`${req.method} ${req.originalUrl} -> ${res.statusCode} in ${ms.toFixed(0)}ms`);
    }
  });

  next();
}

/** Timing-safe string comparison, so a token cannot be probed byte by byte. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Transport gate.
 *
 * This API can start processes and write files, and it is reachable by anything
 * running on this machine — so three independent checks stand in front of it:
 *
 *   1. **Session token.** Generated fresh by the desktop shell on every launch
 *      and handed to the renderer through the preload bridge. Only the app's own
 *      window knows it. This is the check that makes the transport private: a
 *      browser pointed at the port gets 401 on every call.
 *   2. **Origin.** A browser always sends `Origin`; anything that is not us is
 *      rejected outright.
 *   3. **Custom header** on state-changing verbs. Forces a CORS preflight that
 *      is never answered, so a cross-site request cannot even be delivered.
 */
export function securityGate(req, res, next) {
  const provided = String(req.get('authorization') ?? '').replace(/^Bearer\s+/i, '') ||
    String(req.query.token ?? '');

  if (!safeEqual(provided, config.token)) {
    // Deliberately vague: do not confirm whether a token was merely wrong.
    return res.status(401).json({ error: 'Unauthorized.', code: 'unauthorized' });
  }

  const origin = req.headers.origin;
  if (origin) {
    let allowed = false;
    try {
      const parsed = new URL(origin);
      const host = String(req.headers.host ?? '');
      allowed =
        parsed.host === host ||
        ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      log.warn(`Blocked cross-origin ${req.method} ${req.originalUrl} from ${origin}`);
      return res.status(403).json({ error: 'Cross-origin requests are not allowed.', code: 'bad-origin' });
    }
  }

  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (mutating && req.get('x-requested-with') !== 'Craftkeep') {
    return res.status(400).json({
      error: 'Missing X-Requested-With header.',
      code: 'missing-header',
    });
  }

  next();
}

/**
 * API responses are never cacheable.
 *
 * Without this, a 404 from a mis-typed route is *heuristically cacheable* per
 * RFC 9111 — Chromium will happily serve it back on the next navigation and
 * the dashboard appears to be broken until a hard reload.
 */
export function noStore(req, res, next) {
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate');
  res.setHeader('pragma', 'no-cache');
  next();
}

/** Throw a 404 for unmatched /api routes instead of falling through to the SPA. */
export function apiNotFound(req, res) {
  res.setHeader('cache-control', 'no-store');
  res.status(404).json({ error: `No API route for ${req.method} ${req.originalUrl}`, code: 'not-found' });
}

/** Terminal error handler. Never leaks stack traces to the client. */
export function errorHandler(error, req, res, _next) {
  const status = Number(error?.status) || (error?.name === 'SyntaxError' ? 400 : 500);
  const payload = {
    error: error?.message ?? 'Something went wrong.',
    code: error?.code ?? (status >= 500 ? 'internal-error' : 'bad-request'),
  };
  if (error?.detail) payload.detail = error.detail;
  if (error?.hint) payload.hint = error.hint;
  if (error?.safetyCopy) payload.safetyCopy = error.safetyCopy;

  if (status >= 500) {
    log.error(`${req.method} ${req.originalUrl} failed: ${error?.stack ?? error?.message ?? error}`);
  }

  if (res.headersSent) return;
  res.setHeader('cache-control', 'no-store');
  res.status(status).json(payload);
}

/** Wrap an async handler so rejections reach `errorHandler`. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Validate + coerce a JSON body against a tiny declarative schema.
 * Keeps every route free of hand-rolled `typeof` checks.
 */
export function validateBody(schema) {
  return (req, res, next) => {
    const body = req.body ?? {};
    const out = {};
    const errors = [];

    for (const [key, rule] of Object.entries(schema)) {
      const raw = body[key];
      const optional = rule.optional !== false;

      if (raw === undefined || raw === null || raw === '') {
        if (!optional && rule.default === undefined) {
          errors.push(`${key} is required.`);
          continue;
        }
        if (rule.default !== undefined) out[key] = rule.default;
        continue;
      }

      switch (rule.type) {
        case 'string': {
          const value = String(raw).trim();
          if (rule.maxLength && value.length > rule.maxLength) {
            errors.push(`${key} must be at most ${rule.maxLength} characters.`);
            break;
          }
          if (rule.minLength && value.length < rule.minLength) {
            errors.push(`${key} must be at least ${rule.minLength} characters.`);
            break;
          }
          if (rule.pattern && !rule.pattern.test(value)) {
            errors.push(rule.message ?? `${key} has an invalid format.`);
            break;
          }
          if (rule.enum && !rule.enum.includes(value)) {
            errors.push(`${key} must be one of: ${rule.enum.join(', ')}.`);
            break;
          }
          out[key] = value;
          break;
        }
        case 'int': {
          const value = Number.parseInt(String(raw), 10);
          if (!Number.isFinite(value)) {
            errors.push(`${key} must be a whole number.`);
            break;
          }
          if (rule.min !== undefined && value < rule.min) {
            errors.push(`${key} must be at least ${rule.min}.`);
            break;
          }
          if (rule.max !== undefined && value > rule.max) {
            errors.push(`${key} must be at most ${rule.max}.`);
            break;
          }
          out[key] = value;
          break;
        }
        case 'number': {
          const value = Number(raw);
          if (!Number.isFinite(value)) {
            errors.push(`${key} must be a number.`);
            break;
          }
          out[key] = value;
          break;
        }
        case 'bool':
          out[key] = typeof raw === 'boolean' ? raw : ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
          break;
        case 'array':
          if (!Array.isArray(raw)) {
            errors.push(`${key} must be an array.`);
            break;
          }
          if (rule.maxItems && raw.length > rule.maxItems) {
            errors.push(`${key} may hold at most ${rule.maxItems} items.`);
            break;
          }
          out[key] = raw;
          break;
        case 'object':
          if (typeof raw !== 'object' || Array.isArray(raw)) {
            errors.push(`${key} must be an object.`);
            break;
          }
          out[key] = raw;
          break;
        default:
          out[key] = raw;
      }
    }

    if (errors.length) {
      return res.status(400).json({ error: errors[0], code: 'validation-failed', details: errors });
    }
    req.validated = out;
    next();
  };
}
