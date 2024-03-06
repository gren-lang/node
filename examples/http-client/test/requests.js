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

  it("Byte response", async () => {
    const dataView = new DataView(new ArrayBuffer(8));
    dataView.setUint32(0, 42);
    dataView.setUint32(4, 24);

    await server
      .forGet("/mocked-path")
      .thenReply(200, new Uint8Array(dataView.buffer));

    await runner()
      .cwd(baseDir)
      .fork("app", ["bytes"], {})
      .stdout("200: 42 & 24");
  });

  it("Streaming request", async () => {
    await server
      .forPost("/mocked-path")
      // .withHeaders({
      //   "Content-Type": "application/octet-stream",
      // })
      .withJsonBody({ message: "Was chunked as bytes" })
      .thenJson(200, { response: "Nice headers" });

    await runner()
      .cwd(baseDir)
      .fork("app", ["stream"])
      .stdout("Streaming done!");
  });
});
