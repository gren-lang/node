/*

import Gren.Kernel.Scheduler exposing (binding, succeed, fail, rawSpawn)
import WebSocketServer exposing (ServerError, TextMessage, BinaryMessage)
import WebSocketServer.Connection as WsConn exposing (Error)
import Platform exposing (sendToApp)

*/

var _WebSocketServer_createServer = F2(function (host, port) {
  return __Scheduler_binding(function (callback) {
    var WebSocket = require("ws");
    var server = new WebSocket.Server({ host: host, port: port });

    server.on("error", function (e) {
      callback(
        __Scheduler_fail(
          __WebSocketServer_ServerError({
            __$code: e.code || "UNKNOWN",
            __$message: e.message,
          }),
        ),
      );
    });

    server.on("listening", function () {
      callback(__Scheduler_succeed(server));
    });
  });
});

var _WebSocketServer_nextConnectionId = 0;

// Initialize the handler storage on a server object and attach the server-level
// "connection" listener exactly once. Per-client handlers delegate to the current
// handler references stored on the server object, so when onEffects updates the
// handlers, existing long-lived connections automatically use the new handlers.
function _WebSocketServer_ensureListenersAttached(server) {
  if (server.__grenListenersAttached) {
    return;
  }
  server.__grenListenersAttached = true;
  server.__grenConnectionHandlers = [];
  server.__grenCloseHandlers = [];

  server.on("connection", function (client) {
    var connId = _WebSocketServer_nextConnectionId++;
    var connection = { __$id: connId, __$client: client };

    // Store the Connection object on the client instance so that close/error
    // handlers can retrieve it without a separate lookup map.
    client.__grenConnection = connection;

    // Create a ReadableStream that surfaces incoming messages for this
    // connection. The controller is retained on the client so the per-event
    // closures below can enqueue messages and close/error the stream when the
    // connection ends. The stream is passed to the app via the connection
    // handler; the app reads messages from it using the Stream module.
    client.__grenStreamClosed = false;
    var messageStream = new ReadableStream({
      start: function (controller) {
        client.__grenStreamController = controller;
      },
    });

    // Create two WritableStreams for sending data back to the client: one for
    // text frames (String) and one for binary frames (Bytes). Each write calls
    // ws#send with the appropriate JS type, and the send callback drives
    // backpressure by resolving the write once the data is flushed. The sink
    // controllers are retained so they can be errored when the connection ends.
    client.__grenWritableControllers = [];
    var textWritable = _WebSocketServer_makeWritable(client, function (chunk) {
      return chunk;
    });
    var binaryWritable = _WebSocketServer_makeWritable(client, function (chunk) {
      return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    });

    // Notify the app of the new connection, if any handlers are registered.
    var connHandlers = server.__grenConnectionHandlers;
    for (var i = 0; i < connHandlers.length; i++) {
      __Scheduler_rawSpawn(
        A2(
          __Platform_sendToApp,
          connHandlers[i].router,
          connHandlers[i].handler({
            __$connection: connection,
            __$readable: messageStream,
            __$textWritable: textWritable,
            __$binaryWritable: binaryWritable,
          }),
        ),
      );
    }

    // Feed incoming messages into the connection's stream.
    client.on("message", function (data, isBinary) {
      if (client.__grenStreamClosed) return;

      var msg = isBinary
        ? __WebSocketServer_BinaryMessage(
            new DataView(data.buffer, data.byteOffset, data.byteLength),
          )
        : __WebSocketServer_TextMessage(data.toString());

      client.__grenStreamController.enqueue(msg);
    });

    client.on("close", function (code, reason) {
      // Close the message stream so readers observe end-of-stream.
      if (!client.__grenStreamClosed) {
        client.__grenStreamClosed = true;
        try {
          client.__grenStreamController.close();
        } catch (e) {
          // Controller may already be closed or errored; safe to ignore.
        }
      }

      // Fail any further writes on the writable streams.
      _WebSocketServer_terminateWritables(client, "WebSocket connection closed");

      var handlers = server.__grenCloseHandlers;
      for (var i = 0; i < handlers.length; i++) {
        __Scheduler_rawSpawn(
          A2(
            __Platform_sendToApp,
            handlers[i].router,
            A2(handlers[i].handler, client.__grenConnection, {
              __$code: code,
              __$reason: reason.toString(),
            }),
          ),
        );
      }
    });

    client.on("error", function (err) {
      // Error the message stream so active readers stop. There is no separate
      // error subscription: callers observe this as Stream.Cancelled <message>.
      if (!client.__grenStreamClosed) {
        client.__grenStreamClosed = true;
        try {
          client.__grenStreamController.error(err.message);
        } catch (e) {
          // Controller may already be closed or errored; safe to ignore.
        }
      }

      // Fail any further writes on the writable streams.
      _WebSocketServer_terminateWritables(client, err.message);
    });
  });
}

// Build a WritableStream whose writes forward to ws#send. `toPayload` converts
// the chunk (a String for text, a Uint8Array for binary) into the value passed
// to ws#send, which determines the frame type (string -> text, Buffer -> binary).
// The send callback resolves the write (backpressure) and errors it on failure.
function _WebSocketServer_makeWritable(client, toPayload) {
  return new WritableStream({
    start: function (controller) {
      client.__grenWritableControllers.push(controller);
    },
    write: function (chunk, controller) {
      return new Promise(function (resolve, reject) {
        client.send(toPayload(chunk), function (err) {
          if (err) {
            controller.error(err.message);
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  });
}

// Error every writable sink controller for a client. Called when the connection
// closes or errors so that pending and future writes fail promptly.
function _WebSocketServer_terminateWritables(client, reason) {
  var controllers = client.__grenWritableControllers;
  for (var i = 0; i < controllers.length; i++) {
    try {
      controllers[i].error(reason);
    } catch (e) {
      // Controller may already be closed or errored; safe to ignore.
    }
  }
}

// Clear all stored handler references for a server. Called once per server
// at the start of each onEffects cycle, before re-adding current handlers.
var _WebSocketServer_clearHandlers = function (server) {
  _WebSocketServer_ensureListenersAttached(server);
  server.__grenConnectionHandlers = [];
  server.__grenCloseHandlers = [];
};

var _WebSocketServer_setConnectionHandler = F3(function (server, router, handler) {
  _WebSocketServer_ensureListenersAttached(server);
  server.__grenConnectionHandlers.push({ router: router, handler: handler });
});

var _WebSocketServer_setCloseHandler = F3(function (server, router, handler) {
  _WebSocketServer_ensureListenersAttached(server);
  server.__grenCloseHandlers.push({ router: router, handler: handler });
});

var _WebSocketServer_getConnectionId = function (connection) {
  return connection.__$id;
};

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
