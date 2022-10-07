/*

import Dict exposing (empty, insert)
import Gren.Kernel.Platform exposing (export)
import Gren.Kernel.Scheduler exposing (binding, succeed, rawSpawn)

*/

var process = require("process");

var _Node_log = F2(function (text, args) {
  // NOTE: this function needs __Platform_export available to work
  console.log(text);
  return {};
});

var _Node_initialize = __Scheduler_binding(function (callback) {
  return callback(
    __Scheduler_succeed({
      __$args: process.argv,
      __$env: _Node_objToDict(process.env),
      __$stdout: process.stdout,
      __$stderr: process.stderr,
      __$stdin: process.stdin
    })
  );
});

var _Node_attachListener = F2(function (stream, sendToApp) {
  return __Scheduler_binding(function (_callback) {
    var listener = function (data) {
      __Scheduler_rawSpawn(sendToApp(new DataView(data.buffer)));
    };

    stream.on("data", listener);

    return function () {
      stream.off("data", listener);
      stream.pause();
    };
  });
});

var _Node_sendToStream = F2(function (stream, data) {
  stream.write(new Uint8Array(data.buffer));
  return {};
});

// Helpers

function _Node_objToDict(obj) {
  var dict = __Dict_empty;

  for (var key in obj) {
    dict = A3(__Dict_insert, key, obj[key], dict);
  }

  return dict;
}
