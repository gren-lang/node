/*

import Gren.Kernel.Scheduler exposing (binding, succeed, rawSpawn)

*/

var process = require("node:process");

var _Terminal_init = __Scheduler_binding(function (callback) {
  callback(
    __Scheduler_succeed({
      __$isTTY: process.stdout.isTTY,
      __$colorDepth: process.stdout.getColorDepth
        ? process.stdout.getColorDepth()
        : 0,
      __$columns: process.stdout.columns,
      __$rows: process.stdout.rows,
    })
  );
});

var _Terminal_attachListener = function (sendToApp) {
  return __Scheduler_binding(function (_callback) {
    var listener = function (data) {
      __Scheduler_rawSpawn(
        sendToApp({
          __$columns: process.stdout.columns,
          __$rows: process.stdout.rows,
        })
      );
    };

    process.stdout.on("resize", listener);

    return function () {
      process.stdout.off("resize", listener);
      process.stdout.pause();
    };
  });
};

var _Terminal_setStdInRawMode = function (toggle) {
  return __Scheduler_binding(function (callback) {
    process.stdin.setRawMode(toggle);
    callback(__Scheduler_succeed({}));
  });
};
