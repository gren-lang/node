import * as path from "node:path";
import { runner, KEYS } from "clet";
import * as mockttp from "mockttp";

const server = mockttp.getLocal();

describe("Requests", () => {
  beforeEach(() => server.start(8080));
  afterEach(() => server.stop());

  it("Simple Get", async () => {
    await server.forGet("/mocked-path").thenReply(200, "A mocked response");

    const baseDir = path.resolve("bin");
    await runner()
      .cwd(baseDir)
      .fork("app", ["simple get"], {})
      .stdout("200: A mocked response");
  });
  
  it("JSON Post Echo", async () => {
    await server.forPost("/mocked-path")
      .withJsonBody({ secret: "Hello, POST!" })
      .thenReply(200, "Access Granted!");

    const baseDir = path.resolve("bin");
    await runner()
      .cwd(baseDir)
      .fork("app", ["post with body"], {})
      .stdout("200: Access Granted!");
  });
});
