/**
 * `/api/tunnel` — the playit.gg agent.
 *
 * Global rather than per-server: one agent serves every tunnel on the machine,
 * and the tunnels themselves are configured in your playit.gg account pointing
 * at whatever local port you choose.
 */

import express from 'express';
import { asyncHandler, validateBody } from './middleware.js';

/**
 * @param {{ tunnel: import('../lib/tunnel.js').PlayitTunnel, gateway: object }} deps
 */
export function tunnelRoutes({ tunnel, gateway }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json({ ...tunnel.snapshot(), signer: 'Developed Methods LLC' });
  });

  /** Download and verify the agent binary. */
  router.post('/install', asyncHandler(async (req, res) => {
    const result = await tunnel.ensureAgent();
    res.json({ ok: true, path: result, ...tunnel.snapshot() });
  }));

  /**
   * Start claiming. Returns the URL the user approves in their browser plus the
   * code; the exchange runs in the background and announces itself over the
   * WebSocket when it succeeds.
   */
  router.post('/claim', validateBody({
    name: { type: 'string', maxLength: 40 },
  }), asyncHandler(async (req, res) => {
    const claim = await tunnel.beginClaim({ name: req.validated.name ?? 'Craftkeep' });
    res.status(202).json({ ok: true, ...claim, snapshot: tunnel.snapshot() });
  }));

  router.post('/claim/cancel', (req, res) => {
    tunnel.cancelClaim();
    res.json({ ok: true, ...tunnel.snapshot() });
  });

  /** Alternative to the claim flow: a secret generated on the playit dashboard. */
  router.post('/secret', validateBody({
    secret: { type: 'string', minLength: 20, maxLength: 200, optional: false },
  }), asyncHandler(async (req, res) => {
    await tunnel.useSecret(req.validated.secret);
    res.json({ ok: true, ...tunnel.snapshot() });
  }));

  router.post('/start', asyncHandler(async (req, res) => {
    await tunnel.start();
    res.json({ ok: true, ...tunnel.snapshot() });
  }));

  router.post('/stop', asyncHandler(async (req, res) => {
    await tunnel.stop();
    res.json({ ok: true, ...tunnel.snapshot() });
  }));

  /** Remove the stored secret so the agent can be claimed to another account. */
  router.post('/forget', asyncHandler(async (req, res) => {
    await tunnel.stop();
    await tunnel.forgetSecret();
    res.json({ ok: true, ...tunnel.snapshot() });
  }));

  router.get('/log', (req, res) => {
    res.json({ lines: tunnel.snapshot().logTail, publicAddress: tunnel.publicAddress });
  });

  // Fan agent output out to any connected window.
  tunnel.on('log', (text) => gateway?.broadcast({ type: 'tunnel-log', text }));
  tunnel.on('update', (snapshot) => gateway?.broadcast({ type: 'tunnel-status', tunnel: snapshot }));
  tunnel.on('claimed', () => gateway?.broadcast({ type: 'tunnel-claimed' }));
  tunnel.on('address', (address) => gateway?.broadcast({ type: 'tunnel-address', address }));

  return router;
}

export default tunnelRoutes;
