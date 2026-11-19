#!/usr/bin/env node
import { main } from "../src/main.js";

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`inlay-cam-mcp: ${e?.message ?? e}\n`);
  process.exit(1);
});
