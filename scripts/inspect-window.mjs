/**
 * Attach to a running app window and inspect or screenshot it.
 *
 * The app is an Electron window, so its renderer is a normal Chromium target
 * and can be driven over the DevTools protocol. That makes it possible to check
 * what the real window is actually showing — including the parts that only
 * exists behind the preload bridge and a session token, which a plain browser
 * cannot reach.
 *
 * Launch the app with debugging enabled first:
 *   npx electron . --remote-debugging-port=9222 --route="#/servers/<id>?tab=connect"
 *
 * Then:
 *   node scripts/inspect-window.mjs --eval "document.title"
 *   node scripts/inspect-window.mjs --text .pane
 *   node scripts/inspect-window.mjs --screenshot out.png
 *   node scripts/inspect-window.mjs --click "Connect"
 */

import fs from 'node:fs';
import process from 'node:process';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : (args[index + 1] ?? true);
};

const PORT = Number(flag('port', 9222));
const HOST = 'http://127.0.0.1:' + PORT;

/** Find the app's own page target. */
async function findPageTarget({ timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${HOST}/json/list`);
      const targets = await response.json();
      const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);

      // Prefer the app window over the splash screen: both are `page` targets,
      // and the splash is listed first.
      const page =
        pages.find((t) => t.url.startsWith('http://127.0.0.1')) ??
        pages.find((t) => !t.url.startsWith('file://')) ??
        pages[0];

      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  throw new Error(`No page target on ${HOST}. Is the app running with --remote-debugging-port=${PORT}?`);
}

/** Minimal CDP client. */
class Session {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();

    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return new Session(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 45_000).unref?.();
    });
  }

  /** Evaluate an expression in the page and return its value. */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation threw');
    }
    return result.result?.value;
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
  }
}

const target = await findPageTarget();
const session = await Session.connect(target.webSocketDebuggerUrl);
await session.send('Runtime.enable');

try {
  if (args.includes('--screenshot')) {
    const file = String(flag('screenshot'));
    const shot = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`screenshot written to ${file}`);
  } else if (args.includes('--text')) {
    const selector = String(flag('text'));
    const text = await session.evaluate(
      `(() => { const n = document.querySelector(${JSON.stringify(selector)}); return n ? n.innerText : null; })()`,
    );
    console.log(text ?? '(no element matched)');
  } else if (args.includes('--click')) {
    const label = String(flag('click'));
    const clicked = await session.evaluate(
      `(() => {
         const node = [...document.querySelectorAll('button, a, .tab')]
           .find((n) => (n.innerText || '').trim() === ${JSON.stringify(label)});
         if (!node) return false;
         node.click();
         return true;
       })()`,
    );
    console.log(clicked ? `clicked "${label}"` : `no control labelled "${label}"`);
  } else if (args.includes('--hover')) {
    /*
     * Force `:hover` on an element and report its computed style.
     *
     * `:hover` cannot be triggered from JavaScript, so the only honest way to
     * check a hover rule is to ask the browser to apply the pseudo-class.
     */
    const selector = String(flag('hover'));
    await session.send('DOM.enable');
    await session.send('CSS.enable');

    const { root } = await session.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`No element matches "${selector}"`);

    const read = () =>
      session.evaluate(
        `(() => {
           const n = document.querySelector(${JSON.stringify(selector)});
           if (!n) return null;
           const s = getComputedStyle(n);
           return {
             color: s.color,
             backgroundImage: s.backgroundImage,
             backgroundColor: s.backgroundColor,
             borderTopColor: s.borderTopColor,
             text: (n.innerText || '').trim().slice(0, 40),
           };
         })()`,
      );

    const before = await read();
    await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const after = await read();
    await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });

    console.log(JSON.stringify({ selector, normal: before, hover: after }, null, 2));
  } else if (args.includes('--eval')) {
    const value = await session.evaluate(String(flag('eval')));
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  } else {
    console.log(JSON.stringify({ title: target.title, url: target.url }, null, 2));
  }
} finally {
  session.close();
}
