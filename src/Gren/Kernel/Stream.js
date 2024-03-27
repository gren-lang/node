/*

import Gren.Kernel.Scheduler exposing (binding, rawSpawn)

*/

var _Stream_attachListener = F2(function (stream, sendToApp) {
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

var _Stream_send = F2(function (stream, data) {
  return __Scheduler_binding(function (callback) {
    stream.write(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    callback({});
  });
});
