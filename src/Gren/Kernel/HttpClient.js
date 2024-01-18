/*

import Gren.Kernel.Scheduler exposing (binding, succeed, fail)
import HttpClient exposing (Error)

*/

const http = require("http");

var _HttpClient_request = function (config) {
  console.log(config)
  return __Scheduler_binding(function (callback) {
    http.get(config.url, (res) => {
      if (res.statusCode !== 200) {
        return callback(
          __Scheduler_fail(__HttpClient_Error("bad status code"))
        );
      }

      res.setEncoding("utf8");

      let rawData = "";
      res.on("data", (chunk) => {
        rawData += chunk;
      });
      res.on("end", () => {
        return callback(__Scheduler_succeed(rawData));
      });
    });
  });
};
