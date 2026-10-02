import { spawn } from "child_process";

const port = process.env.BLUFF_TEST_PORT || "18080";
const wsUrl = `ws://127.0.0.1:${port}`;
const healthUrl = `http://127.0.0.1:${port}/health`;

const server = spawn(process.execPath, ["index.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    PORT: port,
    HOST: "127.0.0.1",
    ENABLE_TEST_COMMANDS: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk.toString();
});

try {
  await waitForHealth();
  await runSmoke("scripts/smoke-online.mjs");
  await runSmoke("scripts/smoke-trump.mjs");
} finally {
  server.kill();
}

async function waitForHealth() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Deep smoke server exited early.\n${serverOutput}`);
    }
    try {
      const response = await fetch(healthUrl);
      const body = await response.json();
      if (response.ok && body.ok) return;
    } catch {
      // Server is still starting.
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${healthUrl}.\n${serverOutput}`);
}

function runSmoke(script) {
  return new Promise((resolve, reject) => {
    const smoke = spawn(process.execPath, [script], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        BLUFF_WS_URL: wsUrl,
        ENABLE_TEST_COMMANDS: "1",
      },
      stdio: "inherit",
    });
    smoke.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Deep smoke failed with exit code ${code}.`));
      }
    });
    smoke.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
