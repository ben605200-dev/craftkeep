/**
 * Inline SVG icon set.
 *
 * Feather/Lucide-style 24×24 stroke geometry, rendered from a single map so
 * there is no sprite sheet to fetch and no icon font to flash on load.
 * `currentColor` + `1.7` stroke keeps every icon consistent at any size.
 */

const PATHS = {
  // -- Navigation ---------------------------------------------------------
  gauge: '<path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/><path d="m13.4 10.6 3.6-3.6"/><path d="M3.5 18a9 9 0 1 1 17 0"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.4-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  chevronLeft: '<path d="m15 6-6 6 6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronUp: '<path d="m6 15 6-6 6 6"/>',
  arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  arrowRight: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="m5 13 4 4L19 7"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
  alert: '<path d="M12 3.5 2.6 19.5h18.8Z"/><path d="M12 10v4M12 17h.01"/>',
  alertCircle: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.2 2.4c-.5.2-.7.6-.7 1.1v.5M12 16.5h.01"/>',

  // -- Power / lifecycle --------------------------------------------------
  play: '<path d="M7 4.5v15l13-7.5z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  power: '<path d="M12 3v9"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  restart: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  zap: '<path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13z"/>',
  skull: '<circle cx="12" cy="11" r="8"/><path d="M9 20v-2M15 20v-2M9.5 10h.01M14.5 10h.01"/><path d="m11 14 .9 1.4h.2l.9-1.4"/>',
  activity: '<path d="M3 12h4l2.5-7 4 14L16 12h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.4 2"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4.3l3 1.8"/>',

  // -- Platform / content -------------------------------------------------
  cube: '<path d="m12 3 8.5 4.9v9.8L12 22.6 3.5 17.7V7.9z"/><path d="m3.5 7.9 8.5 4.9 8.5-4.9M12 12.8v9.8"/>',
  bolt: '<path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13z"/>',
  puzzle: '<path d="M10 3.5a2 2 0 1 1 4 0V5h3a1 1 0 0 1 1 1v3h1.5a2 2 0 1 1 0 4H18v3a1 1 0 0 1-1 1h-3v1.5a2 2 0 1 1-4 0V17H7a1 1 0 0 1-1-1v-3H4.5a2 2 0 1 1 0-4H6V6a1 1 0 0 1 1-1h3z"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 4 13c0-6 8-9 16-9 0 8-3 16-9 16Z"/><path d="M4 20c2-3 5-6 9-8"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3.5 9h17M3.5 15h17"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/>',
  blocks: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>',

  // -- Files --------------------------------------------------------------
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h9A1.5 1.5 0 0 1 21 10v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18Z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  fileText: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  code: '<path d="m9 18-6-6 6-6M15 6l6 6-6 6"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 19h16"/>',
  upload: '<path d="M12 21V9M7 14l5-5 5 5"/><path d="M4 5h16"/>',
  save: '<path d="M5 3h11l5 5v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M8 3v6h7V3M8 21v-7h8v7"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7"/><path d="M10 11v6M14 11v6"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  pencil: '<path d="M4 20h4L20 8a2.8 2.8 0 0 0-4-4L4 16z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M10.7 5.7A9.5 9.5 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.2 4M6.3 6.6A17 17 0 0 0 2.5 12S6 18.5 12 18.5a9.4 9.4 0 0 0 4-.9"/><path d="m3 3 18 18M10 10a3 3 0 0 0 4 4"/>',

  // -- Metrics ------------------------------------------------------------
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  memory: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 7V4.5M12 7V4.5M17 7V4.5M7 17v2.5M12 17v2.5M17 17v2.5"/><path d="M8 11h2M14 11h2"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16.5 5.2a3.2 3.2 0 0 1 0 5.6M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  userPlus: '<circle cx="10" cy="8" r="3.5"/><path d="M3 20a7 7 0 0 1 13.5-2.6"/><path d="M19 14v6M16 17h6"/>',
  shield: '<path d="M12 3 4.5 6v6c0 4.6 3.2 7.9 7.5 9 4.3-1.1 7.5-4.4 7.5-9V6Z"/><path d="m9 12 2 2 4-4"/>',
  hardDrive: '<path d="M3 13h18"/><path d="M5.5 6h13l2.5 7v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z"/><path d="M7 15.5h.01M11 15.5h.01"/>',
  network: '<rect x="9" y="2.5" width="6" height="6" rx="1.5"/><rect x="2.5" y="15.5" width="6" height="6" rx="1.5"/><rect x="15.5" y="15.5" width="6" height="6" rx="1.5"/><path d="M12 8.5v3.5M5.5 15.5V12h13v3.5"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m7.5 10 2.5 2.5-2.5 2.5M12.5 15h4"/>',
  wifi: '<path d="M2.5 9a15 15 0 0 1 19 0M5.5 12.5a11 11 0 0 1 13 0M8.5 16a6.5 6.5 0 0 1 7 0"/><path d="M12 19.5h.01"/>',
  wifiOff: '<path d="m3 3 18 18"/><path d="M8.5 16a6.5 6.5 0 0 1 7 0M5.5 12.5a11 11 0 0 1 4-2.6M2.5 9a15 15 0 0 1 5.2-3"/><path d="M12 19.5h.01"/>',

  // -- Misc ---------------------------------------------------------------
  coffee: '<path d="M4 8h13v6.5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 9.5h1.8a2.7 2.7 0 0 1 0 5.4H17"/><path d="M7 2.5v2M11 2.5v2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  filter: '<path d="M4 5h16l-6 7v6l-4 2v-8z"/>',
  sliders: '<path d="M5 21V14M5 10V3M12 21v-9M12 8V3M19 21v-5M19 12V3"/><path d="M2.5 14h5M9.5 12h5M16.5 16h5"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><path d="M7.5 7.5h.01"/>',
  link: '<path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1-1"/>',
  bell: '<path d="M18 8.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5Z"/><path d="M13.7 19a2 2 0 0 1-3.4 0"/>',
  sparkles: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><path d="m6.3 6.3 2.4 2.4M15.3 15.3l2.4 2.4M17.7 6.3l-2.4 2.4M8.7 15.3l-2.4 2.4"/>',
  rocket: '<path d="M12 3c3.5 1.5 5.5 5 5.5 9L12 17l-5.5-5C6.5 8 8.5 4.5 12 3Z"/><circle cx="12" cy="9.5" r="1.8"/><path d="M8.5 16.5c-1 2-2.5 3-4 3.5.5-1.5 1-3 2-4M15.5 16.5c1 2 2.5 3 4 3.5-.5-1.5-1-3-2-4"/>',
  package: '<path d="m12 3 8.5 4.9v9.8L12 22.6 3.5 17.7V7.9z"/><path d="m3.5 7.9 8.5 4.9 8.5-4.9M12 12.8v9.8"/>',
  box: '<rect x="3.5" y="7.5" width="17" height="13" rx="2"/><path d="M3.5 11.5h17M9 7.5V4.5h6v3"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8 2 2-1.5 1.5L21 9l-2 2-1.5-1.5L15 12"/>',
  wrench: '<path d="M15.5 3a5.5 5.5 0 0 0-4.9 8L3 18.6 5.4 21l7.6-7.6A5.5 5.5 0 1 0 15.5 3Z"/><circle cx="16.5" cy="7.5" r="1.2"/>',
  flame: '<path d="M12 22c4 0 6.5-2.7 6.5-6.2 0-4.4-4.3-6.3-4-11.8-2.4 1-4.4 3.6-4.4 6.2 0 1.4.5 2.3.5 3.2 0 1.2-.9 2-2 2s-1.9-.7-2.3-1.7C5.6 15 5.5 16 5.5 17 5.5 20 8 22 12 22Z"/>',
  shieldCheck: '<path d="M12 3 4.5 6v6c0 4.6 3.2 7.9 7.5 9 4.3-1.1 7.5-4.4 7.5-9V6Z"/><path d="m8.8 12.2 2.2 2.2 4.2-4.4"/>',
  gitBranch: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="9" r="2.5"/><path d="M6 8.5v7M18 11.5a6 6 0 0 1-6 6H8.5"/>',
  layers: '<path d="m12 3 9 4.5-9 4.5-9-4.5z"/><path d="m3 12 9 4.5 9-4.5M3 16.5 12 21l9-4.5"/>',
  database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
};

/**
 * @param {string} name
 * @param {{ size?: number, stroke?: number, className?: string }} [opts]
 * @returns {string} SVG markup
 */
export function icon(name, { size = 24, stroke = 1.7, className = '' } = {}) {
  const body = PATHS[name];
  if (!body) return '';
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" ` +
    `stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true" focusable="false"${className ? ` class="${className}"` : ''}>${body}</svg>`
  );
}

/**
 * Replace every `<span data-icon="name">` inside `root` with its SVG.
 * Runs after each render; cheap because icons are already inlined.
 */
export function hydrateIcons(root = document) {
  for (const node of root.querySelectorAll('[data-icon]:not([data-icon-done])')) {
    const name = node.getAttribute('data-icon');
    const size = Number(node.getAttribute('data-icon-size')) || 24;
    const svg = icon(name, { size });
    if (svg) node.innerHTML = svg;
    node.setAttribute('data-icon-done', '1');
  }
}

/** Build a detached icon element, ready to append. */
export function iconEl(name, opts) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('data-icon', name);
  span.innerHTML = icon(name, opts);
  span.setAttribute('data-icon-done', '1');
  span.style.display = 'inline-flex';
  return span;
}

export const ICON_NAMES = Object.keys(PATHS);
export default icon;
