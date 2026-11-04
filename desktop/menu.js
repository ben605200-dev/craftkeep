/**
 * Native application menu.
 *
 * Menu items do not touch the backend directly. They forward an action name to
 * the renderer, which already owns the API client, the router and the toast
 * system — one implementation of "start all servers", not two.
 */

import { Menu, shell, app, dialog } from 'electron';

/**
 * @param {{ send: (action: string, payload?: object) => void,
 *           getState: () => { runningCount: number, serverCount: number, serverId: string|null },
 *           onQuit: Function, paths: { servers: string, data: string, backups: string, logs: string },
 *           configFile: string }} options
 */
export function buildAppMenu({ send, getState, onQuit, paths, configFile }) {
  const isMac = process.platform === 'darwin';
  const state = () => getState?.() ?? { runningCount: 0, serverCount: 0, serverId: null };

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Preferences…', accelerator: 'Cmd+,', click: () => send('navigate', { to: '#/settings' }) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit Craftkeep', accelerator: 'Cmd+Q', click: () => onQuit() },
      ],
    });
  }

  template.push({
    label: '&File',
    submenu: [
      {
        label: 'New server…',
        accelerator: 'CmdOrCtrl+N',
        click: () => send('navigate', { to: '#/create' }),
      },
      { type: 'separator' },
      {
        label: 'Open servers folder',
        click: () => shell.openPath(paths.servers),
      },
      {
        label: 'Open data folder',
        click: () => shell.openPath(paths.data),
      },
      {
        label: 'Open backups folder',
        click: () => shell.openPath(paths.backups),
      },
      { type: 'separator' },
      {
        label: 'Export diagnostics…',
        click: () => send('export-diagnostics'),
      },
      { type: 'separator' },
      isMac ? { role: 'close' } : { label: 'Quit', accelerator: 'Ctrl+Q', click: () => onQuit() },
    ],
  });

  template.push({
    label: '&Servers',
    submenu: [
      // NOTE: the payload key must not be `action` — the renderer merges the
      // payload over the command envelope, so `action` would clobber the
      // command name itself.
      {
        label: 'Start all',
        click: () => send('bulk', { bulkAction: 'start' }),
      },
      {
        label: 'Stop all',
        click: () => send('bulk', { bulkAction: 'stop' }),
      },
      { type: 'separator' },
      {
        label: 'Back up all running',
        click: () => send('bulk', { bulkAction: 'backup' }),
      },
      { type: 'separator' },
      {
        label: 'Stop the server in view',
        click: () => send('viewed-server', { serverAction: 'stop' }),
      },
      {
        label: 'Restart the server in view',
        accelerator: 'CmdOrCtrl+Shift+R',
        click: () => send('viewed-server', { serverAction: 'restart' }),
      },
      {
        label: 'Force kill the server in view',
        click: () => send('viewed-server', { serverAction: 'kill' }),
      },
      { type: 'separator' },
      {
        label: 'Refresh everything',
        accelerator: 'CmdOrCtrl+R',
        click: () => send('refresh'),
      },
    ],
  });

  template.push({
    label: '&View',
    submenu: [
      { label: 'Dashboard', accelerator: 'CmdOrCtrl+1', click: () => send('navigate', { to: '#/dashboard' }) },
      { label: 'Servers', accelerator: 'CmdOrCtrl+2', click: () => send('navigate', { to: '#/servers' }) },
      { label: 'Backups', accelerator: 'CmdOrCtrl+3', click: () => send('navigate', { to: '#/backups' }) },
      { label: 'Settings', accelerator: 'CmdOrCtrl+4', click: () => send('navigate', { to: '#/settings' }) },
      { type: 'separator' },
      { label: 'Command palette', accelerator: 'CmdOrCtrl+K', click: () => send('palette') },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
    ],
  });

  template.push({
    label: '&Help',
    submenu: [
      {
        label: 'Keyboard shortcuts',
        accelerator: 'Shift+?',
        click: () => send('shortcuts'),
      },
      {
        label: 'Diagnostics panel',
        click: () => send('navigate', { to: '#/settings' }),
      },
      { type: 'separator' },
      {
        label: 'Open the README',
        click: () => shell.openPath(paths.readme).then((error) => {
          if (error) shell.openExternal('https://github.com');
        }),
      },
      {
        label: 'Where are my files?',
        click: async () => {
          const current = state();
          await dialog.showMessageBox({
            type: 'info',
            title: 'Where everything lives',
            message: 'Your servers and data stay on this machine',
            detail:
              `Servers:  ${paths.servers}\n\n` +
              `Backups:  ${paths.backups}\n\n` +
              `Logs:     ${paths.logs}\n\n` +
              `Preferences: ${configFile}\n\n` +
              `${current.serverCount} server(s) configured, ${current.runningCount} running.`,
            buttons: ['Open servers folder', 'Close'],
            defaultId: 0,
            cancelId: 1,
          }).then((result) => {
            if (result.response === 0) shell.openPath(paths.servers);
          });
        },
      },
      { type: 'separator' },
      {
        label: 'About',
        click: () =>
          dialog.showMessageBox({
            type: 'info',
            title: 'About',
            message: `Craftkeep ${app.getVersion()}`,
            detail:
              `Electron ${process.versions.electron}\n` +
              `Chromium ${process.versions.chrome}\n` +
              `Node ${process.versions.node}\n\n` +
              `A local dashboard for provisioning, running and monitoring ` +
              `Vanilla, Paper and Fabric servers.`,
            buttons: ['OK'],
          }),
      },
    ],
  });

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}

export default buildAppMenu;
