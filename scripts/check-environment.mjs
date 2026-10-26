import { execFileSync } from "node:child_process";

const requiredNodeMajor = 22;
const requiredPython = { major: 3, minor: 12 };

function fail(message) {
  console.error(`环境检查失败：${message}`);
  process.exitCode = 1;
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor !== requiredNodeMajor) {
  fail(`需要 Node.js 22，当前为 ${process.versions.node}`);
} else {
  console.log(`Node.js ${process.versions.node}：通过`);
}

let pythonVersion;
try {
  pythonVersion = execFileSync("python", ["--version"], { encoding: "utf8" }).trim();
} catch {
  try {
    pythonVersion = execFileSync("python3", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    fail("未找到 Python 3.12");
  }
}

if (pythonVersion) {
  const match = pythonVersion.match(/Python (\d+)\.(\d+)\.(\d+)/);
  if (!match || Number(match[1]) !== requiredPython.major || Number(match[2]) !== requiredPython.minor) {
    fail(`需要 Python 3.12，当前为 ${pythonVersion}`);
  } else {
    console.log(`${pythonVersion}：通过`);
  }
}

try {
  await import("node:sqlite");
  console.log("node:sqlite：通过");
} catch {
  fail("当前 Node.js 不支持 node:sqlite");
}
