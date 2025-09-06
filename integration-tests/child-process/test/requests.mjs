import * as path from "node:path";
import { runner } from "clet";

const baseDir = path.resolve("bin");

describe("ChildProcess", () => {
  it("With Shell", async () => {
    await runner()
      .cwd(baseDir)
      .fork("app", ["ExecShell"], {})
      .stdout(process.version);
  });

  it("No Shell", async () => {
    await runner()
      .cwd(baseDir)
      .fork("app", ["Exec"], {})
      .stdout(process.version);
  });
});
