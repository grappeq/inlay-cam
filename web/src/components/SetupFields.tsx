// The clearances and tabs, as three groups of fields. Used for one inlay in
// the design panel and for the defaults in the settings.

import type { Setup } from "../core/types";
import { SETUP_LIMITS, fmt } from "../state/model";
import { NumberField } from "./NumberField";

interface Props {
  setup: Setup;
  onChange: (change: Partial<Setup>) => void;
}

/** How high the tool travels, and from where it plunges slowly. */
export function HeightFields({ setup, onChange }: Props) {
  const [low, high] = SETUP_LIMITS.safeHeight;
  return (
    <div className="row setup-row">
      <NumberField
        label="Travel height"
        unit="mm"
        min={low}
        max={high}
        value={setup.safeHeight}
        // The plunge can never start above the height the tool travels at.
        onChange={(v) => v !== undefined && onChange({ safeHeight: v, plungeClearance: Math.min(setup.plungeClearance, v) })}
        hint="Above the board, between cuts. Raise it to clear clamps."
      />
      <NumberField
        label="Plunge from"
        unit="mm"
        min={SETUP_LIMITS.plungeClearance[0]}
        max={setup.safeHeight}
        value={setup.plungeClearance}
        onChange={(v) => v !== undefined && onChange({ plungeClearance: v })}
        hint="Above wood already cut. The tool drops fast to here, then goes down at the plunge feed."
      />
    </div>
  );
}

/** The tabs that hold a part to its board while it is cut out. */
export function TabFields({ setup, onChange }: Props) {
  const field = (key: "tabWidth" | "tabSpacing" | "tabThickness", label: string) => (
    <NumberField
      label={label}
      unit="mm"
      min={SETUP_LIMITS[key][0]}
      max={SETUP_LIMITS[key][1]}
      value={setup[key]}
      onChange={(v) => v !== undefined && onChange({ [key]: v })}
    />
  );
  return (
    <>
      <div className="row setup-row">
        {field("tabWidth", "Tab width")}
        {field("tabSpacing", "Tab spacing")}
        {field("tabThickness", "Tab thickness")}
      </div>
      <p className="hint">
        An outline gets a tab about every {fmt(setup.tabSpacing)} mm, and at least three, where it is long enough. A tab is never thicker than half
        the board.
      </p>
    </>
  );
}

/** How a part is cut free of its board. */
export function CutOutFields({ setup, onChange }: Props) {
  return (
    <div className="row setup-row">
      <NumberField
        label="Cut past the bottom"
        unit="mm"
        min={SETUP_LIMITS.throughCut[0]}
        max={SETUP_LIMITS.throughCut[1]}
        value={setup.throughCut}
        onChange={(v) => v !== undefined && onChange({ throughCut: v })}
        hint="Where a part is cut out of its board, into the spoilboard."
      />
      <NumberField
        label="Board around a cut-out plug"
        unit="mm"
        min={SETUP_LIMITS.cutOutBorder[0]}
        max={SETUP_LIMITS.cutOutBorder[1]}
        value={setup.cutOutBorder}
        onChange={(v) => v !== undefined && onChange({ cutOutBorder: v })}
        hint="Left on every side, beyond the cut."
      />
    </div>
  );
}
