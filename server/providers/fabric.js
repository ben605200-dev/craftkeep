/**
 * Fabric provider — meta.fabricmc.net.
 *
 * Instead of running the graphical installer we download the *server launcher*
 * that Fabric Meta publishes:
 *
 *   /v2/versions/loader/{game}/{loader}/{installer}/server/jar
 *
 * That jar is self-contained: it bootstraps the loader and downloads the
 * matching Vanilla jar on first launch. No installer step, no user interaction,
 * and it stays valid when a server is moved to another machine.
 */

import { getJson } from '../lib/httpClient.js';
import { config } from '../config.js';
import { isModernVersion } from '../lib/versionRules.js';

// meta.fabricmc.net sits behind Cloudflare; give it a browser-ish UA.
const META = 'https://meta.fabricmc.net/v2';
const HEADERS = { accept: 'application/json' };

const get = (url) => getJson(url, { headers: HEADERS, cacheTtlMs: config.versionCacheTtlMs });

/**
 * @param {{ includeSnapshots?: boolean }} [opts]
 */
export async function listVersions({ includeSnapshots = false } = {}) {
  const raw = await get(`${META}/versions/game`);

  const versions = raw
    .filter((v) => (includeSnapshots ? true : v.stable))
    .map((v) => ({
      id: v.version,
      type: v.stable ? 'release' : 'snapshot',
      stable: Boolean(v.stable),
      snapshot: !v.stable,
      modern: isModernVersion(v.version),
    }));

  return {
    platform: 'fabric',
    latest: { release: versions.find((v) => v.stable)?.id ?? versions[0]?.id ?? null, snapshot: versions.find((v) => v.snapshot)?.id ?? null },
    versions,
  };
}

/** Loader versions, newest first, with the newest marked stable. */
export async function listLoaders({ gameVersion } = {}) {
  const [loaders, installers] = await Promise.all([
    get(`${META}/versions/loader`),
    get(`${META}/versions/installer`).catch(() => []),
  ]);

  const installerVersion = (installers.find((i) => i.stable) ?? installers[0])?.version ?? null;

  return {
    platform: 'fabric',
    installerVersion,
    loaders: loaders.map((l) => ({
      id: l.version,
      stable: Boolean(l.stable),
      // Fabric ships the loader's supported game range, which we surface as a hint.
      gameHint: gameVersion ? null : undefined,
      separator: l.separator ?? null,
      build: l.build ?? null,
      maven: l.maven ?? null,
    })),
  };
}

/** Convenience: newest stable loader + newest installer. */
export async function latestLoader() {
  const { loaders, installerVersion } = await listLoaders();
  return {
    loader: (loaders.find((l) => l.stable) ?? loaders[0])?.id ?? null,
    installer: installerVersion,
  };
}

/**
 * Resolve the Fabric server launcher jar.
 * @param {string} version Minecraft version
 * @param {{ loader?: string, installer?: string }} [opts]
 */
export async function resolveDownload(version, { loader = null, installer = null } = {}) {
  const defaults = await latestLoader();
  const loaderVersion = loader || defaults.loader;
  const installerVersion = installer || defaults.installer;

  if (!loaderVersion) {
    const error = new Error('Fabric has no loader versions published right now.');
    error.status = 502;
    throw error;
  }
  if (!installerVersion) {
    const error = new Error('Fabric has no installer versions published right now.');
    error.status = 502;
    throw error;
  }

  // Fabric Meta publishes no checksum for these jar endpoints, so integrity is
  // assured by TLS + the fact that the launcher re-verifies the MC jar itself.
  const url = `${META}/versions/loader/${encodeURIComponent(version)}/${encodeURIComponent(loaderVersion)}/${encodeURIComponent(installerVersion)}/server/jar`;

  return {
    platform: 'fabric',
    version,
    loader: loaderVersion,
    installer: installerVersion,
    url,
    filename: `fabric-server-mc${version}-loader${loaderVersion}-launcher${installerVersion}.jar`,
    sha1: null,
    sha256: null,
    size: 0,
    javaMajor: null,
    notes: `Fabric Loader ${loaderVersion} for Minecraft ${version}. The launcher jar fetches the matching Vanilla server jar on first start.`,
  };
}

/** Mod channels worth surfacing in the create wizard. */
export const FABRIC_INSTALL_HINTS = [
  { id: 'fabric-api', name: 'Fabric API', url: 'https://modrinth.com/mod/fabric-api', required: true },
  { id: 'lithium', name: 'Lithium', url: 'https://modrinth.com/mod/lithium', note: 'Server-side performance' },
  { id: 'ferritecore', name: 'FerriteCore', url: 'https://modrinth.com/mod/ferrite-core', note: 'Cuts RAM usage' },
  { id: 'c2me', name: 'C2ME', url: 'https://modrinth.com/mod/c2me-fabric', note: 'Parallel chunk generation' },
];

export default { listVersions, listLoaders, latestLoader, resolveDownload, id: 'fabric', label: 'Fabric' };
