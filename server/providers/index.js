/**
 * Provider registry + the "what Java does this need?" resolver.
 *
 * `resolveJavaRequirement` is the important bit: Paper and Fabric do not
 * publish a Java version, so we cross-reference Mojang's manifest (which does)
 * and fall back to the static table only when Mojang is unreachable.
 */

import vanilla from './vanilla.js';
import paper from './paper.js';
import fabric from './fabric.js';
import { requiredJavaFor } from '../lib/versionRules.js';
import createLogger from '../logger.js';

const log = createLogger('providers');

export const PROVIDERS = { vanilla, paper, fabric };

export const PLATFORM_INFO = [
  {
    id: 'vanilla',
    label: 'Vanilla',
    tagline: 'The real thing — zero plugins, zero mods, 100% Mojang.',
    description:
      'Official Mojang server jar. Best for small groups that want the exact vanilla experience, redstone parity and the widest mod-free compatibility.',
    accent: 'emerald',
    icon: 'cube',
    supportsPlugins: false,
    supportsMods: false,
    recommendedHeapMb: 3072,
    minPlayers: 1,
  },
  {
    id: 'paper',
    label: 'Paper',
    tagline: 'Drop-in performance upgrade with full plugin support.',
    description:
      'A high-performance fork of Spigot. Same world data, dramatically better tick times, and access to the entire Bukkit/Spigot/Paper plugin ecosystem.',
    accent: 'indigo',
    icon: 'bolt',
    supportsPlugins: true,
    supportsMods: false,
    recommendedHeapMb: 4096,
    minPlayers: 1,
  },
  {
    id: 'fabric',
    label: 'Fabric',
    tagline: 'Lightweight mod loader built for modern versions.',
    description:
      'The most popular mod loader for current Minecraft. Ideal for server-side optimisation mods (Lithium, FerriteCore) or a fully modded experience.',
    accent: 'violet',
    icon: 'puzzle',
    supportsPlugins: false,
    supportsMods: true,
    recommendedHeapMb: 4096,
    minPlayers: 1,
  },
];

const planLabel = (id) => PLATFORM_INFO.find((p) => p.id === id)?.label ?? id;

export function getProvider(platform) {
  const provider = PROVIDERS[String(platform ?? '').toLowerCase()];
  if (!provider) {
    const error = new Error(`Unknown platform "${platform}". Expected one of: vanilla, paper, fabric.`);
    error.status = 400;
    throw error;
  }
  return provider;
}

/**
 * Available Minecraft versions for a platform.
 * @param {string} platform
 * @param {{ includeSnapshots?: boolean }} [opts]
 */
export async function listVersions(platform, opts = {}) {
  const provider = getProvider(platform);
  const result = await provider.listVersions(opts);
  return { ...result, platform: provider.id, label: provider.label ?? provider.id };
}

/**
 * Builds / loaders for a version — only meaningful for Paper and Fabric.
 */
export async function listBuilds(platform, version, opts = {}) {
  const provider = getProvider(platform);
  if (provider.id === 'paper') return { platform: 'paper', builds: await provider.listBuilds(version, opts) };
  if (provider.id === 'fabric') return { platform: 'fabric', ...(await provider.listLoaders({ gameVersion: version })) };
  return { platform: 'vanilla', builds: [] };
}

/**
 * Figure out which Java major version a Minecraft version needs, preferring
 * Mojang's own metadata over our static table.
 *
 * @param {string} mcVersion
 * @returns {Promise<{ java:number, source:string, note:string, manifestJava:number|null, component:string|null }>}
 */
export async function resolveJavaRequirement(mcVersion) {
  let manifestJava = null;
  let component = null;

  try {
    const details = await vanilla.getVersionDetails(mcVersion);
    manifestJava = details.javaVersion?.majorVersion ?? null;
    component = details.javaVersion?.component ?? null;
  } catch (error) {
    log.debug(`Could not read Mojang metadata for ${mcVersion}: ${error.message}`);
  }

  const resolved = requiredJavaFor(mcVersion, { manifestJava });
  return { ...resolved, manifestJava, component };
}

/**
 * Full download plan for a server: artefact + Java requirement, in one call.
 *
 * @param {{ platform:string, version:string, build?:number|'latest', loader?:string, installer?:string }} spec
 */
export async function planDownload(spec) {
  const provider = getProvider(spec.platform);
  const [artefact, java] = await Promise.all([
    provider.resolveDownload(spec.version, { build: spec.build, loader: spec.loader, installer: spec.installer }),
    resolveJavaRequirement(spec.version),
  ]);

  // Satisfy *every* constraint: Mojang's manifest, the server software's own
  // minimum (Paper publishes one per version) and our fallback table. Taking the
  // max is the only safe combination — any of them can be the strictest.
  const candidates = [
    { value: java.manifestJava, source: 'manifest' },
    { value: artefact.javaMajor, source: `${provider.id}-api` },
    { value: java.java, source: 'table' },
  ].filter((entry) => Number.isFinite(entry.value) && entry.value > 0);

  const strictest = candidates.reduce((best, entry) => (entry.value > best.value ? entry : best), candidates[0]);
  const javaMajor = strictest?.value ?? 21;

  const javaSource = java.manifestJava ? 'manifest' : strictest?.source ?? 'default';
  const javaNote = java.manifestJava
    ? java.note
    : strictest && strictest.source !== 'table'
      ? `${planLabel(provider.id)} ${spec.version} requires Java ${javaMajor}.`
      : java.note;

  return {
    ...artefact,
    javaMajor,
    javaSource,
    javaNote,
    javaComponent: java.component,
    /** PaperMC publishes its own tuned flag set; surfaced for display. */
    recommendedFlags: artefact.recommendedFlags ?? null,
    platformLabel: planLabel(provider.id),
  };
}

export default { PROVIDERS, PLATFORM_INFO, getProvider, listVersions, listBuilds, resolveJavaRequirement, planDownload };
