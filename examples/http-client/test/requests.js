import * as path from "node:path";
import { runner, KEYS } from "clet";
import * as mockttp from "mockttp";

const server = mockttp.getLocal();
/* Enable for debugging
server.on("request", (data) => {
  console.log(data);
});
*/

const baseDir = path.resolve("bin");

describe("Requests", () => {
  before(() => server.start(8080));

  after(() => server.stop());

  it("Simple Get", async () => {
    await server.forGet("/mocked-path").thenReply(200, "A mocked response");

    await runner()
      .cwd(baseDir)
      .fork("app", ["simple get"], {})
      .stdout("200: A mocked response");
  });

  it("JSON Post Echo", async () => {
    await server
      .forPost("/mocked-path")
      .withHeaders({
        "Content-Type": "application/json",
        "Content-Length": "28",
      })
      .withJsonBody({ secret: "Hello, POST!" })
      .thenJson(200, { response: "Access Granted!" });

    await runner()
      .cwd(baseDir)
      .fork("app", ["post with body"], {})
      .stdout("200: Access Granted!");
  });

  it("Timeout", async () => {
    await server.forGet("/mocked-path").thenTimeout();

    await runner().cwd(baseDir).fork("app", ["timeout"], {}).stdout("Timeout");
  });

  it("Custom headers", async () => {
    await server
      .forPost("/mocked-path")
      .withHeaders({
        "Content-Type": "application/json",
        "X-Request-ID": "12345",
      })
      .withJsonBody({ message: "Check out my headers" })
      .thenJson(200, { response: "Nice headers" });

    await runner()
      .cwd(baseDir)
      .fork("app", ["headers"])
      .stdout("200: Nice headers");
  });
});
