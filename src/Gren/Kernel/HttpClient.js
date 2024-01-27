/*

import Gren.Kernel.Scheduler exposing (binding, succeed, fail)
import HttpClient exposing (Timeout, UnknownError)
import Json.Decode as Decode exposing (decodeString)
import Result exposing (isOk)
import Maybe exposing (isJust)
import Dict exposing (foldl)

*/

const http = require("http");

var _HttpClient_dictToObject = F3(function (key, value, obj) {
  obj[key] = value;
  return obj;
});

var _HttpClient_request = function (config) {
  return __Scheduler_binding(function (callback) {
    let timeoutHandle = 0;

    const req = http.request(
      config.__$url,
      {
        method: config.__$method,
        headers: A3(
          __Dict_foldl,
          _HttpClient_dictToObject,
          {},
          config.__$headers
        ),
      },
      (res) => {
        const statusCode = res.statusCode;
        if (statusCode < 200 || statusCode >= 300) {
          return callback(
            __Scheduler_fail(
              __HttpClient_UnknownError("bad status code: " + statusCode)
            )
          );
        }

        res.setEncoding("utf8");

        let rawData = "";

        res.on("data", (chunk) => {
          rawData += chunk;
        });

        res.on("end", () => {
          clearTimeout(timeoutHandle);

          switch (config.__$expectType) {
            case "NOTHING":
              if (rawData === "") {
                return callback(__Scheduler_succeed({}));
              } else {
                return callback(
                  __Scheduler_fail(
                    __HttpClient_UnknownError(
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
                    __HttpClient_UnknownError("Failed to decode json response")
                  )
                );
              }
          }
        });
      }
    );

    req.on("error", (e) => {
      if (e === _HttpClient_CustomTimeoutError) {
        return callback(__Scheduler_fail(__HttpClient_Timeout));
      }

      return callback(
        __Scheduler_fail(
          __HttpClient_UnknownError("problem with request: " + e.message)
        )
      );
    });

    const body = _HttpClient_extractRequestBody(config);

    req.end(body);

    timeoutHandle = setTimeout(() => {
      req.destroy(_HttpClient_CustomTimeoutError);
    }, config.__$timeout);
  });
};

var _HttpClient_extractRequestBody = function (config) {
  switch (config.__$bodyType) {
    case "EMPTY":
      return null;
    case "STRING":
      return config.__$body.b;
    case "BYTES":
      return new Uint8Array(config.__$body.b.buffer);
  }
};

var _HttpClient_CustomTimeoutError = new Error();
