import { describe, expect, test } from "bun:test";

describe("package manifest", () => {
  test("ships setup entry when openclaw.setupEntry is declared", async () => {
    const packageJson = (await Bun.file(
      new URL("../package.json", import.meta.url),
    ).json()) as {
      openclaw?: { setupEntry?: string };
      files?: string[];
    };

    const setupEntry = packageJson.openclaw?.setupEntry;
    expect(setupEntry).toBe("./setup-entry.ts");
    expect(packageJson.files).toContain("setup-entry.ts");
  });
});
