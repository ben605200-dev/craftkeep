/**
 * Idle tracking for the interface.
 *
 * The ambient background is animated, and until recently several always-visible
 * panels sat above it as glass (backdrop-filter). While those animations run,
 * the compositor keeps producing frames — re-blurring everything behind them —
 * whether or not anyone is looking. Measured on a plain dashboard, that cost
 * ~58% of a CPU core and ~92% GPU engine load around the clock, which is felt
 * as stutter in whatever else the machine is doing: usually the game, or the
 * Minecraft server itself.
 *
 * When the window is blurred or hidden, `html.is-idle` is set and the styles in
 * `base.css` pause every infinite animation — frame production then stops
 * completely until the window is looked at again.
 *
 * Deliberately event-driven, not polled: focus/blur/visibility are exactly the
 * transitions that matter, and a poll of `document.hasFocus()` would fight the
 * synthetic blur used by the performance tests.
 */

const root = document.documentElement;
let idle = null;

function apply(next) {
  if (next === idle) return;
  idle = next;
  root.classList.toggle('is-idle', idle);
}

/*
 * Trust the events rather than polling `hasFocus()`: a blur event *is* the
 * signal, and reconciling it against the current focus state is what makes
 * synthetic events (used by the performance tests) ineffective, while adding
 * nothing in real use.
 */
window.addEventListener('focus', () => { apply(false); markActive(); });
window.addEventListener('blur', () => apply(true));
window.addEventListener('visibilitychange', () => {
  const hidden = document.visibilityState === 'hidden';
  apply(hidden);
  if (!hidden) markActive();
});
window.addEventListener('pageshow', () => {
  apply(document.visibilityState === 'hidden' || !document.hasFocus());
  markActive();
});

/*
 * Stillness: no perpetual motion.
 *
 * A visible window with any running animation makes the compositor produce
 * frames for as long as it is on screen — which was most of a CPU core in the
 * worst case, and pure waste while the app is simply sitting open, focused but
 * untouched. After a short period without input the decorative animations are
 * frozen (`html.is-still`); the next pointer or key event thaws them.
 *
 * Interacting with the app produces frames anyway, so the motion is only ever
 * paid for at a time when the machine is already busy painting.
 */
const STILL_AFTER_MS = 12_000;
let stillTimer = null;

function markActive() {
  root.classList.remove('is-still');
  clearTimeout(stillTimer);
  stillTimer = setTimeout(() => root.classList.add('is-still'), STILL_AFTER_MS);
}

for (const event of ['pointermove', 'pointerdown', 'wheel', 'keydown']) {
  window.addEventListener(event, markActive, { passive: true });
}

apply(document.visibilityState === 'hidden' || !document.hasFocus());
markActive();

/** True while the window is blurred or hidden — nothing on screen needs repainting. */
export const isIdle = () => idle === true;
