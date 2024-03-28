/*
 */

const path = require("node:path");

var _FilePath_fromPosix = function (str) {
  return _FilePath_parse(path.posix, str);
};

var _FilePath_fromWin32 = function (str) {
  return _FilePath_parse(path.win32, str);
};

var _FilePath_parse = function (pathMod, str) {
  const result = pathMod.parse(str);

  const root = result.root;
  const dirStr = result.dir.startsWith(root)
    ? result.dir.substring(root.length)
    : result.dir;

  return {
    __$directory: dirStr.split(pathMod.sep),
    __$extension: result.ext.length > 0 ? result.ext.substring(1) : "",
    __$filename: result.name,
    __$root: result.root,
  };
};
