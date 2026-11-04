/**
 * Tiny DOM toolkit.
 *
 * Everything here is XSS-safe by construction: `el()` sets `textContent`
 * (never `innerHTML`) for user data, and the one raw-HTML escape hatch
 * (`html()`) is documented and only used for trusted, static markup.
 *
 * Console output from a Minecraft server is *untrusted input* — plugins can
 * echo anything a player types — so it must go through `textContent`.
 */

/**
 * Create an element.
 *
 * @param {string} tag         tag name, optionally with `.class` and `#id` shorthands
 *                             e.g. `div.card.is-open`, `button.btn#save`
 * @param {object|string|null} [props] attribute map, or a string shorthand for text
 * @param {...(Node|string|Array|null|false|undefined)} children
 */
export function el(tag, props = null, ...children) {
  const { name, classes, id } = parseTag(tag);
  const node = document.createElement(name);
  if (id) node.id = id;
  if (classes.length) node.className = classes.join(' ');

  if (typeof props === 'string' || typeof props === 'number') {
    node.textContent = String(props);
    props = null;
  }

  if (props && typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props)) {
    applyProps(node, props);
  } else if (props != null) {
    children.unshift(props);
  }

  append(node, children);
  return node;
}

function parseTag(tag) {
  const idSplit = tag.split('#');
  const id = idSplit[1] ?? null;
  const [name, ...classes] = idSplit[0].split('.');
  return { name: name || 'div', classes, id };
}

function applyProps(node, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class' || key === 'className') {
      const extra = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
      node.className = node.className ? `${node.className} ${extra}` : extra;
      continue;
    }
    if (key === 'style') {
      if (typeof value === 'string') node.style.cssText = value;
      else Object.assign(node.style, value);
      continue;
    }
    if (key === 'dataset') {
      Object.assign(node.dataset, value);
      continue;
    }
    if (key === 'text') {
      node.textContent = String(value);
      continue;
    }
    if (key === 'html') {
      // Only ever pass strings built by this app, never server data.
      node.innerHTML = String(value);
      continue;
    }
    if (key === 'value') {
      node.value = value;
      continue;
    }
    if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'hidden' || key === 'multiple') {
      node[key] = Boolean(value);
      if (key === 'disabled' || key === 'hidden') continue;
      if (value) node.setAttribute(key, '');
      continue;
    }
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
      continue;
    }
    if (key === 'ref' && typeof value === 'function') {
      value(node);
      continue;
    }
    node.setAttribute(key, value === true ? '' : String(value));
  }
}

/** Append children, flattening arrays and skipping falsy values. */
export function append(parent, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/** Replace an element's children in one shot. */
export function mount(parent, ...children) {
  parent.replaceChildren();
  return append(parent, children);
}

/** `document.querySelector`, typed for brevity. */
export const qs = (selector, root = document) => root.querySelector(selector);
export const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Build a DocumentFragment from a list of nodes. */
export function frag(...children) {
  const fragment = document.createDocumentFragment();
  append(fragment, children);
  return fragment;
}

/** Set attributes in bulk. */
export function attrs(node, map) {
  applyProps(node, map);
  return node;
}

/** Toggle a class and return the node (chainable). */
export function toggleClass(node, className, force) {
  node.classList.toggle(className, force);
  return node;
}

/** Add one or more event listeners; returns an unsubscribe function. */
export function on(target, events, handler, options) {
  const list = Array.isArray(events) ? events : [events];
  for (const event of list) target.addEventListener(event, handler, options);
  return () => {
    for (const event of list) target.removeEventListener(event, handler, options);
  };
}

/**
 * Delegated listener: matches a selector on any descendant.
 * Keeps re-rendered lists cheap — one listener, not N.
 */
export function delegate(root, event, selector, handler) {
  const listener = (rawEvent) => {
    const target = rawEvent.target?.closest?.(selector);
    if (target && root.contains(target)) handler(rawEvent, target);
  };
  root.addEventListener(event, listener);
  return () => root.removeEventListener(event, listener);
}

/** Debounce trailing-edge. */
export function debounce(fn, ms = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Throttle leading-edge, at most once per `ms`. */
export function throttle(fn, ms = 200) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...args);
      }, ms - (now - last));
    }
  };
}

/** Wait for the next animation frame. */
export const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** Focus an element without scrolling the page. */
export function focusSoft(node) {
  try {
    node?.focus({ preventScroll: true });
  } catch {
    node?.focus?.();
  }
}

/** Scroll a container to the bottom only if the user is already near it. */
export function isNearBottom(container, slack = 90) {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= slack;
}

export function scrollToBottom(container) {
  container.scrollTop = container.scrollHeight;
}

/** Copy text to the clipboard, with a legacy fallback for non-secure origins. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Trigger a browser download for an in-memory blob. */
export function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Trap Tab focus inside a container (used by modals). */
export function trapFocus(container) {
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  const handler = (event) => {
    if (event.key !== 'Tab') return;
    const focusable = qsa(selector, container).filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  container.addEventListener('keydown', handler);
  return () => container.removeEventListener('keydown', handler);
}

/**
 * RFC4122-ish id. `crypto.randomUUID` needs a secure context, which localhost
 * qualifies for — but the fallback keeps the app working if it is ever served
 * over plain HTTP from a LAN address.
 */
export function uuid() {
  try {
    if (crypto?.randomUUID) return crypto.randomUUID();
  } catch {
    /* not a secure context */
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Render a colour-coded avatar label from a player name (Minecraft-ish). */
export function playerColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 62% 62%)`;
}
