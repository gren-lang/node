/*

import Sqlite exposing (GenericError, ForeignKeyError, UniqueConstraintError, DecodingError, MultipleResultsError)
import Gren.Kernel.FilePath exposing (toString)
import Gren.Kernel.Scheduler exposing (binding, succeed, fail)
import Gren.Kernel.Json exposing (wrap, unwrap)
import Json.Decode as Decode exposing (decodeValue)
import Result exposing (isOk)
import Sqlite.Encode as SqliteEncode exposing (toJson)
import Sqlite.Encode.Row as SqliteEncodeRow exposing (toJson)
import Sqlite.Decode as SqliteDecode exposing (toJson)
import Sqlite.Aggregate as SqliteAggregate exposing (Entering, Exiting)
import Maybe exposing (Just, Nothing)

*/

var sqlite = require("node:sqlite");

var _Sqlite_openInMemory = function (opts) {
  return _Sqlite_openImpl(opts, ":memory:");
};

var _Sqlite_open = F2(function (opts, path) {
  return _Sqlite_openImpl(opts, _FilePath_toString(path));
});

var _Sqlite_openImpl = function (opts, path) {
  return __Scheduler_binding(function (callback) {
    try {
      callback(
        __Scheduler_succeed(
          new sqlite.DatabaseSync(path, {
            readOnly: opts.__$readOnly,
            enableForeignKeyConstraints: opts.__$enableForeignKeySConstraints,
            allowExtension: opts.__$allowExtension,
            timeout: opts.__$timeout > 0 ? opts.__$timeout : 0,
          }),
        ),
      );
    } catch (e) {
      callback(_Sqlite_constructError(e));
    }
  });
};

var _Sqlite_close = function (db) {
  return __Scheduler_binding(function (callback) {
    try {
      db.close();
      callback(__Scheduler_succeed({}));
    } catch (e) {
      callback(_Sqlite_constructError(e));
    }
  });
};

var _Sqlite_function = F3(function (name, func, db) {
  return __Scheduler_binding(function (callback) {
    try {
      const options = {
        deterministic: true,
        directOnly: true,
        useBigIntArguments: false,
        varargs: true,
      };
      const wrappedFunc = function (...args) {
        const jsonArgs = args.map((v) => __Json_wrap(v));
        const result = func(jsonArgs);
        if (__Result_isOk(result)) {
          // The triple `.a` gets the OK result, the SQLite encode
          // value, and then grabs the actual value that needs to
          // be returned
          return result.a.a.a;
        } else {
          return null;
        }
      };
      db.function(name, options, wrappedFunc);
      callback(__Scheduler_succeed({}));
    } catch (e) {
      callback(_Sqlite_constructError(e));
    }
  });
});

var _Sqlite_aggregate = F5(function (name, init, func, result, db) {
  return __Scheduler_binding(function (callback) {
    try {
      const wrappedFunc = function (direction) {
        var env = __SqliteAggregate_Entering;
        if (direction == "inverse") {
          env = __SqliteAggregate_Exiting;
        }
        return function (state, ...args) {
          const jsonArgs = args.map((v) => __Json_wrap(v));
          const result = A3(func, env, state, jsonArgs);
          if (__Result_isOk(result)) {
            return result.a;
          } else {
            return null;
          }
        };
      };
      const options = {
        deterministic: true,
        directOnly: true,
        useBigIntArguments: false,
        varargs: true,
        start: () => {
          return init;
        },
        step: wrappedFunc("step"),
        result: (state) => {
          return result(state).a.a;
        },
        inverse: wrappedFunc("inverse"),
      };
      db.aggregate(name, options);
      callback(__Scheduler_succeed({}));
    } catch (e) {
      callback(_Sqlite_constructError(e));
    }
  });
});

var _Sqlite_backup = F3(function (destination, pages, db) {
  return __Scheduler_binding(function (callback) {
    try {
      sqlite
        .backup(db, _FilePath_toString(destination), {
          source: "main",
          target: "main",
          rate: pages,
        })
        .then(function (res) {
          callback(__Scheduler_succeed({}));
        })
        .catch(function (e) {
          callback(_Sqlite_constructError(e));
        });
    } catch (e) {
      callback(_Sqlite_constructError(e));
    }
  });
});

var _Sqlite_foldl = F4(function (query, db, func, acc) {
  return __Scheduler_binding(function (callback) {
    try {
      var acc_ = acc;
      const prepped = db.prepare(query.__$query);
      const params = __Json_unwrap(
        __SqliteEncodeRow_toJson(query.__$parameters),
      );
      const rowDecoder = __SqliteDecode_toJson(query.__$rowDecoder);

      for (const value of prepped.iterate(params)) {
        const jsonResult = A2(
          __Decode_decodeValue,
          rowDecoder,
          _Json_wrap(value),
        );

        if (__Result_isOk(jsonResult)) {
          acc_ = A2(func, jsonResult.a, acc_);
        } else {
          return callback(
            __Scheduler_fail(__Sqlite_DecodingError(jsonResult.a)),
          );
        }
      }
      callback(__Scheduler_succeed(acc_));
    } catch (e) {
      callback(_Sqlite_constructError(e));
    }
  });
});

var _Sqlite_getMaybeOne = F2(function (query, db) {
  return __Scheduler_binding(function (callback) {
    try {
      const prepped = db.prepare(query.__$query);
      const params = __Json_unwrap(
        __SqliteEncodeRow_toJson(query.__$parameters),
      );
      const rowDecoder = __SqliteDecode_toJson(query.__$rowDecoder);
      const iterator = prepped.iterate(params);

      const value = iterator.next().value;

      if (!value) {
        return callback(__Scheduler_succeed(__Maybe_Nothing));
      }

      if (!iterator.next().done) {
        var count = 2;
        for (const value of iterator) {
          count++;
        }
        return callback(__Scheduler_fail(__Sqlite_MultipleResultsError(count)));
      }

      const result = A2(__Decode_decodeValue, rowDecoder, _Json_wrap(value));

      if (__Result_isOk(result)) {
        callback(__Scheduler_succeed(__Maybe_Just(result.a)));
      } else {
        return callback(__Scheduler_fail(__Sqlite_DecodingError(result.a)));
      }
    } catch (e) {
      callback(_Sqlite_constructError(e));
    }
  });
});

var _Sqlite_executeMany = F3(function (statement, values, db) {
  return __Scheduler_binding(function (callback) {
    try {
      const prepped = db.prepare(statement.__$statement);
      let lastResult;

      if (values.length === 0) {
        lastResult = prepped.run();
      } else {
        for (const val of values) {
          lastResult = prepped.run(
            __Json_unwrap(
              __SqliteEncodeRow_toJson(statement.__$parameters(val)),
            ),
          );
        }
      }

      const result = {
        __$changes: lastResult.changes,
        __$lastInsertRowid: lastResult.lastInsertRowid,
      };

      callback(__Scheduler_succeed(result));
    } catch (e) {
      callback(_Sqlite_constructError(e));
    }
  });
});

var _Sqlite_executeScript = F2(function (script, db) {
  return __Scheduler_binding(function (callback) {
    try {
      db.exec(script);
      callback(__Scheduler_succeed(db));
    } catch (e) {
      callback(_Sqlite_constructError(e));
    }
  });
});

var _Sqlite_constructError = function (e) {
  if (e.errcode === 787) {
    return __Scheduler_fail(__Sqlite_ForeignKeyError(e.message));
  }

  if (e.errcode === 2067) {
    return __Scheduler_fail(__Sqlite_UniqueConstraintError(e.message));
  }

  return __Scheduler_fail(__Sqlite_GenericError(e.message));
};
