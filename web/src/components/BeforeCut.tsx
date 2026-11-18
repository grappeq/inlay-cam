// What to do before a file is run, as a row of small marks: one for each
// kind of thing, with a card that shows it in a picture and says it.

import type { ReactNode } from "react";
import { Tip } from "./HelpTip";

/** A picture's frame, as the help cards have it: 160 by 90. */
function Frame(props: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 160 90" aria-hidden="true">
      {props.children}
    </svg>
  );
}

/** A mark's symbol: 16 by 16, drawn in the mark's colour. */
function Glyph({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** From the side: the board on a spoilboard, the tool going down past the board's bottom. */
const SPOILBOARD = (
  <Frame>
    <rect className="help-steel" x="10" y="58" width="140" height="18" />
    <path className="help-wood" d="M10 36H72V58H10Z" />
    <path className="help-wood" d="M88 36H150V58H88Z" />
    <path className="help-path" d="M80 12V63" />
    <text className="help-text" x="16" y="71">
      spoilboard
    </text>
  </Frame>
);

/** From above: the piece the cut frees, held to the board around it by strips of tape. */
const TAPE = (
  <Frame>
    <rect className="help-wood" x="10" y="8" width="140" height="74" />
    <rect className="help-path" x="48" y="24" width="64" height="42" rx="3" />
    <rect className="help-tape" x="34" y="32" width="92" height="9" />
    <rect className="help-tape" x="34" y="50" width="92" height="9" />
  </Frame>
);

/** From the side: a clamp on the board's edge, and the tool kept a distance from it. */
const CLAMPS = (
  <Frame>
    <rect className="help-wood" x="20" y="52" width="130" height="28" />
    <path className="help-steel" d="M6 40H40V52H18V84H6Z" />
    <path className="help-path" d="M84 14V52" />
    <path className="help-dim" d="M40 30V38M40 34H84M84 30V38" />
    <text className="help-text" x="46" y="28">
      clear
    </text>
  </Frame>
);

/** From above: the plug on its board, with wood left around it on every side. */
const BOARD = (
  <Frame>
    <rect className="help-wood" x="12" y="8" width="136" height="74" />
    <rect className="help-plug" x="40" y="26" width="80" height="38" />
    <path className="help-dim" d="M12 41V49M12 45H40M40 41V49" />
  </Frame>
);

interface Kind {
  title: string;
  /** What the app's sentence for it begins with. */
  begins: RegExp;
  glyph: string;
  picture?: ReactNode;
}

const KINDS: Kind[] = [
  { title: "Spoilboard", begins: /^Put a spoilboard/, glyph: "M2 5h12v3H2zM1 11h14v3H1z", picture: SPOILBOARD },
  { title: "Tape", begins: /^Hold .* down with tape/, glyph: "M2 11l9-9 3 3-9 9z", picture: TAPE },
  { title: "Clamps", begins: /^Keep clamps/, glyph: "M11 2H4v12h7M11 2v3M11 14v-3M8 8h5", picture: CLAMPS },
  { title: "Board size", begins: /^Use a board of at least/, glyph: "M2 3h12v10H2zM5 6h6v4H5z", picture: BOARD },
];
const OTHER: Kind = { title: "Before cutting", begins: /./, glyph: "M8 3v6M8 12v.5" };

/** A joined file says each thing after the name of the step it is for: `"Pocket 1: Put a spoilboard…"`. */
const bare = (text: string) => text.replace(/^[^:]{1,60}: (?=[A-Z])/, "");

export function BeforeCut({ texts }: { texts: string[] }) {
  if (texts.length === 0) return null;
  // One mark for each kind of thing, with what there is to say of it, each said once.
  const said = new Map<Kind, string[]>();
  for (const text of texts) {
    const sentence = bare(text);
    const kind = KINDS.find((k) => k.begins.test(sentence)) ?? OTHER;
    const list = said.get(kind) ?? [];
    if (!list.includes(sentence)) list.push(sentence);
    said.set(kind, list);
  }
  return (
    <span className="before-marks">
      Before cutting
      {[...said].map(([kind, sentences]) => (
        <Tip
          key={kind.title}
          className="before-mark"
          label={`Before cutting: ${kind.title}`}
          mark={<Glyph d={kind.glyph} />}
          entry={{ title: kind.title, text: sentences.join(" "), picture: kind.picture }}
        />
      ))}
    </span>
  );
}
