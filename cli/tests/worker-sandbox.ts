import { sandboxFor } from "./sandboxes";

// Point this worker's CLI calls at its own sandbox (cli/tests/sandboxes.ts).
const { sandbox, keyring } = sandboxFor(Number(process.env.VITEST_POOL_ID ?? "1"));
process.env.ZIKI_CLI_SANDBOX = sandbox;
process.env.ZIKI_CLI_KEYRING = keyring;
