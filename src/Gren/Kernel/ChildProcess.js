/*

import Gren.Kernel.Scheduler exposing (binding, succeed, fail)

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
          env.__$option === 0 ? process.env : env.__$option === 1 ? MERGE : SET,
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
              __$stdout: stdout,
              __$stderr: stderr,
            })
          );
        } else {
          callback(
            __Scheduler_fail({
              __$exitCode: err.code,
              __$stdout: stdout,
              __$stderr: stderr,
            })
          );
        }
      }
    );
  });
};
