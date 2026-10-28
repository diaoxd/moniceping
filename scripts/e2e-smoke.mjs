import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const port = Number(process.env.E2E_PORT || 4197);
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, PORT: String(port), APP_DATABASE: `/tmp/trainer-e2e-${process.pid}.db`, MARKET_DATABASE: "/tmp/nonexistent-market.db" },
  stdio: ["ignore", "pipe", "pipe"],
});

const base = `http://127.0.0.1:${port}`;
async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("服务启动超时");
}

try {
  await waitForServer();
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.status, "ok");
  const history = await (await fetch(`${base}/api/random-training-sessions?limit=5&offset=0`)).json();
  assert.deepEqual(history.items, []);
  assert.equal(history.total, 0);
  const page = await fetch(`${base}/history.html`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /历史训练/);
  const panelScript = await fetch(`${base}/trade-panel-tabs.js`);
  assert.equal(panelScript.status, 200);
  assert.match(await panelScript.text(), /equity-curve/);
  const invalid = await fetch(`${base}/api/random-training-sessions?status=bad`);
  assert.equal(invalid.status, 422);
  console.log("E2E smoke passed");
} finally {
  child.kill("SIGTERM");
}
