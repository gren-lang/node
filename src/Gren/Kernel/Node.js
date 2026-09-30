/*

import Basics exposing (never)
import Dict exposing (empty, set)
import Task exposing (perform)
import Gren.Kernel.Platform exposing (export)
import Gren.Kernel.Scheduler exposing (binding, succeed, rawSpawn)
import Gren.Kernel.FilePath exposing (fromString)

*/

var _Node_stream = require("node:stream");
var _Node_process = require("node:process");

var _Node_log = F2(function (text, args) {
  // This function is used for simple applications where the main function returns String
  // NOTE: this function needs __Platform_export available to work
  console.log(text);
  return {};
});

var _Node_init = __Scheduler_binding(function (callback) {
  if (_Node_process.stdin.unref) {
    // Don't block program shutdown if this is the only
    // stream being listened to
    _Node_process.stdin.unref();
  }

  const stdinStream = _Node_stream.Readable.toWeb(_Node_process.stdin);
  const stdinProxy = !_Node_process.stdin.ref
    ? stdinStream
    : _Node_makeProxyOfStdin(stdinStream);

  callback(
    __Scheduler_succeed({
      __$applicationPath: __FilePath_fromString(
        typeof module !== "undefined"
          ? module.filename
          : _Node_process.execPath,
      ),
      __$arch: _Node_process.arch,
      __$args: _Node_process.argv,
      __$platform: _Node_process.platform,
      __$stderr: _Node_stream.Writable.toWeb(_Node_process.stderr),
      __$stdin: stdinProxy,
      __$stdout: _Node_stream.Writable.toWeb(_Node_process.stdout),
    }),
  );
});

function _Node_makeProxyOfStdin(stdinStream) {
  return new Proxy(stdinStream, {
    get(target, prop, receiver) {
      if (prop === "getReader") {
        // Make sure to keep program alive if we're waiting for
        // user input
        _Node_process.stdin.ref();

        const reader = Reflect.get(target, prop, receiver);
        return _Node_makeProxyOfReader(reader);
      }

      if (prop === "pipeThrough") {
        _Node_process.stdin.ref();
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

function _Node_makeProxyOfReader(reader) {
  return new Proxy(reader, {
    get(target, prop, receiver) {
      if (prop === "releaseLock") {
        _Node_process.stdin.unref();
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

var _Node_getPlatform = __Scheduler_binding(function (callback) {
  callback(__Scheduler_succeed(_Node_process.platform));
});

var _Node_getCpuArchitecture = __Scheduler_binding(function (callback) {
  callback(__Scheduler_succeed(_Node_process.arch));
});

var _Node_getEnvironmentVariables = __Scheduler_binding(function (callback) {
  callback(__Scheduler_succeed(_Node_objToDict(_Node_process.env)));
});

var _Node_exitWithCode = function (code) {
  return A2(
    __Task_perform,
    __Basics_never,
    __Scheduler_binding(function (callback) {
      _Node_process.exit(code);
    }),
  );
};

var _Node_setExitCode = function (code) {
  return __Scheduler_binding(function (callback) {
    _Node_process.exitCode = code;
    callback(__Scheduler_succeed({}));
  });
};

// Subs

var _Node_attachEmptyEventLoopListener = function (selfMsg) {
  return __Scheduler_binding(function (_callback) {
    var listener = function () {
      __Scheduler_rawSpawn(selfMsg);
    };

    _Node_process.on("beforeExit", listener);

    return function () {
      _Node_process.off("beforeExit", listener);
    };
  });
};

var _Node_attachSignalInterruptListener = function (selfMsg) {
  return __Scheduler_binding(function (_callback) {
    var listener = function () {
      __Scheduler_rawSpawn(selfMsg);
    };

    _Node_process.on("SIGINT", listener);

    return function () {
      _Node_process.off("SIGINT", listener);
    };
  });
};

var _Node_attachSignalTerminateListener = function (selfMsg) {
  return __Scheduler_binding(function (_callback) {
    var listener = function () {
      __Scheduler_rawSpawn(selfMsg);
    };

    _Node_process.on("SIGTERM", listener);

    return function () {
      _Node_process.off("SIGTERM", listener);
    };
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
