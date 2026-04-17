/*

import Sqlite exposing (GenericError, DecodingError)
import Gren.Kernel.FilePath exposing (toString)
import Gren.Kernel.Scheduler exposing (binding, succeed, fail)
import Gren.Kernel.Json exposing (wrap, unwrap)
import Json.Decode as Decode exposing (decodeValue)
import Result exposing (isOk)

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

var _Sqlite_getAll = F2(function (query, db) {
  return __Scheduler_binding(function (callback) {
    try {
      const results = [];
      const prepped = db.prepare(query.__$query);

      for (const value of prepped.iterate(__Json_unwrap(query.__$parameters))) {
        const jsonResult = A2(
          __Decode_decodeValue,
          query.__$rowDecoder,
          _Json_wrap(value),
        );

        if (__Result_isOk(jsonResult)) {
          results.push(jsonResult.a);
        } else {
          return callback(
            __Scheduler_fail(__Sqlite_DecodingError(jsonResult.a)),
          );
        }
      }

      callback(__Scheduler_succeed(results));
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
          lastResult = prepped.run(__Json_unwrap(statement.__$encoder(val)));
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
  // log to console while we're figuring things out
  console.error(e);
  return __Scheduler_fail(
    __Sqlite_GenericError(e.message),
  );
};
