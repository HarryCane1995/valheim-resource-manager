import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

type DismissLayer = { ref: RefObject<HTMLElement | null>; dismiss: () => void };
const layers: DismissLayer[] = [];
let detailsConsumers = 0;
let listening = false;

function isInside(event: Event, element: HTMLElement) {
  return event.composedPath().includes(element)
    || (event.target instanceof Node && element.contains(event.target));
}

function openDetails() {
  return detailsConsumers
    ? [...document.querySelectorAll<HTMLDetailsElement>('details[data-dismiss-on-outside][open]')]
    : [];
}

function topLayer() {
  for (let index = layers.length - 1; index >= 0; index--) {
    if (layers[index].ref.current?.isConnected) return layers[index];
  }
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0 || event.isPrimary === false) return;
  for (const details of openDetails()) {
    if (!isInside(event, details)) details.open = false;
  }
  const layer = topLayer();
  if (layer?.ref.current && !isInside(event, layer.ref.current)) layer.dismiss();
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.isComposing || event.repeat) return;
  const layer = topLayer();
  const details = openDetails().filter(element => element.getClientRects().length > 0
    && (!layer || layer.ref.current?.contains(element)));
  // Descendants appear after their ancestors in document order. Close one level.
  const deepest = details.filter(element => !details.some(other => other !== element && element.contains(other))).at(-1);
  if (!deepest && !layer) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (deepest) deepest.open = false;
  else layer?.dismiss();
}

function syncListeners() {
  const needed = layers.length > 0 || detailsConsumers > 0;
  if (needed === listening) return;
  listening = needed;
  if (needed) {
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
  } else {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
  }
}

/** Dismiss the topmost panel without consuming the click on the main interface. */
export function useOutsideDismiss(ref: RefObject<HTMLElement | null>, onDismiss: () => void, enabled = true) {
  const latestDismiss = useRef(onDismiss);
  useLayoutEffect(() => { latestDismiss.current = onDismiss; }, [onDismiss]);
  useEffect(() => {
    if (!enabled) return;
    const layer = { ref, dismiss: () => latestDismiss.current() };
    layers.push(layer);
    syncListeners();
    return () => {
      const index = layers.indexOf(layer);
      if (index !== -1) layers.splice(index, 1);
      syncListeners();
    };
  }, [ref, enabled]);
}

/** Mount once in the app; only explicitly marked dropdowns participate. */
export function useDismissableDetails() {
  useEffect(() => {
    detailsConsumers++;
    syncListeners();
    return () => {
      detailsConsumers--;
      syncListeners();
    };
  }, []);
}
