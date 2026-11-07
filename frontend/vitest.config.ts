import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

function findChromium(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cacheDirs = [
    join(homedir(), "Library", "Caches", "ms-playwright"),
    join(homedir(), ".cache", "ms-playwright"),
  ];
  const archDirs = [
    "chrome-headless-shell-mac-arm64",
    "chrome-headless-shell-mac-x64",
    "chrome-headless-shell-linux64",
    "chrome-headless-shell-linux-arm64",
  ];
  for (const cacheDir of cacheDirs) {
    if (!existsSync(cacheDir)) continue;
    const dirs = readdirSync(cacheDir)
      .filter((d) => d.startsWith("chromium_headless_shell-"))
      .sort()
      .reverse();
    for (const d of dirs) {
      for (const archDir of archDirs) {
        const candidate = join(cacheDir, d, archDir, "chrome-headless-shell");
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  const sysChrome =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return existsSync(sysChrome) ? sysChrome : undefined;
}

const executablePath = findChromium();
const launchEnv = executablePath
  ? {
      ...(process.env as Record<string, string>),
      LD_LIBRARY_PATH: [dirname(executablePath), process.env.LD_LIBRARY_PATH]
        .filter(Boolean)
        .join(":"),
    }
  : undefined;

export default defineConfig({
  server: { fs: { allow: [".", realpathSync("node_modules")] } },
  optimizeDeps: {
    include: [
      "axe-core",
      "lit",
      "lit/decorators.js",
      "yaml",
      "@xterm/xterm",
      "@xterm/addon-fit",
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 60000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({
        launchOptions: { executablePath, env: launchEnv },
      }),
      instances: [{ browser: "chromium" }],
    },
  },
});
