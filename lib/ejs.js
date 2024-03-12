/*
 * EJS Embedded JavaScript templates
 * Copyright 2112 Matthew Eernisse (mde@fleegix.org)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *         http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
*/

const fs = require('fs');
const path = require('path');
const utils = require('./utils.js');

const _DEFAULT_OPEN_DELIMITER = '<';
const _DEFAULT_CLOSE_DELIMITER = '>';
const _DEFAULT_DELIMITER = '%';
const _DEFAULT_LOCALS_NAME = 'locals';
const _REGEX_STRING = '(<%%|%%>|<%=|<%-|<%_|<%#|<%|%>|-%>|_%>)';
const _OPTS_PASSABLE_WITH_DATA = ['delimiter', 'scope', 'context', 'debug', 'compileDebug', 'client', '_with', 'rmWhitespace', 'strict', 'filename', 'async'];
const _BOM = /^\uFEFF/;
const _JS_IDENTIFIER = /^[a-zA-Z_$][0-9a-zA-Z_$]*$/;
const __cache = utils.cache;
const fileLoader = fs.readFileSync;

const resolveInclude = function(name, filename, isDir, type = 'ejs') {
  const dirname = path.dirname;
  const extname = path.extname;
  const resolve = path.resolve;
  let includePath = resolve(isDir ? filename : dirname(filename), name);
  const ext = extname(name);

  if (!ext) {
    includePath += '.' + type;
  }

  return includePath;
}

function resolvePaths(name, paths, type) {
  let filePath;
  const exists = paths.some(function (v) {
    filePath = resolveInclude(name, v, true, type);
    return fs.existsSync(filePath);
  });

  if (exists) {
    return filePath;
  }
}

function getIncludePath(path, options, type) {
  let includePath;
  let filePath;
  let views = options.views;
  const match = /^[A-Za-z]+:\\|^\//.exec(path);

  // Abs path
  if (match && match.length) {
    path = path.replace(/^\/*/, '');
    if (Array.isArray(options.root)) {
      includePath = resolvePaths(path, options.root);
    } else {
      includePath = resolveInclude(path, options.root || '/', true);
    }
  }
  // Relative paths
  else {
    // Look relative to a passed filename first
    if (options.filename) {
      filePath = resolveInclude(path, options.filename, false, type);
      if (fs.existsSync(filePath)) {
        includePath = filePath;
      }
    }
    // Then look in any views directories
    if (!includePath && Array.isArray(views)) {
      includePath = resolvePaths(path, views, type);
    }
    if (!includePath && typeof options.includer !== 'function') {
      throw new Error('Could not find the include file "' +
          options.escapeFunction(path) + '"');
    }
  }
  return includePath;
}

function handleCache(options, template) {
  let func;
  const filename = options.filename;
  const hasTemplate = arguments.length > 1;

  if (options.cache) {
    if (!filename) {
      throw new Error('cache option requires a filename');
    }
    func = __cache.get(filename);
    if (func) {
      return func;
    }
    if (!hasTemplate) {
      template = fileLoader(filename).toString().replace(_BOM, '');
    }
  } else if (!hasTemplate) {
    if (!filename) {
      throw new Error('Internal EJS error: no file name or template '
                    + 'provided');
    }
    template = fileLoader(filename).toString().replace(_BOM, '');
  }

  func = compile(template, options);

  if (options.cache) {
    __cache.set(filename, func);
  }

  return func;
}

function includeFile(path, options, type = 'ejs') {
  const opts = utils.shallowCopy(utils.createNullProtoObjWherePossible(), options);
  opts.filename = getIncludePath(path, opts, type);
  opts.type = type;

  if (typeof options.includer === 'function') {
    let includerResult = options.includer(path, opts.filename);

    if (includerResult) {
      if (includerResult.filename) {
        opts.filename = includerResult.filename;
      }

      if (includerResult.template) {
        return handleCache(opts, includerResult.template);
      }
    }
  }

  return handleCache(opts);
}

function rethrow(err, str, flnm, lineno, esc) {
  const lines = str.split('\n');
  const start = Math.max(lineno - 3, 0);
  const end = Math.min(lines.length, lineno + 3);
  const filename = esc(flnm);
  // Error context

  const context = lines.slice(start, end).map(function (line, i) {
    let curr = i + start + 1;

    return (curr === lineno ? ' >> ' : '    ')
      + curr
      + '| '
      + line;
  }).join('\n');

  // Alter exception message
  err.path = filename;
  err.message = (filename || 'ejs') + ':'
    + lineno + '\n'
    + context + '\n\n'
    + err.message;

  throw err;
}

function stripSemi(str){
  return str.replace(/;(\s*$)/, '$1');
}

const compile = function compile(template, opts) {
  if (opts.prefix) {
    template = opts.prefix + template;
  }

  const templ = new Template(template, opts);

  return templ.compile();
};

exports.renderAsync = function (template, d, opts) {
  const data = d || utils.createNullProtoObjWherePossible();

  if (arguments.length === 2) {
    utils.shallowCopyFromList(opts, data, _OPTS_PASSABLE_WITH_DATA);
  }

  return handleCache(opts, template)(data);
};

class Template {
  static get modes() {
    return {
      EVAL: 'eval',
      ESCAPED: 'escaped',
      RAW: 'raw',
      COMMENT: 'comment',
      LITERAL: 'literal'
    }
  }

  constructor(text, opts) {
    opts = opts || utils.createNullProtoObjWherePossible();
    const options = utils.createNullProtoObjWherePossible();

    this.templateText = text;
    this.mode = null;
    this.truncate = false;
    this.currentLine = 1;
    this.source = '';

    options.type = opts.type || 'ejs';
    options.client = opts.client || false;
    options.escapeFunction = opts.escape || opts.escapeFunction || utils.escapeXML;
    options.compileDebug = opts.compileDebug !== false;
    options.debug = !!opts.debug;
    options.filename = opts.filename;
    options.openDelimiter = opts.openDelimiter || _DEFAULT_OPEN_DELIMITER;
    options.closeDelimiter = opts.closeDelimiter || _DEFAULT_CLOSE_DELIMITER;
    options.delimiter = opts.delimiter || _DEFAULT_DELIMITER;
    options.strict = opts.strict || false;
    options.context = opts.context;
    options.cache = opts.cache || false;
    options.rmWhitespace = opts.rmWhitespace;
    options.root = opts.root;
    options.includer = opts.includer;
    options.outputFunctionName = opts.outputFunctionName;
    options.localsName = opts.localsName || _DEFAULT_LOCALS_NAME;
    options.views = opts.views;
    options.async = opts.async;
    options.files = opts.files;
    options.prefix = opts.prefix || '';
    options.destructuredLocals = opts.destructuredLocals;
    options.legacyInclude = typeof opts.legacyInclude != 'undefined' ? !!opts.legacyInclude : true;

    if (options.strict) {
      options._with = false;
    } else {
      options._with = typeof opts._with != 'undefined' ? opts._with : true;
    }

    this.opts = options;

    this.regex = this.createRegex();
  }

  createRegex() {
    let str = _REGEX_STRING;
    const delim = utils.escapeRegExpChars(this.opts.delimiter);
    const open = utils.escapeRegExpChars(this.opts.openDelimiter);
    const close = utils.escapeRegExpChars(this.opts.closeDelimiter);

    str = str.replace(/%/g, delim)
      .replace(/</g, open)
      .replace(/>/g, close);

    return new RegExp(str);
  }

  compile() {
    let src;
    let fn;
    const opts = this.opts;
    let prepended = '';
    let appended = '';
    const escapeFn = opts.escapeFunction;
    let ctor;
    const sanitizedFilename = opts.filename ? JSON.stringify(opts.filename) : 'undefined';

    if (!this.source) {
      this.generateSource();
      prepended +=
        '  let __output = "";\n' +
        '  const __promisedOutput = [];\n' +
        '  async function __append(s) {if (s !== undefined && s !== null) {__promisedOutput.push(s)}}\n';

      prepended += ' const components = {};\n'
      opts.files.forEach(file => {
        const type = file[2];
        let fnContent = ' const ' + file[0] + ' = function(...args) {return include("'+ file[1] +'", ...args'

        if (type) {
          fnContent += ", '" + type;
        }

        fnContent += "')};\n";

        prepended += fnContent;
      });

      if (opts.outputFunctionName) {
        if (!_JS_IDENTIFIER.test(opts.outputFunctionName)) {
          throw new Error('outputFunctionName is not a valid JS identifier.');
        }
        prepended += '  var ' + opts.outputFunctionName + ' = __append;' + '\n';
      }

      if (opts.localsName && !_JS_IDENTIFIER.test(opts.localsName)) {
        throw new Error('localsName is not a valid JS identifier.');
      }

      if (opts.destructuredLocals && opts.destructuredLocals.length) {
        let destructuring = '  var __locals = (' + opts.localsName + ' || {}),\n';

        for (let i = 0; i < opts.destructuredLocals.length; i++) {
          let name = opts.destructuredLocals[i];

          if (!_JS_IDENTIFIER.test(name)) {
            throw new Error('destructuredLocals[' + i + '] is not a valid JS identifier.');
          }

          if (i > 0) {
            destructuring += ',\n  ';
          }

          destructuring += name + ' = __locals.' + name;
        }

        prepended += destructuring + ';\n';
      }

      if (opts._with !== false) {
        prepended +=  'async function __asyncGlobal() { \n' +
          '  with (' + opts.localsName + ' || {}) {' + '\n';
        appended += '  }' + '\n';
        appended += '}' + '\n';
      }

      appended += `  return __asyncGlobal().then(_ => { 
        return Promise.all(__promisedOutput)}).then(function (values) {
        const data = values.reduce((acc, curr) => acc + curr, '');
        
        return data;
      }); ` + '\n';

      this.source = prepended + this.source + appended;
    }

    if (opts.compileDebug) {
      src = 'var __line = 1' + '\n'
        + '  , __lines = ' + JSON.stringify(this.templateText) + '\n'
        + '  , __filename = ' + sanitizedFilename + ';' + '\n'
        + 'try {' + '\n'
        + this.source
        + '} catch (e) {' + '\n'
        + '  rethrow(e, __lines, __filename, __line, escapeFn);' + '\n'
        + '}' + '\n';
    } else {
      src = this.source;
    }

    if (opts.client) {
      src = 'escapeFn = escapeFn || ' + escapeFn.toString() + ';' + '\n' + src;
      if (opts.compileDebug) {
        src = 'rethrow = rethrow || ' + rethrow.toString() + ';' + '\n' + src;
      }
    }

    if (opts.strict) {
      src = '"use strict";\n' + src;
    }

    if (opts.debug) {
      console.log(src);
    }

    if (opts.compileDebug && opts.filename) {
      src = src + '\n'
        + '//# sourceURL=' + sanitizedFilename + '\n';
    }

    try {
      if (opts.async) {
        // Have to use generated function for this, since in envs without support,
        // it breaks in parsing
        try {
          ctor = (new Function('return (async function(){}).constructor;'))();
        } catch(e) {
          if (e instanceof SyntaxError) {
            throw new Error('This environment does not support async/await');
          }

          throw e;
        }
      } else {
        ctor = Function;
      }
      fn = new ctor(opts.localsName + ', escapeFn, include, rethrow', src);
    } catch(e) {
      if (e instanceof SyntaxError && opts.filename) {
        e.message += ' in ' + opts.filename;
      }

      throw e;
    }

    let returnedFn = opts.client ? fn : function anonymous(data) {
      const include = function (path, includeData, type) {
        let d = utils.shallowCopy(utils.createNullProtoObjWherePossible(), data);
        if (includeData) {
          d = utils.shallowCopy(d, includeData);
        }

        const result = includeFile(path, opts, type)(d);

        return result;
      };

      return fn.apply(opts.context, [data || utils.createNullProtoObjWherePossible(), escapeFn, include, rethrow]);
    };

    if (opts.filename && typeof Object.defineProperty === 'function') {
      const filename = opts.filename;
      const basename = path.basename(filename, path.extname(filename));

      try {
        Object.defineProperty(returnedFn, 'name', {
          value: basename,
          writable: false,
          enumerable: false,
          configurable: true
        });
      } catch (e) {/* ignore */}
    }

    return returnedFn;
  }

  generateSource() {
    const opts = this.opts;

    if (opts.rmWhitespace) {
      // Have to use two separate replace here as `^` and `$` operators don't
      // work well with `\r` and empty lines don't work well with the `m` flag.
      this.templateText = this.templateText.replace(/[\r\n]+/g, '\n').replace(/^\s+|\s+$/gm, '');
    }

    // Slurp spaces and tabs before <%_ and after _%>
    this.templateText = this.templateText.replace(/[ \t]*<%_/gm, '<%_').replace(/_%>[ \t]*/gm, '_%>');

    const matches = this.parseTemplateText();
    const d = this.opts.delimiter;
    const o = this.opts.openDelimiter;
    const c = this.opts.closeDelimiter;

    if (matches && matches.length) {
      matches.forEach((line, index) => {
        let closing;
        if (line.indexOf(o + d) === 0        // If it is a tag
          && line.indexOf(o + d + d) !== 0) { // and is not escaped
          closing = matches[index + 2];
          if (!(closing === d + c || closing === '-' + d + c || closing === '_' + d + c)) {
            throw new Error('Could not find matching close tag for "' + line + '".');
          }
        }
        this.scanLine(line);
      });
    }
  }

  parseTemplateText() {
    let str = this.templateText;
    const pat = this.regex;
    let result = pat.exec(str);
    const arr = [];
    let firstPos;

    while (result) {
      firstPos = result.index;

      if (firstPos !== 0) {
        arr.push(str.substring(0, firstPos));
        str = str.slice(firstPos);
      }

      arr.push(result[0]);
      str = str.slice(result[0].length);
      result = pat.exec(str);
    }

    if (str) {
      arr.push(str);
    }

    return arr;
  }

  _addOutput(line) {
    if (this.truncate) {
      // Only replace single leading linebreak in the line after
      // -%> tag -- this is the single, trailing linebreak
      // after the tag that the truncation mode replaces
      // Handle Win / Unix / old Mac linebreaks -- do the \r\n
      // combo first in the regex-or
      line = line.replace(/^(?:\r\n|\r|\n)/, '');
      this.truncate = false;
    }

    if (!line) {
      return line;
    }

    // Preserve literal slashes
    line = line.replace(/\\/g, '\\\\');

    // Convert linebreaks
    line = line.replace(/\n/g, '\\n');
    line = line.replace(/\r/g, '\\r');

    // Escape double-quotes
    // - this will be the delimiter during execution
    line = line.replace(/"/g, '\\"');

    // const startTag = this.opts.type === 'jsx' ? '<script type=\'module\' src=\'/.pd-cache/_testStyle.jsx\'>' : '';
    // const endTag = this.opts.type === 'jsx' ? '</script>' : '';
    //
    // if (this.opts.type === 'jsx') {
    //   line = ''
    // }
    //
    // this.source += '    ; __append("' + startTag + line + endTag + '")\n';
    this.source += '    ; __append("'  + line + '")\n';
  }

  scanLine(line) {
    const d = this.opts.delimiter;
    const o = this.opts.openDelimiter;
    const c = this.opts.closeDelimiter;
    let newLineCount = (line.split('\n').length - 1);

    switch (line) {
      case o + d:
      case o + d + '_':
        this.mode = Template.modes.EVAL;
        break;

      case o + d + '=':
        this.mode = Template.modes.ESCAPED;
        break;

      case o + d + '-':
        this.mode = Template.modes.RAW;
        break;

      case o + d + '#':
        this.mode = Template.modes.COMMENT;
        break;

      case o + d + d:
        this.mode = Template.modes.LITERAL;
        this.source += '    ; __append("' + line.replace(o + d + d, o + d) + '")' + '\n';
        break;

      case d + d + c:
        this.mode = Template.modes.LITERAL;
        this.source += '    ; __append("' + line.replace(d + d + c, d + c) + '")' + '\n';
        break;

      case d + c:
      case '-' + d + c:
      case '_' + d + c:
        if (this.mode === Template.modes.LITERAL) {
          this._addOutput(line);
        }

        this.mode = null;
        this.truncate = line.indexOf('-') === 0 || line.indexOf('_') === 0;
        break;

      default:
        // In script mode, depends on type of tag
        if (this.mode) {
          // If '//' is found without a line break, add a line break.
          switch (this.mode) {
            case Template.modes.EVAL:
            case Template.modes.ESCAPED:
            case Template.modes.RAW:
              if (line.lastIndexOf('//') > line.lastIndexOf('\n')) {
                line += '\n';
              }
          }

          switch (this.mode) {
            // Just executing code
            case Template.modes.EVAL:
              this.source += '    ; ' + line + '\n';
              break;
            // Exec, esc, and output
            case Template.modes.ESCAPED:
              this.source += '    ; __append(escapeFn(' + stripSemi(line) + '))' + '\n';
              break;
            // Exec and output
            case Template.modes.RAW:
              this.source += '    ; __append(' + stripSemi(line) + ')' + '\n';
              break;
            case Template.modes.COMMENT:
              // Do nothing
              break;
            // Literal <%% mode, append as raw output
            case Template.modes.LITERAL:
              this._addOutput(line);
              break;
          }
        } else {
          this._addOutput(line);
        }
    }

    if (this.opts.compileDebug && newLineCount) {
      this.currentLine += newLineCount;
      this.source += '    ; __line = ' + this.currentLine + '\n';
    }
  }
}