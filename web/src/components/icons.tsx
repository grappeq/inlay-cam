// Small line drawings: one per kind of step, and those of the editing
// toolbar and its drawing tools. Drawn on a 20 x 20 grid in the colour of the text around them.

import type { ReactNode } from "react";
import type { StepType } from "../core/types";

function Icon({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {children}
    </svg>
  );
}

/** The wood that is left, in a cross-section. */
const WOOD = { fill: "currentColor", fillOpacity: 0.16 };

const STEP_ICONS: Record<StepType, ReactNode> = {
  // Cross-sections through the stock: what the cut leaves.
  vcarve: (
    <>
      <path d="M1.5 5.5H5l5 9 5-9h3.5V18h-17z" {...WOOD} stroke="none" />
      <path d="M1.5 5.5H5l5 9 5-9h3.5" />
      <path d="M6.2 3.2h7.6L10 10z" fill="currentColor" stroke="none" />
    </>
  ),
  flat: (
    <>
      <path d="M1.5 5.5H5V13h10V5.5h3.5V18h-17z" {...WOOD} stroke="none" />
      <path d="M1.5 5.5H5V13h10V5.5h3.5" />
      <rect x="6.6" y="3.2" width="6.8" height="8.2" fill="currentColor" stroke="none" />
    </>
  ),
  pocket: (
    <>
      <path d="M1.5 5.5H5V13h10V5.5h3.5V18h-17z" {...WOOD} stroke="none" />
      <path d="M1.5 5.5H5V13h10V5.5h3.5" />
    </>
  ),
  // From above: the tool on its way round a shape.
  contour: (
    <>
      <rect x="5" y="5" width="10" height="10" rx="2" {...WOOD} stroke="none" />
      <rect x="2.5" y="2.5" width="15" height="15" rx="4" strokeDasharray="2.6 2.6" />
      <circle cx="17.5" cy="10" r="2" fill="currentColor" stroke="none" />
    </>
  ),
  // A cross-section through an edge, bevelled.
  chamfer: (
    <>
      <path d="M2 18V9.5L8.5 3H18v15z" {...WOOD} stroke="none" />
      <path d="M2 18V9.5" />
      <path d="M8.5 3H18" />
      <path d="M2 9.5L8.5 3" strokeWidth="2.6" />
    </>
  ),
  // From above: straight passes back and forth over the stock.
  facing: (
    <>
      <rect x="2" y="3" width="16" height="14" rx="1.5" {...WOOD} stroke="none" />
      <path d="M4 6h12v4H4v4h12" />
      <path d="M13.5 12l2.5 2-2.5 2" />
    </>
  ),
  // In section: the plug, turned over, going down into its pocket.
  glue: (
    <>
      <path d="M1.5 11.5H5l1.5 4h7l1.5-4h3.5V18h-17z" {...WOOD} stroke="none" />
      <path d="M1.5 11.5H5l1.5 4h7l1.5-4h3.5" />
      <path d="M4 2.5h12v3h-2.2L12.6 9H7.4L6.2 5.5H4z" fill="currentColor" stroke="none" />
    </>
  ),
};

/** The symbol of a kind of inlay or operation. */
export function StepIcon({ type }: { type: StepType }) {
  return <Icon>{STEP_ICONS[type]}</Icon>;
}

/** A corner rounded over instead of bevelled: a chamfer cut with a corner-rounding bit. */
export function FilletIcon() {
  return (
    <Icon>
      <path d="M2 18V10a7 7 0 0 1 7-7h9v15z" {...WOOD} stroke="none" />
      <path d="M9 3h9" />
      <path d="M2 18v-8" />
      <path d="M2 10a7 7 0 0 1 7-7" strokeWidth="2.6" />
    </Icon>
  );
}

const ARRANGE_ICONS = {
  undo: <path d="M7 5L3 9l4 4M3 9h9a5 5 0 0 1 0 10h-2" transform="translate(0 -2)" />,
  redo: <path d="M13 5l4 4-4 4M17 9H8a5 5 0 0 0 0 10h2" transform="translate(0 -2)" />,
  turnLeft: (
    <>
      <path d="M4 9a6 6 0 1 1 2 6.5" />
      <path d="M4 4.5V9h4.5" />
    </>
  ),
  turnRight: (
    <>
      <path d="M16 9a6 6 0 1 0-2 6.5" />
      <path d="M16 4.5V9h-4.5" />
    </>
  ),
  mirrorX: (
    <>
      <path d="M10 2v16" strokeDasharray="2 2.4" />
      <path d="M7.5 5.5L2.5 14.5h5z" />
      <path d="M12.5 5.5l5 9h-5z" fill="currentColor" fillOpacity="0.3" />
    </>
  ),
  mirrorY: (
    <>
      <path d="M2 10h16" strokeDasharray="2 2.4" />
      <path d="M5.5 7.5l9-5v5z" />
      <path d="M5.5 12.5l9 5v-5z" fill="currentColor" fillOpacity="0.3" />
    </>
  ),
  centreX: (
    <>
      <path d="M10 2v16" />
      <rect x="4" y="5" width="12" height="4" rx="1" fill="currentColor" fillOpacity="0.3" />
      <rect x="6.5" y="11.5" width="7" height="4" rx="1" fill="currentColor" fillOpacity="0.3" />
    </>
  ),
  centreY: (
    <>
      <path d="M2 10h16" />
      <rect x="5" y="4" width="4" height="12" rx="1" fill="currentColor" fillOpacity="0.3" />
      <rect x="11.5" y="6.5" width="4" height="7" rx="1" fill="currentColor" fillOpacity="0.3" />
    </>
  ),
  copy: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M13 4.5V4a1.5 1.5 0 0 0-1.5-1.5h-7A1.5 1.5 0 0 0 3 4v7a1.5 1.5 0 0 0 1.5 1.5H5" />
    </>
  ),
  keep: (
    <>
      <rect x="6" y="6" width="8" height="8" rx="1" fill="currentColor" fillOpacity="0.3" />
      <path d="M2.5 6V2.5H6M14 2.5h3.5V6M17.5 14v3.5H14M6 17.5H2.5V14" />
    </>
  ),
  remove: (
    <>
      <path d="M3.5 5.5h13M8 5.5V3.5h4v2M5.5 5.5l.8 11h7.4l.8-11" />
      <path d="M8.5 8.5v5M11.5 8.5v5" />
    </>
  ),
  add: (
    <>
      <path d="M4 3h8l4 4v10H4z" />
      <path d="M10 9v6M7 12h6" />
    </>
  ),
  edit: (
    <>
      <path d="M3 17l1-4.2L13.8 3 17 6.2 7.2 16z" />
      <path d="M11.6 5.2l3.2 3.2" />
    </>
  ),
  rectangle: <rect x="2.5" y="5" width="15" height="10" rx="1.5" fill="currentColor" fillOpacity="0.16" />,
  ellipse: <ellipse cx="10" cy="10" rx="7.5" ry="5.5" fill="currentColor" fillOpacity="0.16" />,
  polygon: <path d="M10 2.5l6.5 3.75v7.5L10 17.5l-6.5-3.75v-7.5z" fill="currentColor" fillOpacity="0.16" />,
  pick: <path d="M5 3l9.5 7.5-4.2.6 2.6 5-1.8.9-2.5-5L5 15z" />,
  grip: (
    <>
      <circle cx="7.5" cy="5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="7.5" cy="10" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="10" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="7.5" cy="15" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="15" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
} as const;

export type ToolIconName = keyof typeof ARRANGE_ICONS;

/** A symbol of the drawing's toolbars. */
export function ToolIcon({ name }: { name: ToolIconName }) {
  return <Icon>{ARRANGE_ICONS[name]}</Icon>;
}
