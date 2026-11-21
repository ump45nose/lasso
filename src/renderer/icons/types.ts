import type { JSX } from 'react';

/** Sketch bodies drawn on a 24×24 grid. Plain children are ink strokes (currentColor);
 *  `ska` = accent stroke, `skf` = accent fill, `skm` = wide translucent accent marker drawn behind the ink. */
export type SketchSet = Record<string, JSX.Element>;
