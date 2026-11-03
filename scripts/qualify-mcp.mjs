import { qualifyMcp } from "../src/cli/qualify-mcp.ts";

process.exit(await qualifyMcp(process.argv.slice(2)));
