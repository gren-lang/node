/*

import Gren.Kernel.Scheduler exposing (binding, succeed, fail)
import Gren.Kernel.Utils exposing (update)
import Dict exposing (foldl)

*/

var bufferNs = require("node:buffer");
var process = require("node:process");
var childProcess = require("node:child_process");

var _ChildProcess_run = function (options) {
  return __Scheduler_binding(function (callback) {
    var workingDir = options.__$workingDirectory;
    var env = options.__$environmentVariables;
    var shell = options.__$shell;

    childProcess.execFile(
      options.__$program,
      options.__$arguments,
      {
        encoding: "buffer",
        cwd: workingDir.__$inherit ? process.cwd() : workingDir.__$override,
        env:
          env.__$option === 0
            ? process.env
            : env.__$option === 1
            ? __Utils_update(process.env, _ChildProcess_dictToObj(env.__$value))
            : _ChildProcess_dictToObj(env.__$value),
        timeout: options.__$runDuration,
        maxBuffer: options.__$maximumBytesWrittenToStreams,
        shell:
          shell.__$choice === 0
            ? false
            : shell.__$choice === 1
            ? true
            : shell.__$value,
      },
      function (err, stdout, stderr) {
        if (err == null) {
          callback(
            __Scheduler_succeed({
              __$stdout: new DataView(stdout.buffer, stdout.byteOffset),
              __$stderr: new DataView(stderr.buffer, stderr.byteOffset),
            })
          );
        } else {
          callback(
            __Scheduler_fail({
              __$exitCode:
                typeof err.errno === "undefined" ? err.code : err.errno,
              __$stdout: new DataView(stdout.buffer, stdout.byteOffset),
              __$stderr: new DataView(stderr.buffer, stderr.byteOffset),
            })
          );
        }
      }
    );
  });
};

function _ChildProcess_dictToObj(dict) {
  return A3(
    __Dict_foldl,
    F3(function (key, value, acc) {
      acc[key] = value;
      return acc;
    }),
    {},
    dict
  );
}
