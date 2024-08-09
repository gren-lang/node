/*

import Gren.Kernel.Scheduler exposing (binding, succeed, fail, rawSpawn)
import Gren.Kernel.Utils exposing (update)
import Dict exposing (foldl)
import ChildProcess exposing (FailedRun, SuccessfulRun)

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
        timeout: options.__$runDuration,
        cwd: _ChildProcess_handleCwd(workingDir),
        env: _ChildProcess_handleEnv(env),
        timeout: options.__$runDuration,
        maxBuffer: options.__$maximumBytesWrittenToStreams,
        shell: _ChildProcess_handleShell(shell),
      },
      function (err, stdout, stderr) {
        if (err == null) {
          callback(
            __Scheduler_succeed({
              __$stdout: new DataView(
                stdout.buffer,
                stdout.byteOffset,
                stdout.byteLength
              ),
              __$stderr: new DataView(
                stderr.buffer,
                stderr.byteOffset,
                stderr.byteLength
              ),
            })
          );
        } else {
          callback(
            __Scheduler_fail({
              __$exitCode:
                typeof err.errno === "undefined" ? err.code : err.errno,
              __$stdout: new DataView(
                stdout.buffer,
                stdout.byteOffset,
                stdout.byteLength
              ),
              __$stderr: new DataView(
                stderr.buffer,
                stderr.byteOffset,
                stderr.byteLength
              ),
            })
          );
        }
      }
    );
  });
};

var _ChildProcess_spawn = function (options) {
  return __Scheduler_binding(function (callback) {
    var subproc = _ChildProcess_getSubProc(options);
    return function () {
      subproc.kill();
    };
  });
};

var _ChildProcess_spawnAsCmd = F2(function (sendToApp, options) {
  return __Scheduler_binding(function (callback) {
    var subproc = _ChildProcess_getSubProc(options);
    subproc.on("exit", function (code) {
      callback(__Scheduler_rawSpawn(sendToApp(code)));
    });
    return function () {
      subproc.kill();
    };
  });
});

function _ChildProcess_getSubProc(options) {
  var workingDir = options.__$workingDirectory;
  var env = options.__$environmentVariables;
  var shell = options.__$shell;

  var subproc = childProcess.spawn(options.__$program, options.__$arguments, {
    cwd: _ChildProcess_handleCwd(workingDir),
    env: _ChildProcess_handleEnv(env),
    timeout: options.__$runDuration,
    shell: _ChildProcess_handleShell(shell),
    stdio: options.__$connection === 0 ? "inherit" : "ignore",
    detached: options.__$connection === 2 && process.platform === "win32",
  });
  
  if (options.__$connection === 2) {
    subproc.unref();
  }

  return subproc;
}

function _ChildProcess_handleCwd(cwd) {
  return cwd.__$inherit ? process.cwd() : cwd.__$override;
}

function _ChildProcess_handleEnv(env) {
  return env.__$option === 0
    ? process.env
    : env.__$option === 1
    ? __Utils_update(process.env, _ChildProcess_dictToObj(env.__$value))
    : _ChildProcess_dictToObj(env.__$value);
}

function _ChildProcess_handleShell(shell) {
  return shell.__$choice === 0
    ? false
    : shell.__$choice === 1
    ? true
    : shell.__$value;
}

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
