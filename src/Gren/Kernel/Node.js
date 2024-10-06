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
  const stdin = process.stdin;
  if (stdin.unref) {
    // Don't block program shutdown if this is the only
    // stream being listened to
    stdin.unref();
  }

  const stdinTransform = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(
        new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      );
    },
  });

  const stdinReadableProxy = !stdin.ref
    ? stdinTransform.readable
    : new Proxy(stdinTransform.readable, {
        get(target, prop, receiver) {
          if (prop === "getReader" && stdin.ref) {
            // Make sure to keep program alive if we're waiting for
            // user input
            stdin.ref();
          }

          return Reflect.get(target, prop, receiver);
        },
      });

  stdin.on("readable", () => {
    let data;
    const chunks = [];
    while ((data = stdin.read()) !== null) {
      chunks.push(data);
    }

    if (!stdinReadableProxy.locked) {
      // discarding stdin data, as no one is listening
      return;
    }

    let writeOp = Promise.resolve(undefined);
    const writer = stdinTransform.writable.getWriter();
    for (let i = 0; i < chunks.length; i++) {
      writeOp = writeOp.then(() => writer.write(chunks[i]));
    }

    writeOp.finally(() => {
      writer.releaseLock();

      if (stdin.unref) {
        stdin.unref();
      }
    });
  });

  const stdout = stream.Writable.toWeb(process.stdout);
  const stderr = stream.Writable.toWeb(process.stderr);

  const dataViewToByteTransform = {
    transform(chunk, controller) {
      controller.enqueue(
        new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      );
    },
  };

  const stdoutTransform = new TransformStream(dataViewToByteTransform);
  stdoutTransform.readable.pipeTo(stdout);

  const stderrTransform = new TransformStream(dataViewToByteTransform);
  stderrTransform.readable.pipeTo(stderr);

  callback(
    __Scheduler_succeed({
      __$applicationPath: __FilePath_fromString(
        typeof module !== "undefined" ? module.filename : process.execPath,
      ),
      __$arch: process.arch,
      __$args: process.argv,
      __$platform: process.platform,
      __$stderr: stderrTransform.writable,
      __$stdin: stdinReadableProxy,
      __$stdout: stdoutTransform.writable,
    }),
  );
});

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
