/*

import Gren.Kernel.Scheduler exposing (binding, succeed, fail, rawSpawn)
import WebSocketClient exposing (ConnectError, TextMessage, BinaryMessage)
import WebSocketClient.Connection as WsConn exposing (Error)
import Platform exposing (sendToApp)

*/

var _WebSocketClient_nextConnectionId = 0;

var _WebSocketClient_connect = F2(function (url, readBufferCapacity) {
  return __Scheduler_binding(function (callback) {
    var WebSocket = require("ws");
    var client = new WebSocket(url);

    var opened = false;
    var called = false;

    function safeCallback(val) {
      if (!called) {
        called = true;
        callback(val);
      }
    }

    client.__grenStreamClosed = false;

    // Readable stream for incoming messages. The controller is retained on
    // the client so event closures can enqueue messages and close/error the
    // stream when the connection ends. Read using the Stream module.
    //
    // Backpressure: the stream uses a CountQueuingStrategy with a configurable
    // highWaterMark (readBufferCapacity). When the queue fills up, the socket
    // is paused so the remote peer stops sending. The pull callback resumes
    // the socket when the consumer drains the queue below the capacity.
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
      new CountQueuingStrategy({ highWaterMark: readBufferCapacity }),
    );

    // Writable stream for outgoing messages. Writing a Message value to this
    // stream sends it over the WebSocket. Backpressure is respected: a write
    // resolves only once ws.send's callback fires.
    var sendStream = new WritableStream({
      start: function (controller) {
        client.__grenWritableController = controller;
      },
      write: function (chunk) {
        return new Promise(function (resolve, reject) {
          try {
            if (typeof chunk.a === "string") {
              client.send(chunk.a, function (err) {
                if (err) {
                  reject(err);
                } else {
                  resolve();
                }
              });
            } else {
              var bytes = chunk.a;
              var buf = Buffer.from(
                bytes.buffer,
                bytes.byteOffset,
                bytes.byteLength,
              );
              client.send(buf, function (err) {
                if (err) {
                  reject(err);
                } else {
                  resolve();
                }
              });
            }
          } catch (e) {
            reject(e);
          }
        });
      },
    });

    var connection = {
      __$id: _WebSocketClient_nextConnectionId++,
      __$client: client,
      __$readable: messageStream,
      __$writable: sendStream,
      __grenCloseHandlers: [],
    };

    client.on("open", function () {
      opened = true;
      safeCallback(__Scheduler_succeed(connection));
    });

    client.on("message", function (data, isBinary) {
      if (client.__grenStreamClosed) return;

      var msg = isBinary
        ? __WebSocketClient_BinaryMessage(
            new DataView(data.buffer, data.byteOffset, data.byteLength),
          )
        : __WebSocketClient_TextMessage(data.toString());

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
      // Close/error the streams so active readers/writers observe the end.
      if (!client.__grenStreamClosed) {
        client.__grenStreamClosed = true;
        try {
          client.__grenStreamController.close();
        } catch (e) {
          // Controller may already be closed or errored; safe to ignore.
        }
        try {
          client.__grenWritableController.error("WebSocket connection closed");
        } catch (e) {
          // Controller may already be closed or errored; safe to ignore.
        }
      }

      var handlers = connection.__grenCloseHandlers;
      for (var i = 0; i < handlers.length; i++) {
        __Scheduler_rawSpawn(
          A2(
            __Platform_sendToApp,
            handlers[i].router,
            handlers[i].handler({
              __$code: code,
              __$reason: reason.toString(),
            }),
          ),
        );
      }
    });

    client.on("error", function (err) {
      if (!opened) {
        // Connection attempt failed.
        safeCallback(
          __Scheduler_fail(
            __WebSocketClient_ConnectError({
              __$code: err.code || "",
              __$message: err.message || "",
            }),
          ),
        );
      } else {
        // Connection errored after opening. Error the streams so active
        // readers/writers stop. The subsequent "close" event will notify
        // onClose handlers.
        if (!client.__grenStreamClosed) {
          client.__grenStreamClosed = true;
          try {
            client.__grenStreamController.error(err.message);
          } catch (e) {
            // Controller may already be closed or errored; safe to ignore.
          }
          try {
            client.__grenWritableController.error(err.message);
          } catch (e) {
            // Controller may already be closed or errored; safe to ignore.
          }
        }
      }
    });
  });
});

// HANDLER MANAGEMENT

var _WebSocketClient_clearHandlers = function (connection) {
  connection.__grenCloseHandlers = [];
};

var _WebSocketClient_setCloseHandler = F3(
  function (connection, router, handler) {
    connection.__grenCloseHandlers.push({ router: router, handler: handler });
  },
);

// ACCESSORS

var _WebSocketClient_getConnectionId = function (connection) {
  return connection.__$id;
};

var _WebSocketClient_getReadable = function (connection) {
  return connection.__$readable;
};

var _WebSocketClient_getWritable = function (connection) {
  return connection.__$writable;
};

// CLOSING

function _WebSocketClient_constructError(err) {
  return __WsConn_Error({
    __$code: err.code || "",
    __$message: err.message || "",
  });
}

var _WebSocketClient_close = F3(function (connection, code, reason) {
  return __Scheduler_binding(function (callback) {
    try {
      connection.__$client.close(code, reason);
      callback(__Scheduler_succeed({}));
    } catch (e) {
      callback(__Scheduler_fail(_WebSocketClient_constructError(e)));
    }
  });
});
