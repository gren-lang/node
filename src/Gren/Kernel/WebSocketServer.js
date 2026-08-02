/*

import Gren.Kernel.Scheduler exposing (binding, succeed, fail, rawSpawn)
import WebSocketServer exposing (ServerError, TextMessage, BinaryMessage)
import WebSocketServer.Connection as WsConn exposing (Error)
import Platform exposing (sendToApp)

*/

var _WebSocketServer_createServer = F3(
  function (host, port, readBufferCapacity) {
    return __Scheduler_binding(function (callback) {
      var WebSocket = require("ws");
      var server = new WebSocket.Server({ host: host, port: port });
      server.__grenReadBufferCapacity = readBufferCapacity;

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
  },
);

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

    // Create a ReadableStream that surfaces incoming messages for this
    // connection. The controller is retained on the client so the per-event
    // closures below can enqueue messages and close/error the stream when the
    // connection ends. The stream is exposed to the app via
    // WebSocketServer.Connection.readable, and read using the Stream module.
    //
    // Backpressure: the stream uses a CountQueuingStrategy with a configurable
    // highWaterMark (readBufferCapacity). When the queue fills up, the socket
    // is paused so the remote peer stops sending. The pull callback resumes
    // the socket when the consumer drains the queue below the capacity.
    var bufferCapacity = server.__grenReadBufferCapacity;
    client.__grenStreamClosed = false;
    var messageStream = new ReadableStream(
      {
        start: function (controller) {
          client.__grenStreamController = controller;
        },
        pull: function () {
          if (client._socket) {
            client._socket.resume();
          }
        },
      },
      new CountQueuingStrategy({ highWaterMark: bufferCapacity }),
    );

    var connection = {
      __$id: connId,
      __$client: client,
      __$readable: messageStream,
    };

    // Store the Connection object on the client instance so that close/error
    // handlers can retrieve it without a separate lookup map.
    client.__grenConnection = connection;

    // Notify the app of the new connection, if any handlers are registered.
    var connHandlers = server.__grenConnectionHandlers;
    for (var i = 0; i < connHandlers.length; i++) {
      __Scheduler_rawSpawn(
        A2(
          __Platform_sendToApp,
          connHandlers[i].router,
          connHandlers[i].handler(connection),
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

      // If the readable buffer is full, pause the socket so the remote
      // peer stops sending. The pull callback above resumes it when the
      // consumer drains the queue.
      if (client.__grenStreamController.desiredSize <= 0) {
        if (client._socket) {
          client._socket.pause();
        }
      }
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
    });
  });
}

// Clear all stored handler references for a server. Called once per server
// at the start of each onEffects cycle, before re-adding current handlers.
var _WebSocketServer_clearHandlers = function (server) {
  _WebSocketServer_ensureListenersAttached(server);
  server.__grenConnectionHandlers = [];
  server.__grenCloseHandlers = [];
};

var _WebSocketServer_setConnectionHandler = F3(
  function (server, router, handler) {
    _WebSocketServer_ensureListenersAttached(server);
    server.__grenConnectionHandlers.push({ router: router, handler: handler });
  },
);

var _WebSocketServer_setCloseHandler = F3(function (server, router, handler) {
  _WebSocketServer_ensureListenersAttached(server);
  server.__grenCloseHandlers.push({ router: router, handler: handler });
});

var _WebSocketServer_getConnectionId = function (connection) {
  return connection.__$id;
};

var _WebSocketServer_getReadable = function (connection) {
  return connection.__$readable;
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
      var buffer = Buffer.from(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
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
