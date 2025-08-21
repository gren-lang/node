/*

import Gren.Kernel.Scheduler exposing (binding, succeed, fail, rawSpawn)
import HttpClient exposing (BadUrl, Timeout, BadStatus, BadHeaders, UnexpectedResponseBody, UnknownError, SentChunk, ReceivedChunk, Error, Aborted, Done)
import Json.Decode as Decode exposing (decodeString, errorToString)
import Result exposing (isOk)
import Maybe exposing (isJust)
import Dict exposing (empty, set, foldl)
import Platform exposing (sendToApp)

*/

function _HttpClient_clientForProtocol(config) {
  if (config.__$url.startsWith("http://")) {
    return require("node:http");
  }

  return require("node:https");
}

var _HttpClient_request = function (config) {
  return __Scheduler_binding(function (cb) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort("ERR_TIMEOUT"),
      config.__$timeout,
    );

    // This makes sure a left over setTimeout don't cause the process to hang in node.
    function callback(val) {
      clearTimeout(timeout);
      cb(val);
    }

    fetch(config.__$url, {
      method: config.__$method,
      headers: A3(
        __Dict_foldl,
        _HttpClient_dictToObject,
        {},
        config.__$headers,
      ),
      duplex: "half",
      body: _HttpClient_extractRequestBody(config),
      signal: controller.signal,
    })
      .then((res) => {
        switch (config.__$expectType) {
          case "NOTHING":
            return res.blob().then((b) => {
              if (b.size === 0) {
                return callback(
                  __Scheduler_succeed(_HttpClient_formatResponse(res, {})),
                );
              } else {
                return callback(
                  __Scheduler_fail(
                    __HttpClient_UnexpectedResponseBody(
                      "Received response body where I expected none.",
                    ),
                  ),
                );
              }
            });
          case "ANYTHING":
            return callback(
              __Scheduler_succeed(_HttpClient_formatResponse(res, {})),
            );

          case "STRING":
            return res.text().then((t) => {
              return callback(
                __Scheduler_succeed(_HttpClient_formatResponse(res, t)),
              );
            });

          case "JSON":
            return res.text().then((t) => {
              const jsonResult = A2(
                __Decode_decodeString,
                config.__$expect.a,
                t,
              );
              if (__Result_isOk(jsonResult)) {
                return callback(
                  __Scheduler_succeed(
                    _HttpClient_formatResponse(res, jsonResult.a),
                  ),
                );
              } else {
                return callback(
                  __Scheduler_fail(
                    __HttpClient_UnexpectedResponseBody(
                      __Decode_errorToString(jsonResult.a),
                    ),
                  ),
                );
              }
            });

          case "BYTES":
            return res.arrayBuffer().then((b) => {
              return callback(
                __Scheduler_succeed(
                  _HttpClient_formatResponse(res, new DataView(b)),
                ),
              );
            });

          case "STREAM":
            return callback(
              __Scheduler_succeed(_HttpClient_formatResponse(res, res.body)),
            );
        }
      })
      .catch((e) => {
        if (controller.signal.reason === "ERR_TIMEOUT") {
          return callback(__Scheduler_fail(__HttpClient_Timeout));
        } else if (e.code === "ERR_INVALID_HTTP_TOKEN") {
          return callback(__Scheduler_fail(__HttpClient_BadHeaders));
        } else if (e.code === "ERR_INVALID_URL") {
          return callback(__Scheduler_fail(__HttpClient_BadUrl(config.__$url)));
        } else {
          return callback(
            __Scheduler_fail(
              __HttpClient_UnknownError("problem with request: " + e.message),
            ),
          );
        }
      });

    return () => {
      controller.abort();
    };
  });
};

var _HttpClient_stream = F4(function (cleanup, sendToApp, request, config) {
  return __Scheduler_binding(function (callback) {
    function send(msg) {
      return __Scheduler_rawSpawn(sendToApp(msg));
    }

    let req = null;
    try {
      const client = _HttpClient_clientForProtocol(config);
      req = client.request(config.__$url, {
        method: config.__$method,
        headers: A3(
          __Dict_foldl,
          _HttpClient_dictToObject,
          {},
          config.__$headers,
        ),
        timeout: config.__$timeout,
      });
    } catch (e) {
      callback(__Scheduler_succeed(request));

      if (e.code === "ERR_INVALID_HTTP_TOKEN") {
        send(__HttpClient_Error(__HttpClient_BadHeaders));
      } else if (e.code === "ERR_INVALID_URL") {
        send(__HttpClient_Error(__HttpClient_BadUrl(config.__$url)));
      } else {
        send(
          __HttpClient_Error(
            __HttpClient_UnknownError("problem with request: " + e.message),
          ),
        );
      }

      return __Scheduler_rawSpawn(cleanup(request));
    }

    req.on("timeout", () => {
      req.destroy(_HttpClient_CustomTimeoutError);
    });

    req.on("error", (e) => {
      __Scheduler_rawSpawn(cleanup(request));

      if (e === _HttpClient_CustomTimeoutError) {
        send(__HttpClient_Timeout);
      } else if (e === _HttpClient_CustomAbortError) {
        send(__HttpClient_Aborted);
      } else {
        send(__HttpClient_UnknownError("problem with request: " + e.message));
      }
    });

    const body = _HttpClient_extractRequestBody(config);

    if (config.__$bodyType === "STREAM") {
      send(
        __HttpClient_UnknownError(
          "stream request body not supported in legacy api",
        ),
      );
    } else if (body == null) {
      send(__HttpClient_SentChunk(request));
    } else {
      req.write(body, () => {
        send(__HttpClient_SentChunk(request));
      });
    }

    return callback(
      __Scheduler_succeed({
        __$request: req,
        __$response: null,
      }),
    );
  });
});

var _HttpClient_sendChunk = F4(
  function (sendToApp, kernelRequest, request, bytes) {
    return __Scheduler_binding(function (callback) {
      if (!kernelRequest.__$request.writableEnded) {
        const chunk = _HttpClient_prepBytes(bytes);

        kernelRequest.__$request.write(chunk, () => {
          __Scheduler_rawSpawn(sendToApp(__HttpClient_SentChunk(request)));
        });
      }

      return callback(__Scheduler_succeed({}));
    });
  },
);

var _HttpClient_startReceive = F4(
  function (cleanup, sendToApp, kernelRequest, request) {
    return __Scheduler_binding(function (callback) {
      if (kernelRequest.__$request.writableEnded) {
        return callback(__Scheduler_succeed({}));
      }
      kernelRequest.__$request.on("response", (res) => {
        kernelRequest.__$response = res;

        res.on("data", (bytes) => {
          return __Scheduler_rawSpawn(
            sendToApp(
              __HttpClient_ReceivedChunk({
                __$request: request,
                __$response: _HttpClient_formatResponseLegacy(
                  res,
                  new DataView(
                    bytes.buffer,
                    bytes.byteOffset,
                    bytes.byteLength,
                  ),
                ),
              }),
            ),
          );
        });

        res.on("error", (e) => {
          __Scheduler_rawSpawn(cleanup(request));
          __Scheduler_rawSpawn(
            sendToApp(
              __HttpClient_Error(
                __HttpClient_UnknownError("problem with request: " + e.message),
              ),
            ),
          );
        });

        res.on("end", () => {
          __Scheduler_rawSpawn(cleanup(request));
          __Scheduler_rawSpawn(sendToApp(__HttpClient_Done));
        });
      });

      kernelRequest.__$request.end(() => {
        return callback(__Scheduler_succeed({}));
      });
    });
  },
);

var _HttpClient_abort = function (kernelRequest) {
  return __Scheduler_binding(function (callback) {
    if (!kernelRequest.__$request.writableEnded) {
      kernelRequest.__$request.destroy(_HttpClient_CustomAbortError);
    } else if (
      kernelRequest.__$response &&
      kernelRequest.__$response.complete === false
    ) {
      kernelRequest.__$response.destroy(_HttpClient_CustomAbortError);
    }

    return callback(__Scheduler_succeed({}));
  });
};

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
    case "STREAM":
      return config.__$body.a;
  }
};

var _HttpClient_prepBytes = function (bytes) {
  return new Uint8Array(bytes.buffer);
};

var _HttpClient_CustomAbortError = new Error();

var _HttpClient_CustomTimeoutError = new Error();

var _HttpClient_formatResponseLegacy = function (res, data) {
  let headerDict = __Dict_empty;
  for (const [key, value] of Object.entries(res.headersDistinct)) {
    headerDict = A3(__Dict_set, key.toLowerCase(), value, headerDict);
  }

  return {
    __$statusCode: res.statusCode,
    __$statusText: res.statusMessage,
    __$headers: headerDict,
    __$data: data,
  };
};

var _HttpClient_formatResponse = function (res, data) {
  let headerDict = __Dict_empty;

  for (const [key, value] of res.headers.entries()) {
    headerDict = A3(__Dict_set, key.toLowerCase(), value, headerDict);
  }

  return {
    __$statusCode: res.status,
    __$statusText: res.statusText,
    __$headers: headerDict,
    __$data: data,
  };
};
