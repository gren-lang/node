/*

import Gren.Kernel.Scheduler exposing (binding, succeed, fail, rawSpawn)
import HttpServer exposing (ServerError, toRequest)
import HttpServer.Response as Response exposing (toResponse)
import Platform exposing (sendToApp, sendToSelf)

*/

const http = require("http");

var _HttpServer_createServer = F2(function (host, port) {
  return __Scheduler_binding(function (callback) {
    const server = http.createServer();
    server.on("error", function (e) {
      callback(
        __Scheduler_fail(A2(__HttpServer_ServerError, e.code, e.message))
      );
    });
    server.listen(port, host, function () {
      callback(__Scheduler_succeed(server));
    });
  });
});

var _HttpServer_addListener = F3(function (server, router, msg) {
  server.on("request", function (request, response) {
    // May want to support non-http protocols, proxies, and X-Forwarded-For header(s).
    // Note: the `request` here is a node `http.IncomingMessage`, not a `http.ClientRequest`,
    // so we can't just look at `request.protocol`, etc.
    let url = new URL(request.url, `http://${request.headers.host}`);
    let body = [];
    request
      .on("data", function (chunk) {
        body.push(chunk);
      })
      // TODO: Timeouts.
      // Currently, if the request never ends (because of an error, or...?)
      // the server will hang until manually killed.
      .on("end", function () {
        const buffer = Buffer.concat(body);
        let grenRequest = __HttpServer_toRequest({
          __$urlProtocol: url.protocol,
          __$urlHost: url.hostname,
          __$urlPort: url.port,
          __$urlPath: url.pathname,
          __$urlQuery: url.search,
          __$urlFragment: url.hash,
          __$headers: request.rawHeaders,
          __$method: request.method,
          __$body: new DataView(
            buffer.buffer,
            buffer.byteOffset,
            buffer.byteLength
          ),
        });
        let grenResponse = __Response_toResponse(response);
        __Scheduler_rawSpawn(
          // May want to send to self, self sends to app instead.
          // But effect handlers may be changing soon, so not bothering yet.
          A2(__Platform_sendToApp, router, A2(msg, grenRequest, grenResponse))
        );
      });
  });
});

var _HttpServer_removeAllListeners = function (server) {
  server.removeAllListeners("request");
};

var _HttpServer_setStatus = F2(function (status, res) {
  res.statusCode = status;
  return res;
});

var _HttpServer_setHeaders = F2(function (headers, res) {
  headers.forEach(function (h) {
    res.setHeader(h.__$key, h.__$value);
  });
  return res;
});

var _HttpServer_setBody = F2(function (body, res) {
  res.write(body);
  return res;
});

var _HttpServer_endResponse = function (res) {
  res.end();
  return {};
};
