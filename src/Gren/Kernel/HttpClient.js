/*

import Gren.Kernel.Scheduler exposing (binding, succeed, fail, rawSpawn)
import HttpClient exposing (Timeout, BadStatus, UnknownError, SentChunk, ReceivedChunk, Error, Done)
import Json.Decode as Decode exposing (decodeString)
import Result exposing (isOk)
import Maybe exposing (isJust)
import Dict exposing (empty, insert, foldl)
import Platform exposing (sendToApp)

*/

const http = require("http");

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
        const expectType = config.__$expectType;

        if (expectType === "STRING" || expectType === "JSON") {
          res.setEncoding("utf8");
        }

        let rawData = null;
        res.on("data", (chunk) => {
          if (rawData === null) {
            rawData = chunk;
          } else {
            rawData += chunk;
          }
        });

        res.on("end", () => {
          clearTimeout(timeoutHandle);

          if (res.statusCode < 200 || res.statusCode >= 300) {
            return callback(
              __Scheduler_fail(
                __HttpClient_BadStatus(_HttpClient_formatResponse(res, rawData))
              )
            );
          }

          switch (expectType) {
            case "NOTHING":
              if (rawData === null) {
                return callback(
                  __Scheduler_succeed(_HttpClient_formatResponse(res, {}))
                );
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
              return callback(
                __Scheduler_succeed(_HttpClient_formatResponse(res, {}))
              );

            case "STRING":
              return callback(
                __Scheduler_succeed(_HttpClient_formatResponse(res, rawData))
              );

            case "JSON":
              const jsonResult = A2(
                __Decode_decodeString,
                config.__$expect.a,
                rawData
              );
              if (__Result_isOk(jsonResult)) {
                return callback(
                  __Scheduler_succeed(
                    _HttpClient_formatResponse(res, jsonResult.a)
                  )
                );
              } else {
                return callback(
                  __Scheduler_fail(
                    __HttpClient_UnknownError("Failed to decode json response")
                  )
                );
              }

            case "BYTES":
              return callback(
                __Scheduler_succeed(
                  _HttpClient_formatResponse(res, new DataView(rawData.buffer))
                )
              );
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

var _HttpClient_stream = F3(function (sendToApp, request, config) {
  return __Scheduler_binding(function (callback) {
    function send(msg) {
      return __Scheduler_rawSpawn(sendToApp(msg));
    }

    const req = http.request(config.__$url, {
      method: config.__$method,
      headers: A3(
        __Dict_foldl,
        _HttpClient_dictToObject,
        {},
        config.__$headers
      ),
    });

    const timeoutHandle = setTimeout(() => {
      req.destroy(_HttpClient_CustomTimeoutError);
    }, config.__$timeout);

    req.on("error", (e) => {
      clearInterval(timeoutHandle);

      let err = __HttpClient_UnknownError("problem with request: " + e.message);

      if (e === _HttpClient_CustomTimeoutError) {
        err = __Scheduler_fail(__HttpClient_Timeout);
      }

      send(__HttpClient_Error(err));
    });

    const body = _HttpClient_extractRequestBody(config);

    req.write(body, () => {
      send(__HttpClient_SentChunk(request));
    });

    return callback(__Scheduler_succeed(req));
  });
});

var _HttpClient_sendChunk = F4(function (
  sendToApp,
  kernelRequest,
  request,
  bytes
) {
  return __Scheduler_binding(function (callback) {
    const chunk = _HttpClient_prepBytes(bytes);

    kernelRequest.write(chunk, () => {
      return __Scheduler_rawSpawn(sendToApp(__HttpClient_SentChunk(request)));
    });

    return callback(__Scheduler_succeed({}));
  });
});

// HELPERS

var _HttpClient_dictToObject = F3(function (key, value, obj) {
  obj[key] = value;
  return obj;
});

var _HttpClient_extractRequestBody = function (config) {
  switch (config.__$bodyType) {
    case "EMPTY":
      return null;
    case "STRING":
      return config.__$body.a;
    case "BYTES":
      return _HttpClient_prepBytes(config.__$body.a);
  }
};

var _HttpClient_prepBytes = function (bytes) {
  return new Uint8Array(bytes.buffer);
};

var _HttpClient_CustomTimeoutError = new Error();

var _HttpClient_formatResponse = function (res, data) {
  let headerDict = __Dict_empty;
  for (const [key, value] of Object.entries(res.headersDistinct)) {
    headerDict = A3(__Dict_insert, key, value, headerDict);
  }

  return {
    __$statusCode: res.statusCode,
    __$statusText: res.statusMessage,
    __$headers: headerDict,
    __$data: data,
  };
};
