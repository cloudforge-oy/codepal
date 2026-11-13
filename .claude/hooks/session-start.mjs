// SessionStart: remember the code state the session began with, so the Stop gate only
// demands a test report when this session actually changed something.
import fs from "node:fs";
import { readStdin, sessionDir, sessionFile, stateId } from "./lib.mjs";

const input = readStdin();
fs.mkdirSync(sessionDir, { recursive: true });
fs.writeFileSync(sessionFile(input.session_id), stateId() + "\n");
