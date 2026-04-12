/*

import Gren.Kernel.Scheduler exposing (binding, succeed, fail, rawSpawn)
import WebSocketServer exposing (ServerError, TextMessage, BinaryMessage)
import WebSocketServer.Connection as WsConn exposing (Error)

*/

var _WebSocketServer_startServer = F2(function (host, port) {
  return __Scheduler_binding(function (callback) {
    var WebSocket = require("ws");
    var wss = new WebSocket.Server({ host: host, port: port });

    var connectionsTransform = new TransformStream(
      {},
      new CountQueuingStrategy({ highWaterMark: 1 }),
      new CountQueuingStrategy({ highWaterMark: 1024 }),
    );
    var connectionsWriter = connectionsTransform.writable.getWriter();
    wss.__grenConnectionsWriter = connectionsWriter;

    var settled = false;

    wss.on("error", function (e) {
      if (!settled) {
        settled = true;
        callback(
          __Scheduler_fail(
            __WebSocketServer_ServerError({
              __$code: e.code || "UNKNOWN",
              __$message: e.message,
            }),
          ),
        );
      }
    });

    wss.on("listening", function () {
      if (!settled) {
        settled = true;
        callback(
          __Scheduler_succeed({
            __$server: wss,
            __$connections: connectionsTransform.readable,
          }),
        );
      }
    });

    wss.on("connection", function (client) {
      _WebSocketServer_attachConnection(client, connectionsWriter);
    });
  });
});

var _WebSocketServer_stopServer = function (wss) {
  return __Scheduler_binding(function (callback) {
    try {
      wss.__grenConnectionsWriter.close().catch(function () {});
    } catch (_) {}

    wss.clients.forEach(function (client) {
      try {
        client.close();
      } catch (_) {}
    });

    wss.close(function (err) {
      if (err) {
        callback(
          __Scheduler_fail(
            __WebSocketServer_ServerError({
              __$code: err.code || "UNKNOWN",
              __$message: err.message || "",
            }),
          ),
        );
      } else {
        callback(__Scheduler_succeed({}));
      }
    });
  });
};

var _WebSocketServer_nextConnectionId = 0;

function _WebSocketServer_attachConnection(client, connectionsWriter) {
  var connId = _WebSocketServer_nextConnectionId++;

  var incoming = new TransformStream(
    {},
    new CountQueuingStrategy({ highWaterMark: 1 }),
    new CountQueuingStrategy({ highWaterMark: 1024 }),
  );
  var incomingWriter = incoming.writable.getWriter();

  var connection = {
    __$id: connId,
    __$incoming: incoming.readable,
    __$client: client,
  };

  client.on("message", function (data, isBinary) {
    var msg = isBinary
      ? __WebSocketServer_BinaryMessage(
          new DataView(data.buffer, data.byteOffset, data.byteLength),
        )
      : __WebSocketServer_TextMessage(data.toString());

    incomingWriter.write(msg).catch(function () {
      // Consumer cancelled the incoming stream; drop the frame.
    });
  });

  client.on("close", function () {
    incomingWriter.close().catch(function () {});
  });

  client.on("error", function (err) {
    incomingWriter.abort(err && err.message ? err.message : "connection error").catch(function () {});
  });

  connectionsWriter.write(connection).catch(function () {
    // Connections stream was cancelled; close the client.
    try {
      client.close();
    } catch (_) {}
  });
}

function _WebSocketServer_constructError(err) {
  return __WsConn_Error({
    __$code: err.code || "",
    __$message: err.message || "",
  });
}

var _WebSocketServer_send = F2(function (connection, data) {
  return __Scheduler_binding(function (callback) {
    try {
      connection.__$client.send(data, function (err) {
        if (err) {
          callback(__Scheduler_fail(_WebSocketServer_constructError(err)));
        } else {
          callback(__Scheduler_succeed({}));
        }
      });
    } catch (e) {
      callback(__Scheduler_fail(_WebSocketServer_constructError(e)));
    }
  });
});

var _WebSocketServer_sendBytes = F2(function (connection, bytes) {
  return __Scheduler_binding(function (callback) {
    try {
      var buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      connection.__$client.send(buffer, function (err) {
        if (err) {
          callback(__Scheduler_fail(_WebSocketServer_constructError(err)));
        } else {
          callback(__Scheduler_succeed({}));
        }
      });
    } catch (e) {
      callback(__Scheduler_fail(_WebSocketServer_constructError(e)));
    }
  });
});

var _WebSocketServer_close = F3(function (connection, code, reason) {
  return __Scheduler_binding(function (callback) {
    try {
      connection.__$client.close(code, reason);
      callback(__Scheduler_succeed({}));
    } catch (e) {
      callback(__Scheduler_fail(_WebSocketServer_constructError(e)));
    }
  });
});
