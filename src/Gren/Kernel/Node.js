/*

import Dict exposing (empty, insert)
import Gren.Kernel.Platform exposing (export)
import Gren.Kernel.Scheduler exposing (binding, succeed)

*/

var process = require("node:process");

var _Node_log = F2(function (text, args) {
  // NOTE: this function needs __Platform_export available to work
  console.log(text);
  return {};
});

var _Node_init = __Scheduler_binding(function (callback) {
  callback(
    __Scheduler_succeed({
      __$platform: process.platform,
      __$arch: process.arch,
      __$args: process.argv,
      __$env: _Node_objToDict(process.env),
      __$stdout: process.stdout,
      __$stderr: process.stderr,
      __$stdin: process.stdin,
    })
  );
});

var _Node_getEnvironmentVariables = __Scheduler_binding(function (callback) {
  callback(__Scheduler_succeed(_Node_objToDict(process.env)));
});

var _Node_exit = __Scheduler_binding(function (callback) {
  process.exit();
});

var _Node_exitWithCode = function (code) {
  return __Scheduler_binding(function (callback) {
    process.exit(code);
  });
};

var _Node_setExitCode = function (code) {
  return __Scheduler_binding(function (callback) {
    process.exitCode = code;
  });
};

// Helpers

function _Node_objToDict(obj) {
  var dict = __Dict_empty;

  for (var key in obj) {
    dict = A3(__Dict_insert, key, obj[key], dict);
  }

  return dict;
}
