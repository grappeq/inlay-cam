import { CoreClient } from "./coreClient";

export { CoreClient };

/** The one core worker shared by the whole app. */
export const core = new CoreClient(() => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }));
