import { useFileActions } from "../state/files";
import { message, useApp, useDispatch } from "../state/store";
import { ReportNotes, useImportSvg } from "./DesignPanel";

/** What a project without a drawing shows: the way from tools to files, and where the user is on it. */
export function StartGuide() {
  const { tools, importReport } = useApp();
  const dispatch = useDispatch();
  const importSvg = useImportSvg();
  const files = useFileActions();

  const endMills = tools.filter((t) => t.kind === "flat_end").length;
  const vBits = tools.filter((t) => t.kind === "v_bit").length;
  const unset = tools.filter((t) => t.cutting.length === 0).length;
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  const trySample = async () => {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}samples/sample.svg`);
      if (!response.ok) throw new Error("The sample drawing could not be loaded.");
      await files.importSvg({ name: "sample.svg", text: await response.text() });
    } catch (e) {
      dispatch({ type: "notice", notice: { kind: "error", text: message(e) } });
    }
  };

  return (
    <main className="start">
      <h1>From a drawing to two files that fit</h1>
      <p className="start-lead">
        This app turns the shapes of an SVG or DXF drawing into G-code for a Carvera Air: one file for the pocket, one for the piece that fills it. It
        simulates both before you cut.
      </p>
      <ol className="steps">
        <li className={tools.length > 0 ? "done" : ""}>
          <h2>List your tools</h2>
          <p>
            {tools.length === 0
              ? "The app needs to know your end mills and V-bits, and how fast to run them."
              : `You have ${count(endMills, "end mill", "end mills")} and ${count(vBits, "V-bit", "V-bits")}.${
                  unset > 0 ? ` ${count(unset, "tool has", "tools have")} no cutting settings yet.` : ""
                }`}
          </p>
          <button className={tools.length === 0 ? "primary" : ""} onClick={() => dispatch({ type: "setView", view: "tools" })}>
            {tools.length === 0 ? "Add tools" : "Open tool list"}
          </button>
        </li>
        <li>
          <h2>Bring in a drawing</h2>
          <p>
            An SVG or DXF file with filled shapes, or lines that join into closed outlines. Convert text to outlines first. You can also drop the
            file anywhere on this window.
          </p>
          {importReport && <ReportNotes report={importReport} />}
          <div className="row start-actions">
            <button className={tools.length > 0 ? "primary" : ""} onClick={importSvg}>
              Import drawing…
            </button>
            <button onClick={trySample}>Try the sample drawing</button>
          </div>
        </li>
        <li>
          <h2>Pick shapes and choose the inlay</h2>
          <p>Click the shapes that will be one wood. Choose a V-carve inlay for sharp detail, or a flat inlay for simple shapes.</p>
        </li>
        <li>
          <h2>Generate, check, download</h2>
          <p>See each part in 3D, read how the two will fit, then download the files for the machine.</p>
        </li>
      </ol>
    </main>
  );
}
