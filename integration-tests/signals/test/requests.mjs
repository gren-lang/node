import * as path from "node:path";
import * as fs from "node:fs";
import { runner } from "clet";

const baseDir = path.resolve("bin");

describe("Signals", () => {
  it("Empty Event Loop", async () => {
    await runner()
      .cwd(baseDir)
      .fork("app", ["EmptyEventLoop"], {})
      .stdout("EmptyEventLoop")
      .code(100);
  });

  // TODO: How to test SIGINT and SIGTERM?
});
