/**
 * System tray presence.
 *
 * For an app whose whole job is keeping servers alive, the tray is the primary
 * UI when the window is closed: it shows at a glance whether anything is
 * running, and lets you start/stop/open without bringing the window forward.
 */

import path from 'node:path';
import { Tray, Menu, nativeImage, app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICONS = path.join(__dirname, 'icons');

/** Icon bitmaps are loaded once; `Tray` instances are cheap to re-create. */
let cache = null;

/**
 * A 16×16 fully transparent image.
 *
 * `new Tray()` throws on an empty image, so this is the guaranteed-valid last
 * resort if `desktop/icons/` has not been generated yet (a fresh clone before
 * `npm run icons`). A blank tray icon is a cosmetic problem; a crash is not.
 */
function blankImage() {
  return nativeImage.createFromBuffer(
    // Minimal 16x16 RGBA PNG with a zero alpha channel.
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVQ4jWNgGAWjYBSMglEwCkbBKBgFo2AUAAAGdgABtO0vLwAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
}

function images() {
  if (cache) return cache;

  const load = (name, size) => {
    try {
      const image = nativeImage.createFromPath(path.join(ICONS, name));
      if (image.isEmpty()) return null;
      return size ? image.resize({ width: size, height: size, quality: 'best' }) : image;
    } catch {
      return null;
    }
  };

  const active = load('tray.png', 16) ?? load('tray.png');
  const idle = load('tray-idle.png', 16) ?? load('tray-idle.png');

  if (!active && !idle) {
    console.warn('[tray] No tray artwork found in desktop/icons — run `npm run icons`.');
  }

  cache = {
    active: active ?? idle,
    idle: idle ?? active,
    blank: blankImage(),
  };
  return cache;
}

export class AppTray {
  /**
   * @param {{ registry: object, onShow: Function, onOpenServer: (id:string)=>void,
   *           onQuit: Function, onCommand: (action:string, payload?:object)=>void }} options
   */
  constructor({ registry, onShow, onOpenServer, onQuit, onCommand }) {
    this.registry = registry;
    this.onShow = onShow;
    this.onOpenServer = onOpenServer;
    this.onQuit = onQuit;
    this.onCommand = onCommand;

    this.tray = null;
    this.rebuildTimer = null;
  }

  start() {
    const icons = images();
    this.tray = new Tray(icons.idle ?? icons.active ?? icons.blank);
    this.tray.setToolTip('Minecraft Server Manager');

    // Left-click focuses the window; right-click opens the menu (Windows/macOS).
    this.tray.on('click', () => this.onShow());
    this.tray.on('double-click', () => this.onShow());

    this.refresh();

    // The registry emits metrics roughly every 2s; coalesce into one rebuild.
    const schedule = () => this.scheduleRefresh();
    this.registry.on('status', schedule);
    this.registry.on('metrics', schedule);
    this.registry.on('lifecycle', schedule);
    this.registry.on('created', schedule);
    this.registry.on('deleted', schedule);

    return this;
  }

  scheduleRefresh() {
    if (this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.refresh();
    }, 700);
    this.rebuildTimer.unref?.();
  }

  refresh() {
    if (!this.tray || this.tray.isDestroyed?.()) return;

    const servers = this.registry.list();
    const running = servers.filter((s) => ['running', 'starting', 'stopping'].includes(s.status));
    const players = running.reduce((sum, s) => sum + (s.onlineCount ?? 0), 0);
    const crashed = servers.filter((s) => s.status === 'crashed');

    const icons = images();
    const next = running.length ? icons.active ?? icons.idle : icons.idle ?? icons.active;
    this.tray.setImage(next ?? icons.blank);

    const tooltip = !servers.length
      ? 'Minecraft Server Manager — no servers yet'
      : running.length
        ? `Minecraft Server Manager — ${running.length} running${players ? `, ${players} player${players === 1 ? '' : 's'}` : ''}`
        : 'Minecraft Server Manager — all stopped';
    this.tray.setToolTip(tooltip);

    const statusLine = !servers.length
      ? 'No servers configured'
      : `${running.length} of ${servers.length} running${players ? ` · ${players} playing` : ''}`;

    const template = [
      { label: 'Minecraft Server Manager', enabled: false },
      { label: statusLine, enabled: false },
      ...(crashed.length
        ? [{ label: `${crashed.length} crashed`, enabled: false }]
        : []),
      { type: 'separator' },
      {
        label: 'Open dashboard',
        click: () => this.onShow('#/dashboard'),
      },
      { type: 'separator' },
    ];

    if (servers.length) {
      template.push({
        label: 'Servers',
        submenu: servers.flatMap((server) => {
          const live = ['running', 'starting', 'stopping'].includes(server.status);
          const statusLabel =
            server.status === 'running' ? 'Running'
            : server.status === 'starting' ? 'Starting…'
            : server.status === 'stopping' ? 'Stopping…'
            : server.status === 'crashed' ? 'Crashed'
            : 'Stopped';

          const item = {
            label: `${server.name}  —  ${statusLabel}${server.onlineCount ? ` (${server.onlineCount})` : ''}`,
            submenu: [
              { label: 'Open console', click: () => this.onOpenServer(server.id) },
              { type: 'separator' },
              live
                ? { label: 'Stop', click: () => this.request('stop', server.id) }
                : { label: 'Start', click: () => this.request('start', server.id) },
              { label: 'Restart', enabled: live, click: () => this.request('restart', server.id) },
              { type: 'separator' },
              { label: 'Back up now', click: () => this.request('backup', server.id) },
            ],
          };
          return [item];
        }),
      });

      template.push({ type: 'separator' });
      template.push({
        label: 'Start all',
        enabled: servers.some((s) => !['running', 'starting', 'stopping'].includes(s.status)),
        click: () => this.request('start-all'),
      });
      template.push({
        label: 'Stop all',
        enabled: running.length > 0,
        click: () => this.request('stop-all'),
      });
      template.push({ type: 'separator' });
    }

    template.push({ label: 'Open servers folder', click: () => this.request('open-servers-folder') });
    template.push({ type: 'separator' });
    template.push({ label: 'Quit', accelerator: 'Control+Q', click: () => this.onQuit() });

    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  /** Forward a tray action to the renderer so the UI stays the source of truth. */
  request(action, serverId = null) {
    this.onCommand(action, serverId ? { serverId } : undefined);
  }

  destroy() {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    try {
      this.tray?.destroy();
    } catch {
      /* already gone */
    }
    this.tray = null;
  }
}

/** Taskbar overlay badge (Windows) / dock badge (macOS). */
export function setBadge(count) {
  try {
    if (process.platform === 'darwin') {
      app.dock?.setBadge(count > 0 ? String(count) : '');
      return true;
    }
    if (process.platform === 'win32') {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) return false;
      if (!count) {
        window.setOverlayIcon(null, '');
        return true;
      }
      // A 16px dot in the app's accent colour.
      const dot = nativeImage.createFromDataURL(
        'data:image/svg+xml;base64,' +
          Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7" fill="#10b981" stroke="#04160f" stroke-width="1.5"/></svg>`,
          ).toString('base64'),
      );
      window.setOverlayIcon(dot, `${count} server${count === 1 ? '' : 's'} running`);
      return true;
    }
  } catch {
    /* unsupported platform or window gone */
  }
  return false;
}

export default AppTray;
