/**
 * Paper provider.
 *
 * PaperMC retired the v2 REST API (`api.papermc.io/v2` now answers 410 Gone for
 * everything) in favour of the "Fill" API at `fill.papermc.io/v3`. We target v3
 * and keep a thin v2 fallback for anyone running this against a mirror.
 *
 * v3 shape (verified live):
 *   GET /v3/projects/paper
 *     { project: { id, name },
 *       versions: { "1.21": ["1.21.11", "1.21.10", ...], "1.20": [...] } }
 *
 *   GET /v3/projects/paper/versions/1.21.8
 *     { version: { id, support: { status, end },
 *                  java: { version: { minimum: 21 },
 *                          flags: { recommended: ["-XX:+UseG1GC", ...] } } },
 *       builds: [60, 59, ...] }
 *
 *   GET /v3/projects/paper/versions/1.21.8/builds
 *     [ { id, time, channel: "STABLE",
 *         downloads: { "server:default": { name, size, url, checksums: { sha256 } } } } ]
 *
 * Two things worth calling out: PaperMC publishes the **minimum Java version
 * per Minecraft version**, which is more precise than our fallback table, and a
 * **recommended JVM flag set**, which we surface to the user instead of guessing.
 */

import { getJson } from '../lib/httpClient.js';
import { config } from '../config.js';
import { parseVersion, isPreRelease, isModernVersion } from '../lib/versionRules.js';

const V3 = 'https://fill.papermc.io/v3';
const V2 = 'https://api.papermc.io/v2';

/** `'v3' | 'v2' | null` — probed once, then reused. */
let apiGeneration = null;

const v3 = (path) => getJson(`${V3}${path}`, { cacheTtlMs: config.versionCacheTtlMs, headers: { accept: 'application/json' } });
const v2 = (path) => getJson(`${V2}${path}`, { cacheTtlMs: config.versionCacheTtlMs });

/** Normalise PaperMC's channel casing for internal use. */
const normaliseChannel = (channel) => String(channel ?? 'stable').toLowerCase();

/** Flatten v3's `{ "1.21": ["1.21.11", ...] }` grouping into a single list. */
function flattenVersionGroups(versions) {
  if (Array.isArray(versions)) return versions;
  if (!versions || typeof versions !== 'object') return [];
  return Object.values(versions).flat().filter((v) => typeof v === 'string');
}

async function fetchVersionIndex(project) {
  if (apiGeneration === 'v2') {
    const data = await v2(`/projects/${project}`);
    return { versions: Array.isArray(data?.versions) ? data.versions : [], generation: 'v2' };
  }

  try {
    const data = await v3(`/projects/${project}`);
    apiGeneration = 'v3';
    return { versions: flattenVersionGroups(data?.versions), generation: 'v3' };
  } catch (error) {
    // A mirror or an older deployment may still speak v2.
    const data = await v2(`/projects/${project}`);
    apiGeneration = 'v2';
    return { versions: Array.isArray(data?.versions) ? data.versions : [], generation: 'v2' };
  }
}

/**
 * @param {{ includeSnapshots?: boolean, project?: string }} [opts]
 */
export async function listVersions({ includeSnapshots = false, project = 'paper' } = {}) {
  const { versions, generation } = await fetchVersionIndex(project);

  const decorated = versions
    .map((id) => ({
      id,
      type: parseVersion(id) ? (isPreRelease(id) ? 'pre-release' : 'release') : 'snapshot',
      snapshot: !parseVersion(id) || isPreRelease(id),
      modern: isModernVersion(id),
      stable: parseVersion(id) ? !isPreRelease(id) : false,
    }))
    .filter((v) => (includeSnapshots ? true : v.stable))
    .sort((a, b) => {
      const pa = parseVersion(a.id);
      const pb = parseVersion(b.id);
      if (pa && pb) {
        for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pb[i] - pa[i];
        return 0;
      }
      if (pa) return -1;
      if (pb) return 1;
      return String(b.id).localeCompare(String(a.id), undefined, { numeric: true });
    });

  return {
    platform: 'paper',
    project,
    latest: { release: decorated[0]?.id ?? null, snapshot: decorated.find((v) => v.snapshot)?.id ?? null },
    versions: decorated,
    api: generation,
  };
}

/**
 * Per-version metadata: PaperMC's own minimum Java plus its recommended flags.
 * Cached aggressively — this never changes for a released version.
 */
export async function getVersionInfo(version, { project = 'paper' } = {}) {
  const data = await v3(`/projects/${project}/versions/${encodeURIComponent(version)}`);
  const info = data?.version ?? {};
  return {
    id: info.id ?? version,
    supported: info.support?.status === 'SUPPORTED' || info.support?.status === 'ACTIVE',
    supportStatus: info.support?.status ?? null,
    supportEnds: info.support?.end ?? null,
    /** Authoritative minimum Java for this Minecraft version, per PaperMC. */
    javaMinimum: info.java?.version?.minimum ?? null,
    /** PaperMC's tuned JVM flags — genuinely better than a generic preset. */
    recommendedFlags: Array.isArray(info.java?.flags?.recommended) ? info.java.flags.recommended : null,
    buildIds: Array.isArray(data?.builds) ? data.builds : [],
  };
}

/**
 * All builds for a version, newest first.
 * @returns {Promise<Array<{ build:number, time:string, channel:string, downloads:object }>>}
 */
export async function listBuilds(version, { project = 'paper' } = {}) {
  const encoded = encodeURIComponent(version);

  if (apiGeneration === 'v2') return listBuildsV2(version, project);

  try {
    const data = await v3(`/projects/${project}/versions/${encoded}/builds`);
    const rows = Array.isArray(data) ? data : Array.isArray(data?.builds) ? data.builds : [];
    if (!rows.length) throw new Error(`Paper has no builds published for Minecraft ${version}.`);

    return rows
      .map((row) => ({
        build: row.id ?? row.build,
        time: row.time ?? null,
        channel: normaliseChannel(row.channel),
        downloads: {
          application:
            row.downloads?.['server:default'] ??
            row.downloads?.application ??
            Object.values(row.downloads ?? {})[0] ??
            null,
        },
        commits: row.commits ?? null,
      }))
      // Highest build number first.
      .sort((a, b) => Number(b.build) - Number(a.build));
  } catch (error) {
    if (apiGeneration === 'v3' && /410|404/.test(String(error.status ?? ''))) {
      apiGeneration = 'v2';
      return listBuildsV2(version, project);
    }
    throw error;
  }
}

async function listBuildsV2(version, project) {
  const data = await v2(`/projects/${project}/versions/${encodeURIComponent(version)}/builds`);
  if (!Array.isArray(data?.builds)) throw new Error(`No Paper builds found for ${version}.`);
  return [...data.builds]
    .map((b) => ({ build: b.build, time: b.time, channel: normaliseChannel(b.channel), downloads: b.downloads }))
    .sort((a, b) => Number(b.build) - Number(a.build));
}

/**
 * Resolve the best build for a version into a downloadable jar.
 *
 * Channel preference: RECOMMENDED → STABLE → anything newest. PaperMC marks a
 * build RECOMMENDED once it has soaked, so preferring it avoids shipping a
 * fresh regression to the user.
 *
 * @param {string} version
 * @param {{ build?: number|'latest'|'recommended', project?: string }} [opts]
 */
export async function resolveDownload(version, { build = 'latest', project = 'paper' } = {}) {
  const [builds, info] = await Promise.all([
    listBuilds(version, { project }),
    getVersionInfo(version, { project }).catch(() => null),
  ]);

  if (!builds.length) {
    const error = new Error(`Paper has no builds published for Minecraft ${version}.`);
    error.status = 404;
    throw error;
  }

  let chosen;
  if (build === 'latest' || build === undefined || build === null || build === 'recommended') {
    chosen =
      builds.find((b) => b.channel === 'recommended') ??
      builds.find((b) => b.channel === 'stable') ??
      builds.find((b) => b.channel !== 'alpha' && b.channel !== 'experimental') ??
      builds[0];
  } else {
    const wanted = Number(build);
    chosen = builds.find((b) => Number(b.build) === wanted);
    if (!chosen) {
      const error = new Error(`Paper build ${build} does not exist for Minecraft ${version}.`);
      error.status = 404;
      throw error;
    }
  }

  const application = chosen.downloads?.application ?? chosen.downloads?.['server:default'];
  if (!application) {
    const error = new Error(`Paper build ${chosen.build} for ${version} has no downloadable artefact.`);
    error.status = 502;
    throw error;
  }

  const filename = application.name ?? `paper-${version}-${chosen.build}.jar`;
  const url =
    application.url ??
    `${V2}/projects/${project}/versions/${encodeURIComponent(version)}/builds/${chosen.build}/downloads/${filename}`;

  return {
    platform: 'paper',
    project,
    version,
    build: chosen.build,
    channel: chosen.channel,
    buildTime: chosen.time ?? null,
    url,
    filename,
    // v3 embeds the digest; v2 only offers a `.sha256` sidecar.
    sha256: application.checksums?.sha256 ?? application.sha256 ?? null,
    sha1: null,
    size: application.size ?? 0,
    javaMajor: info?.javaMinimum ?? null,
    recommendedFlags: info?.recommendedFlags ?? null,
    supportStatus: info?.supportStatus ?? null,
    supportEnds: info?.supportEnds ?? null,
    notes:
      `Paper ${version} build ${chosen.build}` +
      (chosen.channel && chosen.channel !== 'stable' ? ` (${chosen.channel})` : '') +
      (info?.supportStatus && info.supportStatus !== 'SUPPORTED' ? ` — Paper no longer supports ${version}` : ''),
  };
}

export default { listVersions, listBuilds, getVersionInfo, resolveDownload, id: 'paper', label: 'Paper' };
