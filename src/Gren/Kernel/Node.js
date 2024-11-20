/*

import Dict exposing (empty, set)
import Gren.Kernel.Platform exposing (export)
import Gren.Kernel.Scheduler exposing (binding, succeed)
import Gren.Kernel.FilePath exposing (fromString)

*/

var process = require("node:process");
var stream = require("node:stream");

var _Node_log = F2(function (text, args) {
  // This function is used for simple applications where the main function returns String
  // NOTE: this function needs __Platform_export available to work
  console.log(text);
  return {};
});

var _Node_init = __Scheduler_binding(function (callback) {
  if (process.stdin.unref) {
    // Don't block program shutdown if this is the only
    // stream being listened to
    process.stdin.unref();
  }

  const stdinStream = stream.Readable.toWeb(process.stdin);
  const stdinProxy = !process.stdin.ref
    ? stdinStream
    : _Node_makeProxyOfStdin(stdinStream);

  callback(
    __Scheduler_succeed({
      __$applicationPath: __FilePath_fromString(
        typeof module !== "undefined" ? module.filename : process.execPath,
      ),
      __$arch: process.arch,
      __$args: process.argv,
      __$platform: process.platform,
      __$stderr: stream.Writable.toWeb(process.stderr),
      __$stdin: stdinProxy,
      __$stdout: stream.Writable.toWeb(process.stdout),
    }),
  );
});

function _Node_makeProxyOfStdin(stdinStream) {
  return new Proxy(stdinStream, {
    get(target, prop, receiver) {
      if (prop === "getReader") {
        // Make sure to keep program alive if we're waiting for
        // user input
        process.stdin.ref();

        const reader = Reflect.get(target, prop, receiver);
        return _Node_makeProxyOfReader(reader);
      }

      if (prop === "pipeThrough") {
        process.stdin.ref();
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

function _Node_makeProxyOfReader(reader) {
  return new Proxy(reader, {
    get(target, prop, receiver) {
      if (prop === "releaseLock") {
        process.stdin.unref();
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

var _Node_getEnvironmentVariables = __Scheduler_binding(function (callback) {
  callback(__Scheduler_succeed(_Node_objToDict(process.env)));
});

var _Node_exitWithCode = function (code) {
  return __Scheduler_binding(function (callback) {
    process.exit(code);
  });
};

var _Node_setExitCode = function (code) {
  return __Scheduler_binding(function (callback) {
    process.exitCode = code;
    callback(__Scheduler_succeed({}));
  });
};

// Helpers

function _Node_objToDict(obj) {
  var dict = __Dict_empty;

  for (var key in obj) {
    dict = A3(__Dict_set, key, obj[key], dict);
  }

  return dict;
}
