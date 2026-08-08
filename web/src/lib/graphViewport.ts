export interface GraphViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Zoom a graph around the cursor while preserving the viewport's aspect ratio. */
export function zoomGraphViewBox(
  viewBox: GraphViewBox,
  deltaY: number,
  clientX: number,
  clientY: number,
  viewportLeft: number,
  viewportTop: number,
  viewportWidth: number,
  viewportHeight: number,
  minWidth: number,
  maxWidth: number,
): GraphViewBox {
  if (viewportWidth <= 0 || viewportHeight <= 0) return viewBox;
  const focusX = viewBox.x + ((clientX - viewportLeft) / viewportWidth) * viewBox.width;
  const focusY = viewBox.y + ((clientY - viewportTop) / viewportHeight) * viewBox.height;
  const factor = Math.exp(deltaY * 0.0012);
  const nextWidth = Math.min(maxWidth, Math.max(minWidth, viewBox.width * factor));
  const nextHeight = nextWidth * (viewBox.height / viewBox.width);
  const widthRatio = nextWidth / viewBox.width;
  const heightRatio = nextHeight / viewBox.height;
  return {
    x: focusX - (focusX - viewBox.x) * widthRatio,
    y: focusY - (focusY - viewBox.y) * heightRatio,
    width: nextWidth,
    height: nextHeight,
  };
}
