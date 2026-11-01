#!/usr/bin/env node
/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = join(ROOT, "frontend", "dist");
const OUT_DIR = join(ROOT, "docs", "screenshots");

const require = createRequire(join(ROOT, "frontend", "package.json"));
const { chromium } = require("playwright");

function findChromium() {
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

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

function startStaticServer(rootDir) {
  return new Promise((resolveServer) => {
    const srv = createServer((req, res) => {
      const urlPath = (req.url ?? "/").split("?")[0];
      const rel = urlPath === "/" ? "/index.html" : urlPath;
      const filePath = join(rootDir, rel);
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ext = extname(filePath);
      res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
      res.end(readFileSync(filePath));
    });
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      resolveServer({ srv, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function main() {
  if (!existsSync(join(DIST_DIR, "index.html"))) {
    console.log("==> Building frontend/dist...");
    execFileSync("npm", ["run", "build"], {
      cwd: join(ROOT, "frontend"),
      stdio: "inherit",
    });
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const { srv, url } = await startStaticServer(DIST_DIR);

  const browser = await chromium.launch({
    headless: true,
    executablePath: findChromium(),
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    const scenes = [
      {
        name: "activity",
        query: "?section=overview&task=gemini-a1b2c3",
        setup: async () => {},
      },
      {
        name: "topology",
        query: "?section=topology",
        setup: async () => {},
      },
      {
        name: "designer",
        query: "?section=designer",
        setup: async (p) => {
          await p.evaluate(async () => {
            const app = document.querySelector("ax-central");
            if (app?.host) {
              await app.host.call(
                "load_template",
                { template: "genkit-apple-container" },
                new AbortController().signal,
              );
            }
          });
        },
      },
      {
        name: "terminal",
        query: "?section=overview",
        setup: async (p) => {
          await p.evaluate(async () => {
            const sessionCbs = new Set();
            const origOnData = window.studio.onSessionData.bind(window.studio);
            window.studio.onSessionData = (cb) => {
              sessionCbs.add(cb);
              const off = origOnData(cb);
              return () => {
                sessionCbs.delete(cb);
                off();
              };
            };
            window.studio.startSession = async (req) => {
              setTimeout(() => {
                for (const cb of sessionCbs) {
                  cb({
                    id: req.id,
                    stream: "stdout",
                    data:
                      "\x1b[32mroot@ate-default-gemini-a1b2c3\x1b[0m:\x1b[34m/workspace\x1b[0m# uname -sm\r\n" +
                      "Linux aarch64\r\n" +
                      "\x1b[32mroot@ate-default-gemini-a1b2c3\x1b[0m:\x1b[34m/workspace\x1b[0m# ls -la /workspace\r\n" +
                      "total 16\r\n" +
                      "drwxr-xr-x 4 root root 4096 Nov  1 12:00 .\r\n" +
                      "-rw-r--r-- 1 root root  312 Nov  1 12:00 AGENTS.md\r\n" +
                      "-rw-r--r-- 1 root root  548 Nov  1 12:00 README.md\r\n" +
                      "-rw-r--r-- 1 root root  410 Nov  1 12:00 retry_test.go\r\n" +
                      "\x1b[32mroot@ate-default-gemini-a1b2c3\x1b[0m:\x1b[34m/workspace\x1b[0m# ",
                  });
                }
              }, 30);
            };
            const app = document.querySelector("ax-central");
            const navItems = app?.shadowRoot?.querySelectorAll(".nav-item");
            for (const btn of navItems ?? []) {
              if (btn.textContent?.includes("Terminal")) btn.click();
            }
            await new Promise((r) => setTimeout(r, 80));
            const termView = app?.shadowRoot?.querySelector("ax-terminal");
            const taskBtn = termView?.shadowRoot?.querySelector(".terminal-task");
            taskBtn?.click();
            await new Promise((r) => setTimeout(r, 150));
          });
        },
      },
      {
        name: "clusters",
        query: "?section=clusters",
        setup: async () => {},
      },
      {
        name: "webmcp",
        query: "?section=overview",
        setup: async (p) => {
          await p.evaluate(async () => {
            const app = document.querySelector("ax-central");
            if (app?.host) {
              const sig = new AbortController().signal;
              await app.host.call("list_tasks", {}, sig);
              await app.host.call("check_prerequisites", {}, sig);
            }
            const badge = app?.shadowRoot?.querySelector(
              ".webmcp-btn, .webmcp-badge",
            );
            badge?.click();
          });
        },
      },
    ];

    for (const scene of scenes) {
      await page.goto(`${url}/${scene.query}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(300);
      await scene.setup(page);
      await page.waitForTimeout(250);

      for (const theme of ["light", "dark"]) {
        await page.evaluate((t) => {
          document.documentElement.dataset.theme = t;
        }, theme);
        await page.waitForTimeout(150);

        const pngPath = join(OUT_DIR, `${scene.name}-${theme}.png`);
        const webpPath = join(OUT_DIR, `${scene.name}-${theme}.webp`);
        await page.screenshot({ path: pngPath });
        execFileSync("cwebp", ["-quiet", "-q", "90", pngPath, "-o", webpPath]);
        unlinkSync(pngPath);
        console.log(`  ✓ ${scene.name}-${theme}.webp`);
      }
    }
  } finally {
    await browser.close();
    srv.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
