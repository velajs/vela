/**
 * Test-environment layout shim. happy-dom has no layout engine, so every element
 * reports `offsetWidth`/`offsetHeight` of 0. `@tanstack/react-virtual` sizes its
 * scroll viewport from those, and would otherwise window to an empty range under
 * the test DOM. Reporting a fixed viewport lets the virtualizer compute a real
 * (still partial) window, so virtualization is genuinely exercised. This affects
 * only the test runtime — never the shipped bundle.
 */
const VIEWPORT_WIDTH = 960;
const VIEWPORT_HEIGHT = 480;

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get(): number {
    return VIEWPORT_WIDTH;
  },
});

Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get(): number {
    return VIEWPORT_HEIGHT;
  },
});
