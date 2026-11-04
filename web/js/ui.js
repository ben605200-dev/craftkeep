/**
 * UI primitives: toasts, modals, confirmation dialogs and loading overlays.
 *
 * These are imperative on purpose — a view calls `toast.success('Started')`
 * and carries on. Everything is created with `dom.el`, so no user data ever
 * passes through `innerHTML`.
 */

import { el, mount, qs, on, trapFocus, focusSoft, frag } from './dom.js';
import { icon } from './icons.js';

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

const ICONS = { success: 'checkCircle', error: 'alertCircle', warning: 'alert', info: 'info' };
let toastContainer = null;

function getToastContainer() {
  if (!toastContainer) toastContainer = qs('#toasts');
  return toastContainer;
}

/**
 * @param {{ title: string, text?: string, hint?: string, tone?: 'success'|'error'|'warning'|'info',
 *           duration?: number, action?: { label: string, onClick: Function }, id?: string }} options
 * @returns {{ dismiss: () => void, update: (patch: object) => void }}
 */
export function showToast(options) {
  const {
    title,
    text = '',
    hint = '',
    tone = 'info',
    duration = tone === 'error' ? 9000 : 4500,
    action = null,
  } = options;

  const container = getToastContainer();
  if (!container) return { dismiss() {}, update() {} };

  // Collapse duplicates: refresh the existing toast instead of stacking.
  if (options.id) {
    const existing = container.querySelector(`[data-toast-id="${CSS.escape(options.id)}"]`);
    if (existing) {
      existing.querySelector('.toast__title').textContent = title;
      const textNode = existing.querySelector('.toast__text');
      if (textNode) textNode.textContent = text;
      clearTimeout(Number(existing.dataset.timer));
      const timer = setTimeout(() => dismissToast(existing), duration);
      existing.dataset.timer = String(timer);
      return { dismiss: () => dismissToast(existing), update: () => {} };
    }
  }

  const bar = el('span.toast__progress', { style: 'width:100%' });

  const node = el(
    `div.toast.toast--${tone}`,
    { role: tone === 'error' ? 'alert' : 'status', ...(options.id ? { 'data-toast-id': options.id } : {}) },
    el('span.toast__icon', { html: icon(ICONS[tone] ?? 'info', { size: 18 }) }),
    el(
      'div.toast__body',
      el('div.toast__title', title),
      text ? el('div.toast__text', text) : null,
      hint ? el('div.toast__hint', hint) : null,
      action
        ? el(
            'button.btn.btn--sm.btn--outline',
            {
              style: 'margin-top:0.5rem',
              onclick: () => {
                action.onClick();
                dismissToast(node);
              },
            },
            action.label,
          )
        : null,
    ),
    el('button.toast__close', { type: 'button', 'aria-label': 'Dismiss', onclick: () => dismissToast(node) }, '✕'),
    duration > 0 ? bar : null,
  );

  container.appendChild(node);

  if (duration > 0) {
    bar.style.transition = `width ${duration}ms linear`;
    requestAnimationFrame(() => {
      bar.style.width = '0%';
    });
    const timer = setTimeout(() => dismissToast(node), duration);
    node.dataset.timer = String(timer);
    node.addEventListener('mouseenter', () => {
      clearTimeout(Number(node.dataset.timer));
      bar.style.transition = 'none';
    });
    node.addEventListener('mouseleave', () => dismissToast(node, 1500));
  }

  return {
    dismiss: () => dismissToast(node),
    update: (patch) => {
      if (patch.title) node.querySelector('.toast__title').textContent = patch.title;
      const textNode = node.querySelector('.toast__text');
      if (textNode && patch.text !== undefined) textNode.textContent = patch.text;
    },
  };
}

export function dismissToast(node, delay = 0) {
  if (!node?.isConnected) return;
  clearTimeout(Number(node.dataset.timer));
  const remove = () => {
    node.classList.add('toast--leaving');
    setTimeout(() => node.remove(), 240);
  };
  if (delay > 0) setTimeout(remove, delay);
  else remove();
}

export const toast = {
  success: (title, text, extra = {}) => showToast({ title, text, tone: 'success', ...extra }),
  error: (title, text, extra = {}) => showToast({ title, text, tone: 'error', ...extra }),
  warning: (title, text, extra = {}) => showToast({ title, text, tone: 'warning', ...extra }),
  info: (title, text, extra = {}) => showToast({ title, text, tone: 'info', ...extra }),
  show: showToast,
  dismiss: dismissToast,

  /** Present an ApiError with its hint and any actionable detail. */
  fromError(error, fallbackTitle = 'Something went wrong') {
    const detail = [error?.message, error?.hint].filter(Boolean).join(' — ');
    return showToast({
      title: error?.payload?.detail?.title ?? error?.message ?? fallbackTitle,
      text: error?.payload?.detail?.hint ?? detail,
      tone: 'error',
    });
  },
};

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

const modalStack = [];

/**
 * Open a modal.
 *
 * @param {{ title?: string, subtitle?: string, icon?: string, tone?: string, size?: 'slim'|'default'|'wide',
 *           body: Node|Node[], footer?: Node|Node[], dismissable?: boolean, onClose?: Function }} options
 * @returns {{ close: (result?: any) => void, root: HTMLElement, body: HTMLElement }}
 */
export function openModal(options) {
  const {
    title,
    subtitle,
    icon: iconName = 'info',
    tone = 'accent',
    size = 'default',
    body,
    footer,
    dismissable = true,
    onClose,
  } = options;

  const root = qs('#modal-root');
  const toneRgb = {
    accent: 'var(--accent-rgb)',
    danger: 'var(--danger-rgb)',
    warning: 'var(--warning-rgb)',
    success: 'var(--success-rgb)',
    info: 'var(--info-rgb)',
  }[tone] ?? 'var(--accent-rgb)';

  const bodyNode = el('div.modal__body');

  const modal = el(
    `div.modal${size === 'wide' ? '.modal--wide' : size === 'slim' ? '.modal--slim' : ''}`,
    {
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': title ?? 'Dialog',
      style: `--modal-rgb: ${toneRgb}`,
    },
    title
      ? el(
          'div.modal__head',
          el('span.modal__icon', { html: icon(iconName, { size: 19 }) }),
          el('div.grow', el('h3', title), subtitle ? el('p', subtitle) : null),
          dismissable
            ? el('button.iconbtn', { type: 'button', 'aria-label': 'Close', onclick: () => close() }, '✕')
            : null,
        )
      : null,
    bodyNode,
    footer ? el('div.modal__foot', footer) : null,
  );

  mount(bodyNode, body);
  root.replaceChildren(modal);
  root.hidden = false;

  const previousFocus = document.activeElement;
  const releaseTrap = trapFocus(modal);

  /** @type {{ open: boolean, modal: HTMLElement, releaseTrap: Function, onClose?: Function, previousFocus: Element|null }} */
  const entry = { open: true, modal, releaseTrap, onClose, previousFocus };
  modalStack.push(entry);

  // Focus the first sensible control.
  requestAnimationFrame(() => {
    const target =
      modal.querySelector('[autofocus]') ??
      modal.querySelector('.modal__body input:not([type="hidden"]), .modal__body textarea, .modal__body select') ??
      modal.querySelector('.modal__foot .btn--primary') ??
      modal.querySelector('button');
    focusSoft(target);
  });

  function close(result) {
    if (!entry.open) return;
    entry.open = false;

    document.removeEventListener('keydown', onKey);
    root.removeEventListener('mousedown', onBackdrop);
    releaseTrap();
    modalStack.splice(modalStack.indexOf(entry), 1);

    if (!modalStack.length) {
      root.hidden = true;
      root.replaceChildren();
    } else {
      root.replaceChildren(modalStack[modalStack.length - 1].modal);
    }

    focusSoft(previousFocus);
    onClose?.(result);
  }

  function onKey(event) {
    if (event.key === 'Escape' && dismissable && modalStack[modalStack.length - 1] === entry) {
      event.preventDefault();
      close();
    }
  }

  function onBackdrop(event) {
    if (dismissable && event.target === root) close();
  }

  on(document, 'keydown', onKey);
  root.addEventListener('mousedown', onBackdrop);

  return { close, root: modal, body: bodyNode };
}

/**
 * Promise-based confirmation dialog.
 *
 * @param {{ title: string, message?: string, detail?: string, confirmLabel?: string,
 *           cancelLabel?: string, tone?: 'danger'|'warning'|'accent', requireText?: string,
 *           icon?: string }} options
 * @returns {Promise<boolean>}
 */
export function confirmDialog(options) {
  const {
    title,
    message = '',
    detail = '',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    tone = 'danger',
    requireText = null,
    icon: iconName = tone === 'danger' ? 'alert' : 'question',
  } = options;

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
      modal.close();
    };

    let typed = '';
    const confirmBtn = el(
      `button.btn.btn--${tone === 'danger' ? 'danger' : 'primary'}`,
      { type: 'button', disabled: Boolean(requireText), onclick: () => finish(true) },
      confirmLabel,
    );

    const body = frag(
      message ? el('p', { style: 'font-size:0.9rem;line-height:1.6' }, message) : null,
      detail ? el('div.callout.callout--warn', { style: 'margin-top:0.9rem' }, el('span.callout__icon', { html: icon('alert', { size: 17 }) }), el('div', detail)) : null,
      requireText
        ? el(
            'div.field',
            { style: 'margin-top:1rem' },
            el('label.field__label', `Type "${requireText}" to confirm`),
            el('input.input.input--mono', {
              autofocus: true,
              placeholder: requireText,
              oninput: (event) => {
                typed = event.target.value;
                confirmBtn.disabled = typed !== requireText;
              },
            }),
          )
        : null,
    );

    const modal = openModal({
      title,
      icon: iconName,
      tone,
      size: 'slim',
      body,
      footer: [
        el('button.btn', { type: 'button', onclick: () => finish(false) }, cancelLabel),
        confirmBtn,
      ],
      onClose: () => finish(false),
    });
  });
}

/** Simple prompt dialog for a single value. */
export function promptDialog({ title, label, value = '', placeholder = '', confirmLabel = 'Save', type = 'text', mono = false, hint = '' }) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    const input = el('input', {
      class: `input${mono ? '.input--mono' : ''}`,
      type,
      value,
      placeholder,
      autofocus: true,
      onkeydown: (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
      },
    });

    const submit = () => {
      const text = input.value.trim();
      finish(text || null);
      modal.close();
    };

    const modal = openModal({
      title,
      size: 'slim',
      body: el('div.field', label ? el('label.field__label', label) : null, input, hint ? el('div.field__hint', hint) : null),
      footer: [
        el('button.btn', { type: 'button', onclick: () => { finish(null); modal.close(); } }, 'Cancel'),
        el('button.btn.btn--primary', { type: 'button', onclick: submit }, confirmLabel),
      ],
      onClose: () => finish(null),
    });
  });
}

/** Full-screen blocking overlay with a message — used during long operations. */
export function busyOverlay(message = 'Working…') {
  const root = qs('#modal-root');
  const spinner = el('div.spinner.spinner--accent', { style: 'width:26px;height:26px;border-width:3px' });
  const text = el('p', { style: 'font-size:0.9rem;font-weight:560' }, message);
  const hint = el('p', { style: 'font-size:0.8rem;color:var(--text-muted);max-width:36ch;text-align:center' });
  const cancelBtn = el('button.btn.btn--sm', { type: 'button', style: 'margin-top:0.5rem' }, 'Cancel');

  const box = el(
    'div.card.card--pad.card--glass',
    {
      style: 'display:grid;place-items:center;gap:0.75rem;width:min(360px,100%);padding:1.7rem',
      role: 'alertdialog',
      'aria-busy': 'true',
    },
    spinner,
    text,
    hint,
    cancelBtn,
  );

  root.replaceChildren(box);
  root.hidden = false;

  let cancelled = false;
  cancelBtn.addEventListener('click', () => {
    cancelled = true;
    close();
  });

  function close() {
    root.hidden = true;
    root.replaceChildren();
  }

  return {
    update(nextMessage, nextHint = '') {
      text.textContent = nextMessage;
      hint.textContent = nextHint;
    },
    close,
    get cancelled() {
      return cancelled;
    },
    onCancel(handler) {
      cancelBtn.addEventListener('click', handler);
    },
  };
}

// ---------------------------------------------------------------------------
// Tooltips
// ---------------------------------------------------------------------------

/**
 * Global tooltip layer.
 *
 * One element lives at the end of `<body>` and is positioned on hover, instead
 * of each trigger drawing its own `::after`. A pseudo-element cannot escape the
 * stacking context or the `overflow: hidden` of its ancestors, so tooltips kept
 * appearing behind cards and getting clipped inside the console.
 *
 * Attach to anything with `data-tip="text"`. Add `data-tip--right` or
 * `data-tip-below` to change the preferred side; the layer flips automatically
 * when there is no room.
 */
export function initTooltips() {
  let layer = null;
  let current = null;
  let showTimer = null;

  const ensureLayer = () => {
    if (!layer || !layer.isConnected) {
      layer = el('div.tooltip-layer', { role: 'tooltip', 'aria-hidden': 'true' });
      document.body.appendChild(layer);
    }
    return layer;
  };

  /** Which side does the trigger prefer? */
  function placementOf(trigger) {
    if (trigger.hasAttribute('data-tip--right') || trigger.hasAttribute('data-tip-right')) return 'right';
    if (trigger.hasAttribute('data-tip--below') || trigger.hasAttribute('data-tip-below')) return 'below';
    return 'above';
  }

  function position(trigger) {
    const node = ensureLayer();
    const rect = trigger.getBoundingClientRect();
    const placement = placementOf(trigger);

    // Measure after the text is in place, at its final width.
    const size = node.getBoundingClientRect();
    const gap = 8;

    let top;
    let left;

    if (placement === 'right') {
      top = rect.top + rect.height / 2 - size.height / 2;
      left = rect.right + gap;
      // Not enough room to the right? Flip to the left.
      if (left + size.width > window.innerWidth - 6) left = rect.left - size.width - gap;
    } else if (placement === 'below') {
      top = rect.bottom + gap;
      left = rect.left + rect.width / 2 - size.width / 2;
    } else {
      top = rect.top - size.height - gap;
      left = rect.left + rect.width / 2 - size.width / 2;
      // Not enough room above (a toolbar at the top of the window)? Flip below.
      if (top < 6) top = rect.bottom + gap;
    }

    // Final clamp so it is always fully on screen.
    left = Math.max(6, Math.min(left, window.innerWidth - size.width - 6));
    top = Math.max(6, Math.min(top, window.innerHeight - size.height - 6));

    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
  }

  function show(trigger) {
    const text = trigger.getAttribute('data-tip');
    if (!text) return;
    const node = ensureLayer();
    if (current !== trigger) {
      // `textContent`, never `innerHTML` — tooltip copy includes server names.
      node.textContent = text;
      current = trigger;
    }
    position(trigger);
    node.classList.add('tooltip-layer--visible');
  }

  function hide() {
    clearTimeout(showTimer);
    showTimer = null;
    current = null;
    layer?.classList.remove('tooltip-layer--visible');
  }

  document.addEventListener('pointerover', (event) => {
    const trigger = event.target?.closest?.('[data-tip]');
    if (!trigger || trigger === current) return;
    clearTimeout(showTimer);
    // A short delay keeps the tooltip from flashing as the pointer sweeps a row
    // of icons on its way somewhere else.
    showTimer = setTimeout(() => show(trigger), 200);
  });

  document.addEventListener('pointerout', (event) => {
    const trigger = event.target?.closest?.('[data-tip]');
    if (!trigger) return;
    // Moving onto a child of the same trigger should not dismiss it.
    if (event.relatedTarget && trigger.contains(event.relatedTarget)) return;
    hide();
  });

  // Anything that moves the trigger invalidates where the layer was placed.
  window.addEventListener('scroll', hide, true);
  document.addEventListener('pointerdown', hide, true);
  window.addEventListener('blur', hide);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide();
  }, true);
}

/** Close every open modal (used on route changes and logout). */
export function closeAllModals() {
  while (modalStack.length) {
    const entry = modalStack[modalStack.length - 1];
    entry.releaseTrap?.();
    modalStack.pop();
  }
  const root = qs('#modal-root');
  root.hidden = true;
  root.replaceChildren();
}

export default { toast, showToast, openModal, confirmDialog, promptDialog, busyOverlay, closeAllModals, initTooltips };
