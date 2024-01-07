import * as path from "node:path";
import { runner, KEYS } from "clet";
import * as mockttp from "mockttp";

const server = mockttp.getLocal();

describe("Requests", () => {
  beforeEach(() => server.start(8080));
  afterEach(() => server.stop());

  it("Simple test", async () => {
    await server.forGet("/mocked-path").thenReply(200, "A mocked response");

    const baseDir = path.resolve("bin");
    await runner()
      .cwd(baseDir)
      .fork("app", [], {})
      .stdout("200: A mocked response");
  });
});
