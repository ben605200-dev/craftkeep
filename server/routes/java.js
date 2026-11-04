/**
 * `/api/java` — JDK discovery, validation and Adoptium downloads.
 */

import express from 'express';
import { asyncHandler, validateBody } from './middleware.js';
import { detectJava, installJdk, inspectJava, findAdoptiumJdk, javaSummary } from '../lib/javaDetect.js';
import { pickJava } from '../lib/versionRules.js';
import { config } from '../config.js';

export function javaRoutes({ gateway } = {}) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    const force = req.query.refresh === 'true';
    const installations = await detectJava({ force });
    res.json({
      installations,
      majors: [...new Set(installations.map((i) => i.major))].sort((a, b) => a - b),
      managedDir: config.jdkDir,
      autoDownloadEnabled: config.autoDownloadJava,
    });
  }));

  router.get('/summary', asyncHandler(async (req, res) => res.json(await javaSummary())));

  /** Validate a path the user typed in manually. */
  router.post('/inspect', validateBody({
    path: { type: 'string', minLength: 1, maxLength: 500, optional: false },
  }), asyncHandler(async (req, res) => {
    res.json(await inspectJava(req.validated.path));
  }));

  /**
   * Which installed JDK would be chosen for a given Minecraft version?
   * Powers the "auto" badge in the create wizard.
   */
  router.post('/select', validateBody({
    mcVersion: { type: 'string', maxLength: 40 },
    requiredMajor: { type: 'int', min: 8, max: 40 },
  }), asyncHandler(async (req, res) => {
    let required = req.validated.requiredMajor;
    if (!required && req.validated.mcVersion) {
      const { resolveJavaRequirement } = await import('../providers/index.js');
      required = (await resolveJavaRequirement(req.validated.mcVersion)).java;
    }
    required = required ?? 21;

    const installations = await detectJava();
    const match = pickJava(installations, required);
    res.json({
      requiredMajor: required,
      selected: match.java,
      reason: match.reason,
      compatible: Boolean(match.java) && match.java.major >= required,
      installations,
    });
  }));

  /** What would Adoptium give us for this feature release? (no download) */
  router.get('/adoptium/:feature', asyncHandler(async (req, res) => {
    const feature = Number.parseInt(req.params.feature, 10);
    if (!Number.isFinite(feature) || feature < 8 || feature > 40) {
      return res.status(400).json({ error: 'Feature version must be between 8 and 40.', code: 'bad-feature' });
    }
    const build = await findAdoptiumJdk(feature);
    res.json({ feature, ...build, installed: false });
  }));

  /**
   * Download + install a JDK. Emits WebSocket `java-download` progress frames
   * so the Settings panel can render a progress bar.
   */
  router.post('/install', validateBody({
    feature: { type: 'int', min: 8, max: 40, optional: false },
    jobId: { type: 'string', maxLength: 64 },
  }), asyncHandler(async (req, res) => {
    const { feature, jobId } = req.validated;

    const onProgress = (progress) => {
      gateway?.broadcastJob({
        jobId: jobId ?? `java-${feature}`,
        kind: 'java-download',
        step: 'download',
        message: `Downloading Java ${feature}…`,
        percent: Math.round(progress.percent ?? 0),
        detail: progress.total
          ? `${(progress.received / 1024 / 1024).toFixed(0)} / ${(progress.total / 1024 / 1024).toFixed(0)} MiB`
          : `${(progress.received / 1024 / 1024).toFixed(0)} MiB`,
      });
    };

    const info = await installJdk(feature, { onProgress });
    gateway?.jobDone(jobId ?? `java-${feature}`, { result: { java: info } });
    res.status(201).json({ ok: true, java: info });
  }));

  return router;
}

export default javaRoutes;
