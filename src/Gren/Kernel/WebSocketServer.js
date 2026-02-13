/*

import Gren.Kernel.Scheduler exposing (binding, succeed, fail, rawSpawn)
import WebSocketServer exposing (ServerError, TextMessage, BinaryMessage)
import WebSocketServer.Connection as WsConn exposing (Error)
import Platform exposing (sendToApp)

*/

var _WebSocketServer_createServer = F2(function (host, port) {
  return __Scheduler_binding(function (callback) {
    var WebSocket = require("ws");
    var wss = new WebSocket.Server({ host: host, port: port });

    wss.on("error", function (e) {
      callback(
        __Scheduler_fail(
          __WebSocketServer_ServerError({
            __$code: e.code || "UNKNOWN",
            __$message: e.message,
          }),
        ),
      );
    });

    wss.on("listening", function () {
      callback(__Scheduler_succeed(wss));
    });
  });
});

var _WebSocketServer_nextConnectionId = 0;

// Initialize the handler storage on a wss object and attach the wss-level
// "connection" listener exactly once. Per-ws handlers delegate to the current
// handler references stored on the wss object, so when onEffects updates the
// handlers, existing long-lived connections automatically use the new handlers.
function _WebSocketServer_ensureListenersAttached(wss) {
  if (wss.__grenListenersAttached) {
    return;
  }
  wss.__grenListenersAttached = true;
  wss.__grenConnectionHandlers = [];
  wss.__grenMessageHandlers = [];
  wss.__grenCloseHandlers = [];
  wss.__grenErrorHandlers = [];

  wss.on("connection", function (ws) {
    var connId = _WebSocketServer_nextConnectionId++;
    var connection = { __$id: connId, __$ws: ws };

    // Store the Connection object on the ws instance so that message/close/error
    // handlers can retrieve it without a separate lookup map.
    ws.__grenConnection = connection;

    // Notify the app of the new connection, if any handlers are registered.
    var connHandlers = wss.__grenConnectionHandlers;
    for (var i = 0; i < connHandlers.length; i++) {
      __Scheduler_rawSpawn(
        A2(
          __Platform_sendToApp,
          connHandlers[i].router,
          connHandlers[i].handler(connection),
        ),
      );
    }

    // Attach per-ws handlers that delegate to the current stored handlers.
    // Each handler reads the current reference from wss on every event fire,
    // so re-evaluating subscriptions updates behavior for existing connections.
    ws.on("message", function (data, isBinary) {
      var handlers = wss.__grenMessageHandlers;
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
            A2(handlers[i].handler, ws.__grenConnection, msg),
          ),
        );
      }
    });

    ws.on("close", function (code, reason) {
      var handlers = wss.__grenCloseHandlers;
      for (var i = 0; i < handlers.length; i++) {
        __Scheduler_rawSpawn(
          A2(
            __Platform_sendToApp,
            handlers[i].router,
            A2(handlers[i].handler, ws.__grenConnection, {
              __$code: code,
              __$reason: reason.toString(),
            }),
          ),
        );
      }
    });

    ws.on("error", function (err) {
      var handlers = wss.__grenErrorHandlers;
      for (var i = 0; i < handlers.length; i++) {
        __Scheduler_rawSpawn(
          A2(
            __Platform_sendToApp,
            handlers[i].router,
            A2(handlers[i].handler, ws.__grenConnection, err.message),
          ),
        );
      }
    });
  });
}

// Clear all stored handler references for a server. Called once per server
// at the start of each onEffects cycle, before re-adding current handlers.
var _WebSocketServer_clearHandlers = function (wss) {
  _WebSocketServer_ensureListenersAttached(wss);
  wss.__grenConnectionHandlers = [];
  wss.__grenMessageHandlers = [];
  wss.__grenCloseHandlers = [];
  wss.__grenErrorHandlers = [];
};

var _WebSocketServer_setConnectionHandler = F3(function (wss, router, handler) {
  _WebSocketServer_ensureListenersAttached(wss);
  wss.__grenConnectionHandlers.push({ router: router, handler: handler });
});

var _WebSocketServer_setMessageHandler = F3(function (wss, router, handler) {
  _WebSocketServer_ensureListenersAttached(wss);
  wss.__grenMessageHandlers.push({ router: router, handler: handler });
});

var _WebSocketServer_setCloseHandler = F3(function (wss, router, handler) {
  _WebSocketServer_ensureListenersAttached(wss);
  wss.__grenCloseHandlers.push({ router: router, handler: handler });
});

var _WebSocketServer_setErrorHandler = F3(function (wss, router, handler) {
  _WebSocketServer_ensureListenersAttached(wss);
  wss.__grenErrorHandlers.push({ router: router, handler: handler });
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
      connection.__$ws.send(data, function (err) {
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
      connection.__$ws.send(buffer, function (err) {
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
      connection.__$ws.close(code, reason);
      callback(__Scheduler_succeed({}));
    } catch (e) {
      callback(__Scheduler_fail(_WebSocketServer_constructError(e)));
    }
  });
});
