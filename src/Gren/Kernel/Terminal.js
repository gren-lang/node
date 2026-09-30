/*

import Gren.Kernel.Scheduler exposing (binding, succeed, rawSpawn)

*/

var _Terminal_process = require("node:process");

var _Terminal_init = __Scheduler_binding(function (callback) {
  callback(
    __Scheduler_succeed({
      __$isTTY: _Terminal_process.stdout.isTTY && _Terminal_process.stdin.isTTY,
      __$colorDepth: _Terminal_process.stdout.getColorDepth
        ? _Terminal_process.stdout.getColorDepth()
        : 0,
      __$columns: _Terminal_process.stdout.columns,
      __$rows: _Terminal_process.stdout.rows,
    }),
  );
});

var _Terminal_attachListener = function (sendToApp) {
  return __Scheduler_binding(function (_callback) {
    var listener = function (data) {
      __Scheduler_rawSpawn(
        sendToApp({
          __$columns: _Terminal_process.stdout.columns,
          __$rows: _Terminal_process.stdout.rows,
        }),
      );
    };

    _Terminal_process.stdout.on("resize", listener);

    return function () {
      _Terminal_process.stdout.off("resize", listener);
      _Terminal_process.stdout.pause();
    };
  });
};

var _Terminal_setStdInRawMode = function (toggle) {
  return __Scheduler_binding(function (callback) {
    _Terminal_process.stdin.setRawMode(toggle);
    callback(__Scheduler_succeed({}));
  });
};

var _Terminal_setProcessTitle = function (title) {
  return __Scheduler_binding(function (callback) {
    _Terminal_process.title = title;
    callback(__Scheduler_succeed({}));
  });
};
