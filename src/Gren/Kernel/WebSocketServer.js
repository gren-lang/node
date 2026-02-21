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
  server.__grenMessageHandlers = [];
  server.__grenCloseHandlers = [];
  server.__grenErrorHandlers = [];

  server.on("connection", function (client) {
    var connId = _WebSocketServer_nextConnectionId++;
    var connection = { __$id: connId, __$client: client };

    // Store the Connection object on the client instance so that message/close/error
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

    // Attach per-client handlers that delegate to the current stored handlers.
    // Each handler reads the current reference from server on every event fire,
    // so re-evaluating subscriptions updates behavior for existing connections.
    client.on("message", function (data, isBinary) {
      var handlers = server.__grenMessageHandlers;
      if (handlers.length === 0) return;

      var msg = isBinary
        ? __WebSocketServer_BinaryMessage(
            new DataView(data.buffer, data.byteOffset, data.byteLength),
          )
        : __WebSocketServer_TextMessage(data.toString());

      for (var i = 0; i < handlers.length; i++) {
        __Scheduler_rawSpawn(
          A2(
            __Platform_sendToApp,
            handlers[i].router,
            A2(handlers[i].handler, client.__grenConnection, msg),
          ),
        );
      }
    });

    client.on("close", function (code, reason) {
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
      var handlers = server.__grenErrorHandlers;
      for (var i = 0; i < handlers.length; i++) {
        __Scheduler_rawSpawn(
          A2(
            __Platform_sendToApp,
            handlers[i].router,
            A2(handlers[i].handler, client.__grenConnection, err.message),
          ),
        );
      }
    });
  });
}

// Clear all stored handler references for a server. Called once per server
// at the start of each onEffects cycle, before re-adding current handlers.
var _WebSocketServer_clearHandlers = function (server) {
  _WebSocketServer_ensureListenersAttached(server);
  server.__grenConnectionHandlers = [];
  server.__grenMessageHandlers = [];
  server.__grenCloseHandlers = [];
  server.__grenErrorHandlers = [];
};

var _WebSocketServer_setConnectionHandler = F3(function (server, router, handler) {
  _WebSocketServer_ensureListenersAttached(server);
  server.__grenConnectionHandlers.push({ router: router, handler: handler });
});

var _WebSocketServer_setMessageHandler = F3(function (server, router, handler) {
  _WebSocketServer_ensureListenersAttached(server);
  server.__grenMessageHandlers.push({ router: router, handler: handler });
});

var _WebSocketServer_setCloseHandler = F3(function (server, router, handler) {
  _WebSocketServer_ensureListenersAttached(server);
  server.__grenCloseHandlers.push({ router: router, handler: handler });
});

var _WebSocketServer_setErrorHandler = F3(function (server, router, handler) {
  _WebSocketServer_ensureListenersAttached(server);
  server.__grenErrorHandlers.push({ router: router, handler: handler });
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
