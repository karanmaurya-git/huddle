/** Which rows of a long list to render (virtual scrolling), so 100 people stay smooth. */
export function computeWindow({ scrollTop, viewportHeight, rowHeight, total, overscan = 4 }) {
  const first = Math.floor(scrollTop / rowHeight);
  const visible = Math.ceil(viewportHeight / rowHeight);
  const start = Math.max(0, first - overscan);
  const end = Math.min(total, first + visible + overscan);
  return { start, end, offsetTop: start * rowHeight, totalHeight: total * rowHeight };
}
