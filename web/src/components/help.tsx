// What the app explains on demand, in one place: each entry is what a "?"
// beside a field shows, a line or two with a small picture where a picture
// says more. A line that is always on screen reports something; what explains
// belongs here.

import type { ReactNode } from "react";

export interface HelpEntry {
  title: string;
  text: string;
  picture?: ReactNode;
}

/** A picture's frame: 160 by 90, drawn with the colours of the page. */
function Frame(props: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 160 90" aria-hidden="true">
      {props.children}
    </svg>
  );
}

/** From the side: the tool rises to the travel height, crosses over a clamp, and comes down. */
const TRAVEL = (
  <Frame>
    <rect className="help-wood" x="0" y="58" width="160" height="32" />
    <rect className="help-steel" x="68" y="44" width="22" height="14" rx="2" />
    <path className="help-level" d="M8 24H128" />
    <path className="help-path" d="M30 58V24H112V58" />
    <path className="help-dim" d="M133 24H139M136 24V58M133 58H139" />
    <text className="help-text" x="62" y="40">
      clamp
    </text>
  </Frame>
);

/** From the side, in a pocket half cut: fast down to the height above the wood, then at the plunge feed. */
const PLUNGE = (
  <Frame>
    <path className="help-wood" d="M0 40H44V64H112V40H160V90H0Z" />
    <path className="help-level" d="M44 52H112" />
    <path className="help-path fast" d="M72 6V52" />
    <path className="help-path" d="M72 52V76" />
    <path className="help-dim" d="M119 52H125M122 52V64M119 64H125" />
    <text className="help-text" x="78" y="26">
      fast
    </text>
    <text className="help-text on-wood" x="78" y="76">
      plunge feed
    </text>
  </Frame>
);

/** From the side: the tool goes down along its path at a slope, then back level. */
const RAMP = (
  <Frame>
    <rect className="help-wood" x="0" y="34" width="160" height="56" />
    <path className="help-path fast" d="M24 8V34" />
    <path className="help-path" d="M24 34L136 58H24" />
    <path className="help-dim" d="M70 34A46 46 0 0 1 69 43.6" />
    <text className="help-text" x="30" y="22">
      down along the path
    </text>
  </Frame>
);

/** In section: a thin layer left on the wall beside the tool. */
const FINISH = (
  <Frame>
    <path className="help-wood" d="M0 16H64V66H160V90H0Z" />
    <rect className="help-left" x="64" y="16" width="9" height="50" />
    <rect className="help-steel" x="73" y="0" width="26" height="66" />
    <text className="help-text" x="104" y="34">
      left on
    </text>
    <text className="help-text" x="104" y="46">
      the wall
    </text>
  </Frame>
);

/** From above: the cut round a part, with bridges of wood left across it. */
const TABS = (
  <Frame>
    <rect className="help-wood" x="0" y="0" width="160" height="90" />
    <rect className="help-tabs" x="25" y="20" width="110" height="50" rx="8" />
    <rect className="help-slot" x="25" y="20" width="110" height="50" rx="8" pathLength="100" />
    <text className="help-text on-wood" x="80" y="49" textAnchor="middle">
      from above
    </text>
  </Frame>
);

/** In section, a narrow ridge of the plug: filling its pocket to the bottom, and cut back to leave room for glue. */
const RELIEF = (
  <Frame>
    <path className="help-wood" d="M2 34H16L40 76L64 34H78V88H2Z" />
    <path className="help-plug" d="M8 18H72V34H62L40 76L18 34H8Z" />
    <text className="help-text" x="40" y="11" textAnchor="middle">
      without
    </text>
    <g transform="translate(80 0)">
      <path className="help-wood" d="M2 34H16L40 76L64 34H78V88H2Z" />
      <path className="help-plug" d="M8 14H72V34H64L46 64H34L16 34H8Z" />
      <circle className="help-glue" cx="40" cy="69" r="3" />
      <text className="help-text" x="40" y="9" textAnchor="middle">
        relieved
      </text>
    </g>
  </Frame>
);

/** In section: the floor a V-bit's tip leaves, with a ridge between each pass and the next. */
const RIDGES = (
  <Frame>
    <path className="help-wood" d="M0 50Q20 62 40 50Q60 62 80 50Q100 62 120 50Q140 62 160 50V90H0Z" />
    <path className="help-steel" d="M28 0L58 54H62L92 0Z" />
    <path className="help-dim" d="M97 50H109M103 50V56M97 56H109" />
    <text className="help-text" x="114" y="44">
      ridge
    </text>
  </Frame>
);

/** How far in from the wall each pass of a 45° chamfer reaches at the surface: what the core plans for a 2.5 mm bevel on a 0.5 mm stepdown, drawn 24 to the mm. */
const PASS_REACH = [7, 19, 28, 34, 40, 45, 49, 53, 57, 60];

/** In section: the wood a chamfer's passes take, each a band; deep at first, thinner as the bevel widens. */
const PASSES = (
  <Frame>
    <path className="help-wood" d="M0 22H52L112 82V90H0Z" />
    {PASS_REACH.map((u, k) => {
      const v = k === 0 ? 0 : PASS_REACH[k - 1];
      return <path key={u} className={`help-band${k % 2 ? " alt" : ""}`} d={`M${112 - u} 22L112 ${22 + u}V${22 + v}L${112 - v} 22Z`} />;
    })}
    <path className="help-level" d="M112 22V90" />
    <text className="help-text" x="117" y="34">
      first
    </text>
    <text className="help-text" x="117" y="80">
      last
    </text>
  </Frame>
);

export const HELP = {
  // Clearances and tabs: keyed as the setup's own fields are.
  safeHeight: { title: "Travel height", text: "How high above the board the tool moves between cuts. Raise it to clear clamps.", picture: TRAVEL },
  plungeClearance: { title: "Plunge from", text: "The tool drops fast to this height above wood already cut, then goes down at the plunge feed.", picture: PLUNGE },
  rampAngle: {
    title: "Ramp angle",
    text: "An end mill goes down into wood along its path at this slope. 0 plunges straight down. V-bits and corner-rounding bits are not affected.",
    picture: RAMP,
  },
  finishAllowance: { title: "Left for a finishing pass", text: "Left on walls and edges while cutting down, and taken off in one light pass at the end. 0 for none.", picture: FINISH },
  throughCut: { title: "Cut past the bottom", text: "How far into the spoilboard the tool goes where a cut goes right through." },
  cutOutBorder: { title: "Board around a cut-out plug", text: "Left on every side, beyond the cut." },
  tabs: {
    title: "Tabs",
    text: "Bridges of wood that hold a part to its board until you cut it free. An outline gets one about every spacing, and at least three where it is long enough. A tab is never thicker than half the board.",
    picture: TABS,
  },

  // A V-carve inlay.
  relief: {
    title: "Relieving the plug",
    text: "Where a shape is narrow, and into every corner, the plug comes to a point that fills the pocket to the bottom: no room for glue, and the point holds the plug up. Relieving cuts those points back by the glue gap.",
    picture: RELIEF,
  },
  floorRidge: { title: "Ridges on the floor", text: "Between the V-bit's passes on a flat floor. Lower is smoother and takes longer.", picture: RIDGES },
  reliefKeep: { title: "Relief stays below the face", text: "Lower relieves more of a narrow ridge, and may show after sanding." },
  trimDepth: { title: "Where the fit check judges the face", text: "Below the surface: about what you sand off once the plug is in." },

  // Other operations, and steps done by hand.
  chamferPasses: {
    title: "Passes",
    text: "No pass goes deeper than the cutting row's stepdown, or takes more wood than a full groove that deep: the cut the row is set for. The edge widens as it deepens, so the passes get shallower going down. A bevel wider than the bit's flank is cut in layers from the top, stepping out to the edge. A deeper stepdown in the row gives fewer passes.",
    picture: PASSES,
  },
  facingDepth: { title: "Depth below the surface", text: "How far under the stock's surface the facing goes. Under 0, it stops that far above the surface and leaves the wood proud." },
  byHand: { title: "A step done by hand", text: "Its place in the list is what counts: the steps below it find the stock as this one leaves it. Drag it in the list to move it." },

  // Settings: the columns of the materials and profiles.
  materialKey: { title: "Key", text: "What files call the material. It never changes, also when the material is renamed." },
  materialFeedsAs: {
    title: "Suggestions as",
    text: "Which material the feeds model takes it for, so that a tool's sheet can suggest starting values and place its rows. It changes nothing else.",
  },
  
  profileStart: { title: "Suggestions start at", text: "The stop the suggestion on a tool's sheet begins at for this profile's rows. It changes no row and no file." },
  profileCut: { title: "Cut", text: "How this profile's rows are cut, which shapes what is suggested for them. It changes no row and no file." },
  
} satisfies Record<string, HelpEntry>;

export type HelpTopic = keyof typeof HELP;
