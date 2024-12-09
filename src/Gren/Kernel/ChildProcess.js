/*

import Gren.Kernel.Scheduler exposing (binding, succeed, fail, rawSpawn)
import Gren.Kernel.Utils exposing (update)
import Dict exposing (foldl)
import ChildProcess exposing (FailedRun, SuccessfulRun)
import Maybe exposing (Just, Nothing)

*/

var bufferNs = require("node:buffer");
var process = require("node:process");
var stream = require("node:stream");

var _ChildProcess_module = function () {
  return require("node:child_process");
};

var _ChildProcess_run = function (options) {
  return __Scheduler_binding(function (callback) {
    var childProcess = _ChildProcess_module();

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
                stdout.byteLength,
              ),
              __$stderr: new DataView(
                stderr.buffer,
                stderr.byteOffset,
                stderr.byteLength,
              ),
            }),
          );
        } else {
          callback(
            __Scheduler_fail({
              __$exitCode:
                typeof err.errno === "undefined" ? err.code : err.errno,
              __$stdout: new DataView(
                stdout.buffer,
                stdout.byteOffset,
                stdout.byteLength,
              ),
              __$stderr: new DataView(
                stderr.buffer,
                stderr.byteOffset,
                stderr.byteLength,
              ),
            }),
          );
        }
      },
    );
  });
};

var _ChildProcess_spawn = F3(function (sendInitToApp, sendExitToApp, options) {
  return __Scheduler_binding(function (callback) {
    var subproc = _ChildProcess_getSubProc(options);

    __Scheduler_rawSpawn(
      sendInitToApp({
        __$processId: __Scheduler_rawSpawn(
          __Scheduler_binding(function (callback) {
            return function () {
              subproc.kill();
            };
          }),
        ),
        __$streams:
          options.__$connection !== 1
            ? __Maybe_Nothing
            : __Maybe_Just({
                __$input: stream.Readable.toWeb(subproc.stdin),
                __$output: stream.Writable.toWeb(subproc.stdout),
                __$error: stream.Writable.toWeb(subproc.stderr),
              }),
      }),
    );

    subproc.on("exit", function (code) {
      __Scheduler_rawSpawn(sendExitToApp(code));
    });
  });
});

function _ChildProcess_getSubProc(options) {
  var childProcess = _ChildProcess_module();

  var workingDir = options.__$workingDirectory;
  var env = options.__$environmentVariables;
  var shell = options.__$shell;

  var subproc = childProcess.spawn(options.__$program, options.__$arguments, {
    cwd: _ChildProcess_handleCwd(workingDir),
    env: _ChildProcess_handleEnv(env),
    timeout: options.__$runDuration,
    shell: _ChildProcess_handleShell(shell),
    stdio:
      options.__$connection === 0
        ? "inherit"
        : options.__$connection === 1
          ? "pipe"
          : "ignore",
    detached: options.__$connection === 3 && process.platform === "win32",
  });

  if (options.__$connection === 3) {
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
    dict,
  );
}
