/*
import Gren.Kernel.Platform exposing (export)
import Gren.Kernel.Scheduler exposing (binding, succeed)
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
      __$stdout: process.stdout,
      __$stderr: process.stderr,
    })
  );
});

var _Node_sendToStream = F2(function (stream, text) {
  stream.write(text);
  return {};
});
