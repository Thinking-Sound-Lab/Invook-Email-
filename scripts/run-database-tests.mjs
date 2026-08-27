import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const mode = process.argv[2];
if (mode !== "unit" && mode !== "integration") {
  throw new Error("Database test mode must be unit or integration.");
}
if (mode === "integration" && !process.env.TEST_DATABASE_URL?.trim()) {
  console.error(
    "TEST_DATABASE_URL is required for the database integration verification gate.",
  );
  process.exit(1);
}

const sourceDirectory = resolve(process.cwd(), "src");
const testFiles = (await readdir(sourceDirectory))
  .filter((filename) => filename.endsWith(".test.ts"))
  .filter((filename) =>
    mode === "integration"
      ? filename.endsWith(".integration.test.ts")
      : !filename.endsWith(".integration.test.ts"),
  )
  .sort()
  .map((filename) => resolve(sourceDirectory, filename));

if (testFiles.length === 0) {
  throw new Error(`No database ${mode} tests were found.`);
}

const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", ...testFiles],
  { env: process.env, stdio: "inherit" },
);
child.once("error", (error) => {
  console.error("Database tests could not start.", { name: error.name });
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (signal) {
    console.error("Database tests were interrupted.", { signal });
    process.exit(1);
  }
  process.exit(code ?? 1);
});
