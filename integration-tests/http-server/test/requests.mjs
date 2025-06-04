import request from "supertest";
import * as assert from "node:assert";

const url = "http://localhost:3000";

describe("Requests", () => {
  it("responding with custom body", async () => {
    const res1 = await request(url).get('/');

    assert.equal(res1.status, 200);
    assert.equal(res1.text, 'Welcome!');
     
    const res2 = await request(url).get('/hello');
    
    assert.equal(res2.status, 200);
    assert.equal(res2.text, 'Hello to you too!');
  });

  it("responding with custom status", async () => {
    const res1 = await request(url).get("/");
    assert.equal(res1.status, 200);
    
    const res2 = await request(url).get("/not/found");
    assert.equal(res2.status, 404);
  });

  it("setting custom headers", async () => {
    const res = await request(url).get("/");
    const headerValue = res.headers["x-custom-header"];
    assert.equal(headerValue, "hey there");
  });

  it("responding to non-GET requests", async () => {
    const res1 = await request(url).post("/").send("some data");
    assert.equal(res1.headers["content-type"], "text/html");
    assert.equal(res1.text, "You posted: some data");

    const res2 = await request(url).put("/howdy");
    assert.equal(res2.headers["content-type"], "text/html");
    assert.equal(res2.text, "Not found: PUT http://localhost:3000/howdy");
  });

  // Can't actually test this because node:http doesn't support custom methods.
  // See https://github.com/nodejs/node-v0.x-archive/issues/3192
  // and https://github.com/nodejs/http-parser/issues/309
  // test("unknown http method", async ({ request }) => {
  //   let response = await request.fetch("/hello", { method: "FAKE" });
  //   await expect(await response.text()).toContain("UNKNOWN(FAKE) /howdy");
  // });

  it("handling json", async () => {
    const response = await request(url).post("/name").send({ name: "Jane" });
    assert.equal(response.text, "Hello, Jane");
  });

  it("responding to stream requests", async () => {
    const response = await request(url).post("/")
      .field("test.txt", Buffer.from("abc123"), { mimeType: "text/plain" });

    assert.equal(response.status, 200)
    assert.match(response.text, /test.txt/);
    assert.match(response.text, /abc123/);
  });

  it("handling unicode", async () => {
    const response = await request(url).post("/").send("snow ❄ flake");

    assert.equal(response.headers["content-type"], "text/html");
    assert.equal(response.text, "You posted: snow ❄ flake");
  });

  it("responding with bytes", async () => {
    const response = await request(url).get("/george.jpeg");

    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], "image/jpeg");
  });
});
