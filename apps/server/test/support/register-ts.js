// Lets a plain `node` child process run the server straight from src/*.ts (transpile only, no type check),
// with the compiler options of the repository's tsconfig.
const { readFileSync } = require('fs');
const { dirname, join } = require('path');
const ts = require('typescript');

const configPath = join(__dirname, '../../tsconfig.json');
const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
const { options } = ts.parseJsonConfigFileContent(config, ts.sys, dirname(configPath));
const compilerOptions = { ...options, module: ts.ModuleKind.CommonJS, sourceMap: false, inlineSourceMap: true };

require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions, fileName: filename });
  module._compile(outputText, filename);
};
