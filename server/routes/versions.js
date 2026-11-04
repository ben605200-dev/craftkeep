/**
 * `/api/versions` — platform catalogue, version lists, build/loader lists and
 * provisioning preflight metadata.
 *
 * These endpoints fan out to Mojang / PaperMC / Fabric, so responses are TTL
 * cached upstream and failures are reported with enough context to render a
 * useful "we couldn't reach PaperMC" state instead of a blank dropdown.
 */

import express from 'express';
import { asyncHandler, validateBody } from './middleware.js';
import { PLATFORM_INFO, listVersions, listBuilds, resolveJavaRequirement, planDownload } from '../providers/index.js';
import { RESOURCE_PRESETS, planResources, JAVA_REQUIREMENTS, requiredJavaFor } from '../lib/versionRules.js';
import { javaSummary } from '../lib/javaDetect.js';
import { totalRamMb, systemInfo } from '../lib/stats.js';
import { config } from '../config.js';
import { clearCache } from '../lib/httpClient.js';

export function versionRoutes() {
  const router = express.Router();

  /** Static catalogue: platforms, presets, Java table, machine capability. */
  router.get('/platforms', asyncHandler(async (req, res) => {
    const java = await javaSummary().catch(() => ({ installations: [], majors: [] }));
    res.json({
      platforms: PLATFORM_INFO,
      presets: RESOURCE_PRESETS,
      javaRequirements: JAVA_REQUIREMENTS.map((r) => ({ min: r.min.join('.'), java: r.java, note: r.note })),
      java: { installations: java.installations, majors: java.majors, canRun: java.canRun },
      system: { ...systemInfo(), reservedRamMb: config.reservedRamMb, maxHeapMb: config.maxHeapMbOverride || null },
      recommendedHeapMb: planResources({
        javaMajor: java.majors?.includes(21) ? 21 : 17,
        systemRamMb: totalRamMb(),
        reservedMb: config.reservedRamMb,
        maxOverrideMb: config.maxHeapMbOverride,
      }).maxHeapMb,
    });
  }));

  /**
   * `GET /api/versions/:platform?snapshots=true`
   * `GET /api/versions/:platform/:version/builds`
   */
  router.get('/:platform', asyncHandler(async (req, res) => {
    const includeSnapshots = req.query.snapshots === 'true';
    const result = await listVersions(req.params.platform, { includeSnapshots });

    /*
     * Annotate each version with the Java it needs.
     *
     * This MUST use the local rule table, not `resolveJavaRequirement`: the
     * authoritative answer comes from Mojang's per-version metadata documents,
     * and fetching 60 of those to populate a dropdown took tens of seconds on a
     * cold cache and blocked the first paint of the whole dashboard.
     *
     * The exact answer is still resolved — by `planDownload` — for the single
     * version the user actually selects, both in the wizard's review step and
     * during provisioning. So browsing is instant and installing stays
     * authoritative.
     */
    const annotated = result.versions.map((version) => {
      const rule = requiredJavaFor(version.id);
      return { ...version, java: rule.java, javaSource: rule.source, javaNote: rule.note };
    });

    res.json({ ...result, versions: annotated });
  }));

  router.get('/:platform/:version/builds', asyncHandler(async (req, res) => {
    const result = await listBuilds(req.params.platform, req.params.version, {
      project: req.query.project,
    });
    const requirement = await resolveJavaRequirement(req.params.version).catch(() => null);
    res.json({ ...result, javaRequirement: requirement });
  }));

  /** Full download plan without touching the disk. */
  router.post('/plan', validateBody({
    platform: { type: 'string', enum: ['vanilla', 'paper', 'fabric'] },
    version: { type: 'string', minLength: 1, maxLength: 40 },
    build: {},
    loader: { type: 'string', maxLength: 40 },
    installer: { type: 'string', maxLength: 40 },
  }), asyncHandler(async (req, res) => {
    const plan = await planDownload(req.validated);
    const java = await javaSummary().catch(() => ({ installations: [] }));
    res.json({ plan, java: { installations: java.installations, majors: java.majors } });
  }));

  /** Drop the upstream metadata cache (the dashboard's "refresh versions" button). */
  router.post('/refresh', (req, res) => {
    clearCache();
    res.json({ ok: true, clearedAt: Date.now() });
  });

  return router;
}

export default versionRoutes;
