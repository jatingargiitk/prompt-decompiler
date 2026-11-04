#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { main, terminalReviewIO } from "./main.ts";

const argv = process.argv.slice(2);
const io = argv[0] === "review" ? terminalReviewIO() : undefined;
main(argv, {
  stdout: process.stdout,
  stderr: process.stderr,
  readStdin: () => readFileSync(0, "utf8"),
  env: process.env,
  ...(io ? { reviewIO: io } : {}),
}).then((code) => {
  process.exitCode = code;
  // readline keeps the process alive after review; nothing else is pending at this point.
  if (argv[0] === "review") process.stdin.destroy();
});
