/**
 * Vanilla provider — Mojang's official version manifest + piston-data.
 *
 * Docs: https://minecraft.wiki/w/Version_manifest.json
 * The per-version JSON is the single source of truth for both the server jar
 * URL and its SHA-1 and — importantly — the required Java major version.
 */

import { getJson } from '../lib/httpClient.js';
import { config } from '../config.js';
import { isSnapshot, isPreRelease, isModernVersion } from '../lib/versionRules.js';

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const CACHE_KEY = 'vanilla:manifest';

/** Fetch (and cache) the version manifest. */
async function manifest() {
  const data = await getJson(MANIFEST_URL, { cacheTtlMs: config.versionCacheTtlMs });
  if (!Array.isArray(data?.versions)) throw new Error('Mojang version manifest was malformed.');
  return data;
}

const decorate = (entry) => ({
  id: entry.id,
  type: entry.type, // release | snapshot | old_beta | old_alpha
  releaseTime: entry.releaseTime,
  stable: entry.type === 'release' && !isSnapshot(entry.id) && !isPreRelease(entry.id),
  snapshot: entry.type === 'snapshot' || isSnapshot(entry.id),
  modern: isModernVersion(entry.id),
});

/**
 * @param {{ includeSnapshots?: boolean, limit?: number }} [opts]
 */
export async function listVersions({ includeSnapshots = false, limit = 400 } = {}) {
  const data = await manifest();
  const filtered = data.versions
    .filter((v) => (includeSnapshots ? v.type !== 'old_alpha' && v.type !== 'old_beta' : v.type === 'release'))
    .slice(0, limit)
    .map(decorate);

  return {
    platform: 'vanilla',
    latest: { release: data.latest?.release ?? null, snapshot: data.latest?.snapshot ?? null },
    versions: filtered,
  };
}

/** Full metadata for one version: downloads, Java requirement, asset index. */
export async function getVersionDetails(version) {
  const data = await manifest();
  const entry = data.versions.find((v) => v.id === version);
  if (!entry) {
    const error = new Error(`Minecraft version "${version}" is not in Mojang's manifest.`);
    error.status = 404;
    throw error;
  }
  const details = await getJson(entry.url, { cacheTtlMs: config.versionCacheTtlMs * 6 });
  return {
    ...decorate(entry),
    javaVersion: details.javaVersion ?? null,
    mainClass: details.mainClass ?? null,
    downloads: details.downloads ?? {},
    assetIndex: details.assetIndex ?? null,
    complianceLevel: details.complianceLevel ?? null,
  };
}

/** Absolute URL of the server jar for a version. */
export async function resolveDownload(version) {
  const details = await getVersionDetails(version);
  const server = details.downloads?.server;
  if (!server?.url) {
    const error = new Error(
      `Minecraft ${version} does not ship a downloadable server jar. Versions before ` +
        '1.2.5 use the legacy minecraft_server.jar format, which is not supported for one-click provisioning.',
    );
    error.status = 422;
    throw error;
  }
  return {
    platform: 'vanilla',
    version,
    url: server.url,
    filename: `minecraft-server-${version}.jar`,
    sha1: server.sha1 ?? null,
    sha256: null,
    size: server.size ?? 0,
    javaMajor: details.javaVersion?.majorVersion ?? null,
    component: details.javaVersion?.component ?? null,
    build: null,
    notes: `Official Mojang server jar for ${version}.`,
  };
}

/** Vanilla has no loader concept, but the interface stays uniform. */
export async function listLoaders() {
  return [];
}

export default { listVersions, getVersionDetails, resolveDownload, listLoaders, id: 'vanilla', label: 'Vanilla' };
