import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };
import { identityPiTheme } from "./helpers/theme.js";

// pi loads the generated bundle, not src/, so the unit tests never execute what users
// run. These tests load dist/index.ts the way pi does: default-export factory first,
// config UI chunk only once `/footer` asks for it.

// A computed specifier keeps tsc from pulling the generated file into the program.
const DIST_ENTRY = new URL("../dist/index.ts", import.meta.url).href;

type Handler = (...args: unknown[]) => unknown;

interface Command {
  handler: (args: string, ctx: unknown) => Promise<void>;
}

function createFakePi() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const pi = {
    events: { on: () => {} },
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
    getSessionName: () => undefined,
    getThinkingLevel: () => "off",
    getActiveTools: () => [],
  };
  return { pi, handlers, commands };
}

function createFakeContext(custom: Handler) {
  const footers: unknown[] = [];
  const ctx = {
    hasUI: false,
    cwd: tmpdir(),
    model: undefined,
    modelRegistry: { isUsingOAuth: () => false },
    sessionManager: { getSessionId: () => "session", getBranch: () => [], getEntries: () => [] },
    getContextUsage: () => undefined,
    ui: {
      custom,
      notify: () => {},
      setFooter: (footer: unknown) => footers.push(footer),
      setStatus: () => {},
      theme: identityPiTheme,
    },
  };
  return { ctx, footers };
}

async function loadExtension() {
  const module = (await import(DIST_ENTRY)) as { default: (pi: unknown) => Promise<void> };
  const fake = createFakePi();
  await module.default(fake.pi);
  return fake;
}

describe("generated dist entry", () => {
  let tempDir: string;
  const originalConfigEnv = process.env.PI_FOOTER_CONFIG;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-footer-dist-"));
    process.env.PI_FOOTER_CONFIG = join(tempDir, "pi-footer.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (originalConfigEnv === undefined) delete process.env.PI_FOOTER_CONFIG;
    else process.env.PI_FOOTER_CONFIG = originalConfigEnv;
  });

  it("registers the command and lifecycle handlers", async () => {
    const { handlers, commands } = await loadExtension();

    expect([...commands.keys()]).toEqual(["footer"]);
    expect([...handlers.keys()].sort()).toEqual([
      "before_provider_request",
      "model_select",
      "session_shutdown",
      "session_start",
    ]);
  });

  it("loads the config UI chunk on /footer and renders the screen", async () => {
    const { commands } = await loadExtension();
    let rendered: string[] = [];
    let closed: unknown;
    const { ctx, footers } = createFakeContext(async (...args: unknown[]) => {
      const factory = args[0] as (...factoryArgs: unknown[]) => {
        render(width: number): string[];
        handleInput(data: string): void;
      };
      const tui = { requestRender: () => {}, terminal: { rows: 40 } };
      let result: unknown;
      const screen = factory(tui, identityPiTheme, undefined, (value: unknown) => {
        result = value;
      });
      rendered = screen.render(100);
      // Esc on a clean config closes the screen and resolves the overlay.
      screen.handleInput("\u001B");
      closed = result;
      return result;
    });

    await commands.get("footer")?.handler("", ctx);

    const screenText = rendered.join("\n");
    expect(screenText).toContain("Main Menu");
    // The bundle inlines only the version from package.json; it must stay current.
    expect(screenText).toContain(`v${packageJson.version}`);
    expect(closed).toMatchObject({ saved: false });
    // Closing the UI re-applies the config; without a UI that clears the footer.
    expect(footers.length).toBeGreaterThan(0);
    expect(footers.every((footer) => footer === undefined)).toBe(true);
  });
});
