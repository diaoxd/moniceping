import { spawnSync } from "node:child_process";

const candidates = process.platform === "win32" ? ["python", "py"] : ["python", "python3"];
for (const command of candidates) {
  const result = spawnSync(command, ["-m", "unittest", "discover", "-s", "tools/market_data/tests", "-p", "test_*.py"], {
    stdio: "inherit",
    shell: false,
  });
  if (result.error?.code === "ENOENT") continue;
  process.exitCode = result.status ?? 1;
  process.exit();
}

console.error("未找到 Python 解释器，请安装 Python 3.12 并加入 PATH");
process.exitCode = 1;
