/*

import Gren.Kernel.Scheduler exposing (binding, succeed, fail)
import HttpClient exposing (Error)
import Json.Decode as Decode exposing (decodeString)
import Result exposing (isOk)

*/

const http = require("http");

var _HttpClient_request = function (config) {
  return __Scheduler_binding(function (callback) {
    const req = http.request(
      config.__$url,
      {
        method: config.__$method,
      },
      (res) => {
        const statusCode = res.statusCode;
        if (statusCode < 200 || statusCode >= 300) {
          return callback(
            __Scheduler_fail(
              __HttpClient_Error("bad status code: " + statusCode)
            )
          );
        }

        res.setEncoding("utf8");

        let rawData = "";

        res.on("data", (chunk) => {
          rawData += chunk;
        });

        res.on("end", () => {
          switch (config.__$expectType) {
            case "NOTHING":
              if (rawData === "") {
                return callback(__Scheduler_succeed({}));
              } else {
                return callback(
                  __Scheduler_fail(
                    __HttpClient_Error(
                      "Expected empty response, but got: " + rawData
                    )
                  )
                );
              }

            case "ANYTHING":
              return callback(__Scheduler_succeed({}));

            case "STRING":
              return callback(__Scheduler_succeed(rawData));

            case "JSON":
              const jsonResult = A2(
                __Decode_decodeString,
                config.__$expect.a,
                rawData
              );
              if (__Result_isOk(jsonResult)) {
                return callback(__Scheduler_succeed(jsonResult.a));
              } else {
                return callback(
                  __Scheduler_fail(
                    __HttpClient_Error("Failed to decode json response")
                  )
                );
              }
          }
        });
      }
    );

    req.on("error", (e) => {
      return callback(
        __Scheduler_fail(
          __HttpClient_Error("problem with request: " + e.message)
        )
      );
    });

    const body = _HttpClient_extractRequestBody(config);
    if (body !== null) {
      req.write(body);
    }

    req.end();
  });
};

var _HttpClient_extractRequestBody = function (config) {
  switch (config.__$bodyType) {
    case "EMPTY":
      return null;
    case "STRING":
      return config.__$body.a;
  }
};
