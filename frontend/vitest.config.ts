import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

function findChromium(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cacheDir = join(homedir(), "Library", "Caches", "ms-playwright");
  if (existsSync(cacheDir)) {
    const dirs = readdirSync(cacheDir)
      .filter((d) => d.startsWith("chromium_headless_shell-"))
      .sort()
      .reverse();
    for (const d of dirs) {
      const candidate = join(
        cacheDir,
        d,
        "chrome-headless-shell-mac-arm64",
        "chrome-headless-shell",
      );
      if (existsSync(candidate)) return candidate;
    }
  }
  const sysChrome =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return existsSync(sysChrome) ? sysChrome : undefined;
}

const executablePath = findChromium();

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
      provider: playwright({ launchOptions: { executablePath } }),
      instances: [{ browser: "chromium" }],
    },
  },
});
